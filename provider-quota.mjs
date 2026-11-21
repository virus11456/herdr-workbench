import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

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

export function readQuotas(home,now=Date.now()){
 return Object.keys(statusSources).flatMap(provider=>{
  try{
   const data=JSON.parse(fs.readFileSync(path.join(home,'provider-quota',provider+'.json'),'utf8'));
   const observed=Date.parse(data?.observedAt);
   if(!Number.isFinite(observed)||observed>now||!Array.isArray(data.windows))return [];
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
