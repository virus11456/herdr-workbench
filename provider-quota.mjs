import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile,spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const accountRefreshMs=5*60_000;

const statusSources={
 claude:'.claude/settings.json',
 antigravity:'.gemini/antigravity-cli/settings.json'
};
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const percent=value=>Number.isFinite(value)&&value>=0&&value<=100;
const validBucket=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(value);

function statusPreference(provider,userHome){
 try{return JSON.parse(fs.readFileSync(path.join(userHome,statusSources[provider]),'utf8'))?.statusLine;}catch{return undefined;}
}

export function quotaStatusSettings(provider,home,node,userHome=os.homedir()){
 const current=statusPreference(provider,userHome);
 if(current?.enabled===false)return {};
 // Reuse the user's display command, if configured, after saving the quota.
 const command=[node,path.join(home,'provider-quota.mjs'),provider,home].map(quote).join(' ');
 return {statusLine:{...current,type:'command',command}};
}

function activeWindows(windows,now){
 return windows.filter(w=>(validBucket(w?.bucket)||Number.isSafeInteger(w?.windowMinutes)&&w.windowMinutes>0)
  &&percent(w.remainingPercent)&&Number.isSafeInteger(w.resetsAt)&&w.resetsAt*1000>now);
}

export function quotaFromStatus(provider,payload,now=Date.now()){
 let windows=[];
 if(provider==='claude'){
  windows=[['five_hour',300],['seven_day',10080]].flatMap(([key,windowMinutes])=>{
   const entry=payload?.rate_limits?.[key];
   return percent(entry?.used_percentage)?[{windowMinutes,remainingPercent:100-entry.used_percentage,resetsAt:entry.resets_at}]:[];
  });
 }else if(provider==='antigravity'&&payload?.product==='antigravity'){
  windows=Object.entries(payload.quota||{}).slice(0,32).flatMap(([bucket,entry])=>{
   if(entry?.disabled===true||!validBucket(bucket)||!Number.isFinite(entry?.remaining_fraction))return [];
   return [{bucket,remainingPercent:entry.remaining_fraction*100,resetsAt:Math.floor(Date.parse(entry.reset_time)/1000)}];
  });
 }
 if(provider==='minimax'&&payload?.base_resp?.status_code===0&&Array.isArray(payload.model_remains)){
  const fields=[
   ['start_time','end_time','current_interval_remaining_percent'],
   ['weekly_start_time','weekly_end_time','current_weekly_remaining_percent']
  ];
  windows=payload.model_remains.slice(0,16).flatMap(entry=>{
   if(!validBucket(entry?.model_name))return [];
   return fields.flatMap(([startKey,endKey,percentKey])=>{
    const start=entry[startKey],end=entry[endKey];
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<=0||start>now)return [];
    return [{bucket:entry.model_name,windowMinutes:Math.round((end-start)/60_000),
     remainingPercent:entry[percentKey],resetsAt:Math.floor(end/1000)}];
   }).filter(w=>w.windowMinutes>0);
  });
 }
 if(provider==='codex'){
  const grouped=payload?.rateLimitsByLimitId;
  const sources=grouped&&typeof grouped==='object'?Object.values(grouped).slice(0,16):[];
  if(!sources.some(entry=>entry?.limitId===payload?.rateLimits?.limitId))sources.unshift(payload?.rateLimits);
  windows=sources.flatMap(entry=>{
   if(!validBucket(entry?.limitId))return [];
   const bucket=entry.limitId==='codex'?undefined:entry.limitId;
   return [entry.primary,entry.secondary].flatMap(w=>{
    if(!percent(w?.usedPercent)||!Number.isSafeInteger(w.windowDurationMins)||w.windowDurationMins<=0)return [];
    return [{bucket,windowMinutes:w.windowDurationMins,remainingPercent:100-w.usedPercent,resetsAt:w.resetsAt}];
   });
  });
 }
 windows=activeWindows(windows,now);
 return windows.length?{observedAt:new Date(now).toISOString(),windows}:null;
}

export function saveQuota(home,provider,payload,now=Date.now()){
 const sample=quotaFromStatus(provider,payload,now);
 if(!sample)return null;
 const dir=path.join(home,'provider-quota'),dest=path.join(dir,provider+'.json');
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const temp=path.join(dir,randomUUID()+'.tmp');
 try{
  fs.writeFileSync(temp,JSON.stringify(sample),{mode:0o600,flag:'wx'});
  fs.renameSync(temp,dest);
 }finally{fs.rmSync(temp,{force:true});}
 return sample;
}

