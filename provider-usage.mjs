import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const identifier=/^[a-zA-Z0-9_-]{1,128}$/;
const count=n=>Number.isSafeInteger(n)&&n>=0;
const real=p=>fs.realpathSync(p);
const matchesDirectory=(p,cwd)=>typeof p==='string'&&real(p)===cwd;
const optional=['cacheRead','cacheWrite'];

function tokens(input,output,cacheRead,cacheWrite){
 if(!count(input)||!count(output))return null;
 return {input,output,...(count(cacheRead)?{cacheRead}:{}),...(count(cacheWrite)?{cacheWrite}:{})};
}
function sum(samples){
 if(!samples.length||samples.some(x=>!x))return null;
 const combined={};
 for(const name of ['input','output',...optional])if(samples.every(x=>count(x[name])))combined[name]=samples.reduce((total,x)=>total+x[name],0);
 return count(combined.input)&&count(combined.output)?combined:null;
}

// Provider transcripts are read by their exact identity. Never copy their contents to Workbench.
function providerFile(root,filename,maxBytes=32*1024*1024){
 const canonical=real(filename);
 if(!canonical.startsWith(root+path.sep)||canonical!==filename)return null;
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.size>maxBytes)return null;
  const data=Buffer.alloc(stat.size);
  if(fs.readSync(fd,data,0,data.length,0)!==data.length)return null;
  return data.toString('utf8').trim();
 }finally{fs.closeSync(fd);}
}
const rowsAt=(root,filename)=>providerFile(root,filename)?.split('\n').map(line=>JSON.parse(line));
function dateDirectories(root){
 const folders=(parent,pattern)=>fs.readdirSync(parent,{withFileTypes:true}).filter(e=>e.isDirectory()&&pattern.test(e.name)).map(e=>path.join(parent,e.name));
 return folders(root,/^\d{4}$/).flatMap(y=>folders(y,/^(?:0[1-9]|1[0-2])$/)).flatMap(m=>folders(m,/^(?:0[1-9]|[12][0-9]|3[01])$/));
}
function unique(rows){return rows.length===1?rows[0]:null;}
function nonempty(values){return values&&Object.values(values).some(n=>n>0)?values:null;}

export function claudeTurnUsage(event,cwd,configDir=process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude')){
 const id=event.session_id,filename=event.transcript_path;
 if(!uuid.test(id||'')||typeof filename!=='string'||path.basename(filename)!==id+'.jsonl')return null;
 const root=real(path.join(configDir,'projects'));
 const rows=rowsAt(root,filename);
 if(!rows)return null;
 const session=rows.filter(x=>!x.isSidechain&&x.sessionId===id&&matchesDirectory(x.cwd,cwd));
 const user=session.findLastIndex(x=>x.type==='user'&&!x.isMeta&&x.message?.role==='user'&&(
  typeof x.message.content==='string'||Array.isArray(x.message.content)&&x.message.content.some(b=>b.type==='text')&&!x.message.content.some(b=>b.type==='tool_result')
 ));
 if(user<0||!uuid.test(session[user].uuid||''))return null;
 const responses=session.slice(user+1).filter(x=>x.type==='assistant'&&x.message?.role==='assistant');
 const last=responses.at(-1);
 const finalText=last?.message.content?.filter?.(x=>x.type==='text')?.map(x=>x.text).join('\n').trim();
 if(!finalText||finalText!==event.last_assistant_message?.trim()||last.isApiErrorMessage)return null;
 const uniqueResponses=new Map();
 for(const row of responses){
  if(row.isApiErrorMessage||row.message.model==='<synthetic>')continue;
  if(typeof row.message.id!=='string'||!row.message.id.trim())return null;
  const u=row.message.usage;
  uniqueResponses.set(row.message.id,tokens(u?.input_tokens,u?.output_tokens,u?.cache_read_input_tokens,u?.cache_creation_input_tokens));
 }
 return {identity:id+'/'+session[user].uuid,tokens:nonempty(sum([...uniqueResponses.values()]))};
}