// Share one rate-limited lookup per provider across authenticated clients.
function accountQuotaRefresher(home,provider,read,clock){
 let nextRefresh=0,inFlight;
 return ()=>{
  if(inFlight)return inFlight;
  const now=clock();
  if(now<nextRefresh)return;
  nextRefresh=now+accountRefreshMs;
  inFlight=(async()=>{
   try{
    const payload=await read();
    saveQuota(home,provider,payload,clock());
   }catch{
    // CLI failures may contain local paths or account details.
   }
  })().finally(()=>{inFlight=undefined;});
  return inFlight;
 };
}

const localCliEnv=()=>({HOME:os.homedir(),PATH:process.env.PATH});

export function miniMaxQuotaRefresher(home,cli,run=exec,clock=Date.now){
 if(!cli)return ()=>{};
 return accountQuotaRefresher(home,'minimax',async()=>{
  const {stdout}=await run(cli,['quota','show','--output','json'],{
   cwd:home,env:localCliEnv(),timeout:8_000,maxBuffer:128*1024
  });
  return JSON.parse(stdout);
 },clock);
}

export function codexAccountLimits(cli,home,launch=spawn){
 return new Promise((resolve,reject)=>{
  const child=launch(cli,['app-server','--listen','stdio://'],{cwd:home,env:localCliEnv(),stdio:['pipe','pipe','ignore']});
  let buffer='',initialized=false,settled=false,receivedBytes=0;
  const timeout=setTimeout(()=>finish(new Error('Codex quota request timed out')),8_000);
  function finish(error,result){
   if(settled)return;
   settled=true;
   clearTimeout(timeout);
   child.stdin.end();
   child.kill(error?'SIGKILL':'SIGTERM');
   if(error)reject(error);
   else resolve(result);
  }
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  child.on('error',finish);
  child.on('exit',()=>finish(new Error('Codex app server exited')));
  child.stdin.on('error',finish);
  child.stdout.on('error',finish);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
   if(settled)return;
   receivedBytes+=Buffer.byteLength(chunk);
   if(receivedBytes>256*1024){finish(new Error('Codex quota response exceeded the size limit'));return;}
   const lines=(buffer+chunk).split('\n');
   buffer=lines.pop();
   for(const line of lines){
    if(settled)return;
    let message;
    try{message=JSON.parse(line);}catch{continue;}
    if(!initialized&&message?.id===0){
     if(!message.result){finish(new Error('Codex app server rejected initialization'));return;}
     initialized=true;
     send({method:'initialized'});
     send({id:1,method:'account/rateLimits/read'});
    }else if(initialized&&message?.id===1){
     if(!message.result){finish(new Error('Codex quota is unavailable'));return;}
     finish(null,message.result);
    }
   }
  });
  send({id:0,method:'initialize',params:{clientInfo:{name:'herdr_workbench',title:'Herdr Workbench',version:'1'}}});
 });
}

export function codexQuotaRefresher(home,cli,read=codexAccountLimits,clock=Date.now){
 return cli?accountQuotaRefresher(home,'codex',()=>read(cli,home),clock):()=>{};
}

export function readQuotas(home,now=Date.now()){
 return [...Object.keys(statusSources),'codex','minimax'].flatMap(provider=>{
  try{
   const data=JSON.parse(fs.readFileSync(path.join(home,'provider-quota',provider+'.json'),'utf8'));
   const observed=Date.parse(data?.observedAt);
   if(!Number.isFinite(observed)||observed>now||!Array.isArray(data.windows))return [];
   if((provider==='codex'||provider==='minimax')&&now-observed>=3*accountRefreshMs)return [];
   const windows=activeWindows(data.windows.slice(0,32),now).map(({bucket,windowMinutes,remainingPercent,resetsAt})=>({bucket,windowMinutes,remainingPercent,resetsAt}));
   return windows.length?[{provider,observedAt:data.observedAt,windows}]:[];
  }catch{return [];}
 });
}

function statusLine(provider,home){
 if(!Object.hasOwn(statusSources,provider)||!path.isAbsolute(home||''))return;
 const input=fs.readFileSync(0);
 let payload;
 try{payload=JSON.parse(input);}catch{}
 const current=statusPreference(provider,os.homedir());
 if(current?.enabled===false)return;
 try{saveQuota(home,provider,payload);}catch{}
 if(current?.type==='command'&&typeof current.command==='string'&&!current.command.includes('provider-quota.mjs')){
  const result=spawnSync('/bin/sh',['-c',current.command],{input,timeout:2500,maxBuffer:65536});
  if(result.status===0)process.stdout.write(result.stdout);
 }else if(provider==='antigravity'&&typeof payload?.model?.display_name==='string'){
  process.stdout.write(payload.model.display_name.replace(/[\p{Cc}]/gu,'')+'\n');
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)statusLine(process.argv[2],process.argv[3]);