function codexCounters(info){
 const t=info?.total_token_usage;
 return tokens(t?.input_tokens,t?.output_tokens,t?.cached_input_tokens,t?.cache_write_input_tokens);
}
function difference(after,before){
 if(!after)return null;
 const delta={};
 for(const key of Object.keys(after)){
  if(!Object.hasOwn(before,key))continue;
  if(after[key]<before[key])return null;
  delta[key]=after[key]-before[key];
 }
 return count(delta.input)&&count(delta.output)?nonempty(delta):null;
}
function codexQuota(rate,observedAt){
 if(rate?.limit_id!=='codex'||!Number.isFinite(Date.parse(observedAt)))return undefined;
 const windows=[rate.primary,rate.secondary].flatMap(w=>{
  if(!w||!Number.isFinite(w.used_percent)||w.used_percent<0||w.used_percent>100||!count(w.window_minutes)||!w.window_minutes||!count(w.resets_at)||w.resets_at*1000<=Date.parse(observedAt))return [];
  return [{usedPercent:w.used_percent,windowMinutes:w.window_minutes,resetsAt:w.resets_at}];
 });
 return windows.length?{observedAt,windows}:undefined;
}
export function codexTurnUsage(event,cwd,configDir=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')){
 const id=event['thread-id'],turn=event['turn-id'];
 if(!uuid.test(id||'')||!identifier.test(turn||''))return null;
 const root=real(path.join(configDir,'sessions'));
 const file=unique(dateDirectories(root).flatMap(dir=>fs.readdirSync(dir,{withFileTypes:true})
  .filter(e=>e.isFile()&&e.name.startsWith('rollout-')&&e.name.endsWith('-'+id+'.jsonl')).map(e=>path.join(dir,e.name))));
 if(!file)return null;
 const rows=rowsAt(root,file),header=rows?.[0];
 if(header?.type!=='session_meta'||header.payload?.id!==id||!matchesDirectory(header.payload.cwd,cwd))return null;
 let previous={input:0,output:0,cacheRead:0,cacheWrite:0},turnStart=null,end=null,quota,inside=false;
 for(const row of rows){
  if(row.type!=='event_msg')continue;
  const p=row.payload;
  if(['task_started','turn_started'].includes(p?.type)){
   if(inside)return null;
   if(p.turn_id===turn){inside=true;turnStart=previous;}
  }else if(p?.type==='token_count'){
   const latest=codexCounters(p.info);
   if(latest){previous=latest;if(inside)end=latest;}
   if(inside)quota=codexQuota(p.rate_limits,row.timestamp)||quota;
  }else if(['task_complete','turn_complete'].includes(p?.type)&&inside){
   if(p.turn_id!==turn)return null;
   return {identity:id+'/'+turn,tokens:difference(end,turnStart),quota};
  }
 }
 return null;
}

export function antigravityTurnUsage(event,lines,lastUser,lastResponse){
 if(!uuid.test(event.conversationId||'')||!count(event.executionNum)||lastUser<0)return null;
 const steps=new Map();
 for(const item of lines.slice(lastUser+1,lines.indexOf(lastResponse)+1)){
  if(item.source!=='MODEL'||item.type!=='PLANNER_RESPONSE'||item.status!=='DONE')continue;
  if(!count(item.step_index))return null;
  steps.set(item.step_index,tokens(item.input_tokens,item.output_tokens,item.cache_read_tokens,item.cache_write_tokens));
 }
 return {identity:event.conversationId+'/'+event.executionNum,tokens:nonempty(sum([...steps.values()]))};
}
export function minimaxTurnUsage(event,configDir=path.join(os.homedir(),'.minimax','v2')){
 const {session_id:id,turn_id:turn}=event;
 if(!identifier.test(id||'')||!identifier.test(turn||''))return null;
 const root=real(path.join(configDir,'sessions'));
 const dirs=dateDirectories(root).flatMap(dir=>fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>path.join(dir,e.name)));
 const session=unique(dirs.filter(dir=>{
  try{return JSON.parse(providerFile(root,path.join(dir,'manifest.json'),64*1024))?.sessionId===id;}catch{return false;}
 }));
 if(!session)return null;
 const rows=rowsAt(root,path.join(session,'messages.jsonl'));
 if(!rows)return null;
 const replies=new Map();
 for(const row of rows){
  if(row.turn_id!==turn||row.message?.role!=='assistant')continue;
  if(!identifier.test(row.message_id||''))return null;
  const u=row.message.usage;
  replies.set(row.message_id,tokens(u?.input,u?.output,u?.cacheRead,u?.cacheWrite));
 }
 return {identity:id+'/'+turn,tokens:nonempty(sum([...replies.values()]))};
}

export function saveProviderUsage(c,provider,event,source){
 if(!c.usageDir||!c.terminal)return;
 try{
  const usage=provider==='claude'?claudeTurnUsage(event,c.cwd):provider==='codex'?codexTurnUsage(event,c.cwd):
   provider==='minimax'&&source?minimaxTurnUsage(source):provider==='antigravity'?source:null;
  if(!usage?.identity||(!usage.tokens&&!usage.quota))return;
  const key=createHash('sha256').update(provider+'\n'+usage.identity).digest('hex');
  const record={key,provider,tokens:usage.tokens,...(usage.quota?{quota:usage.quota}:{})};
  fs.mkdirSync(c.usageDir,{recursive:true,mode:0o700});
  fs.appendFileSync(path.join(c.usageDir,'provider-usage.jsonl'),JSON.stringify(record)+'\n',{mode:0o600});
 }catch{
  // Usage is optional. An unavailable, outdated or partial provider log never blocks a reply.
 }
}

export function providerUsageRecords(c){
 if(!c.usageDir)return [];
 try{return fs.readFileSync(path.join(c.usageDir,'provider-usage.jsonl'),'utf8').trim().split('\n').flatMap(line=>{
  try{return [JSON.parse(line)];}catch{return [];}
 });}catch{return [];}
}
