import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {context,log} from './team-runtime.mjs';
import {directTerminal,withWorkerState} from './direct.mjs';
import {verifiedLegacyWorker} from './worker-chat.mjs';
const read=(file,fallback=null)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest=text=>createHash('sha256').update(text).digest('hex');
const cache=new Map();
function optionsFor(c,options){return options.config||(c.appHome?read(path.join(c.appHome,'service.json'),{}):{});}

// A CLI can change its cwd. Only Core's real launch identity and a registered
// binding determine the project; event.cwd never creates a new state directory.
export function hookReplyContext(event,c,options={}){
 if(!/^t[a-z0-9]+$/.test(c.terminal||''))return null;
 const t=c.run('hc',['get',c.terminal]);
 if(t?.address!==c.terminal||t.state!=='live')return null;
 const actual=fs.realpathSync(t.cwd),eventCwd=fs.realpathSync(event.cwd||actual);
 if(!inside(actual,eventCwd))return null;
 const roots=[t.labels?.['team.project'],options.projectRoot||process.env.HERDR_TEAM_PROJECT_ROOT,t.cwd].filter(Boolean),config=optionsFor(c,options);
 for(const root of new Set(roots)){
  let canonical;try{canonical=fs.realpathSync(root);}catch{continue;}if(!inside(canonical,actual))continue;
  const candidate=context(canonical,c.terminal,c.run,c.chat,config),control=read(path.join(candidate.teamDir,'control.json'));
  if(control?.terminal===t.address&&canonical===actual&&!t.parent&&t.labels?.['team.direct']!=='true')return candidate;
  if(directTerminal(candidate,t.address)||verifiedLegacyWorker(candidate,t.address,t))return candidate;
  const pending=Object.values(read(path.join(candidate.teamDir,'agent-registrations.json'),{})).find(r=>r.status==='pending'&&r.id===t.labels?.['team.creation']&&r.owner===t.parent&&r.chat===(candidate.chat||'legacy')&&r.agentId===t.labels?.['team.agent']);
  if(pending&&t.labels?.['team.owner']===t.parent&&t.labels?.['team.chat']===(candidate.chat||'legacy')&&t.labels?.['team.project']===candidate.cwd)return candidate;
 }
 return null;
}
function transcriptRows(file,root,previousVersion){
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>64*1024*1024||fs.realpathSync(file)!==file||!inside(root,file))return null;
 const version=[stat.ino,stat.size,stat.mtimeMs].join(':');if(version===previousVersion)return{version,rows:null};
 const text=fs.readFileSync(file,'utf8'),lines=text.split('\n');if(!text.endsWith('\n'))lines.pop();
 return {version,rows:lines.filter(Boolean).map(line=>JSON.parse(line))};
}
function historicalDirectory(root,directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||path.resolve(directory)!==directory||!inside(root,directory))return false;
 // A completed task may already have removed its temporary cwd. Validate its
 // nearest existing ancestor without recreating or reading the old directory.
 let ancestor=directory;while(!fs.existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)return false;ancestor=parent;}
 return inside(root,fs.realpathSync(ancestor));
}
function promptText(row){
 if(row.type!=='user'||row.isSidechain||row.isMeta||row.message?.role!=='user')return null;
 const value=row.message.content;
 if(typeof value==='string')return value.replace(/\n<\/pasted_content id="[a-z0-9]+">\s*$/,'').trimEnd();
 if(!Array.isArray(value)||value.some(x=>x.type==='tool_result'))return null;
 return value.filter(x=>x.type==='text').map(x=>x.text).join('\n').trimEnd();
}

// Recover text already produced by a known Claude coordinator. Never send a
// prompt, replay an action, restart a process or answer a permission dialog.
export function recoverClaudeReplies(c,options={}){
 try{return recoverClaudeRepliesChecked(c,options);}catch(error){return{recovered:0,reason:'recovery_unavailable',errorCode:error.code||'unavailable'};}
}
function recoverClaudeRepliesChecked(c,options){
 const now=options.now??Date.now(),settle=options.settleMs??15000,control=read(path.join(c.teamDir,'control.json'));
 if(control?.role!=='claude'||!uuid.test(control.sessionId||'')||!/^t[a-z0-9]+$/.test(control.terminal||''))return{recovered:0};
 const file=path.join(c.teamDir,'messages.jsonl');let messages;
 try{if(fs.statSync(file).size>32*1024*1024)return{recovered:0,reason:'history_too_large'};messages=fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return{recovered:0};throw e;}
 const replied=new Set(messages.filter(x=>x.kind==='reply'&&x.replyTo).map(x=>x.replyTo));
 const deliveries=messages.filter(x=>x.kind==='delivery'&&x.delivery==='sent'&&!x.direct&&!replied.has(x.messageId)&&now-Date.parse(x.time)>=settle&&now-Date.parse(x.time)<7*86400_000).slice(-24);
 if(!deliveries.length)return{recovered:0};
 const terminal=c.run('hc',['get',control.terminal]);
 if(terminal.address!==control.terminal||terminal.cwd!==c.cwd||terminal.parent||terminal.labels?.['team.direct']==='true'||terminal.state!=='live'||!['claude','claude-code'].includes(terminal.status?.app)||!['idle','done'].includes(terminal.status?.state))return{recovered:0,reason:'coordinator_not_idle'};
 const root=fs.realpathSync(options.transcriptRoot||path.join(os.homedir(),'.claude/projects')),name=c.cwd.replace(/[^a-zA-Z0-9-]/g,'-'),transcript=path.join(root,name,control.sessionId+'.jsonl');
 const key=c.teamDir,prefix=control.terminal+':'+control.sessionId+':'+deliveries.map(x=>x.messageId).join(','),previous=cache.get(key);
 let data;try{data=transcriptRows(transcript,root,previous?.prefix===prefix?previous.version:null);}catch(e){if(e.code==='ENOENT')return{recovered:0,reason:'transcript_unavailable'};throw e;}if(!data)return{recovered:0,reason:'unsafe_transcript'};
 if(!data.rows)return{recovered:0};
 const proposals=[];
 for(const delivery of deliveries){
  if(!uuid.test(delivery.messageId||''))continue;
  const queue=path.join(c.teamDir,'chat-queue',delivery.messageId+'.json');if(fs.existsSync(queue+'.cancelled')||fs.existsSync(queue+'.stopped'))continue;
  const sent=read(queue+'.sent');if(sent?.id!==delivery.messageId||typeof sent.text!=='string')continue;
  const candidates=data.rows.map((r,i)=>({r,i,text:promptText(r)})).filter(({r,text})=>text&&r.sessionId===control.sessionId&&text.endsWith(sent.text)&&Math.abs(Date.parse(r.timestamp)-Date.parse(delivery.time))<15000);
  if(candidates.length!==1)continue;
  const {r:user,i}=candidates[0],next=data.rows.findIndex((r,n)=>n>i&&promptText(r)!==null),turn=data.rows.slice(i+1,next<0?undefined:next);
  const answer=turn.findLast(r=>r.type==='assistant'&&!r.isSidechain&&!r.isApiErrorMessage&&r.sessionId===control.sessionId&&r.message?.stop_reason==='end_turn'&&Array.isArray(r.message.content)&&r.message.content.some(x=>x.type==='text'));
  if(!answer||!uuid.test(answer.uuid||'')||!uuid.test(user.uuid||'')||!turn.some(r=>r.type==='system'&&r.subtype==='stop_hook_summary'&&r.sessionId===control.sessionId&&Date.parse(r.timestamp)>=Date.parse(answer.timestamp)))continue;
  if(!historicalDirectory(c.cwd,answer.cwd||c.cwd))continue;
  const text=answer.message.content.filter(x=>x.type==='text').map(x=>x.text).join('\n').trim();if(!text||messages.some(x=>x.kind==='reply'&&x.text?.trim()===text&&Math.abs(Date.parse(x.time)-Date.parse(answer.timestamp))<15000))continue;
  proposals.push({id:delivery.messageId,text,userUuid:user.uuid,assistantUuid:answer.uuid,producedAt:answer.timestamp,sha256:digest(text)});
 }
 const result=withWorkerState(c,()=>{
  const current=read(path.join(c.teamDir,'control.json'));if(current?.terminal!==control.terminal||current?.sessionId!==control.sessionId)return{recovered:0,reason:'coordinator_changed'};
  const existing=fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),handled=new Set(existing.filter(x=>x.kind==='reply'&&x.replyTo).map(x=>x.replyTo));let recovered=0;
  for(const proposal of proposals){
   if(handled.has(proposal.id))continue;
   const actions=proposal.text.includes('<herdr-action>'),visible=proposal.text.replace(/<herdr-action>[\s\S]*?<\/herdr-action>/g,'').trim();
   if(!visible)continue;
   log({...c,terminal:control.terminal},'Claude',visible,'reply',{replyTo:proposal.id,recovered:true,recoverySource:{provider:'claude',sessionId:control.sessionId,userUuid:proposal.userUuid,assistantUuid:proposal.assistantUuid,producedAt:proposal.producedAt,sha256:proposal.sha256},...(actions?{recoveryActionsPending:true}:{})});
   handled.add(proposal.id);
   if(actions)log(c,'系統','已補回漏接的文字回覆；其中協作操作未自動重播，請由原代理核對任務狀態後接續。','progress');
   const marker=path.join(c.teamDir,'legacy-message.json'),value=read(marker);if(value?.id===proposal.id&&value.terminal===control.terminal)fs.writeFileSync(marker,JSON.stringify({...value,replyCaptured:true,recovered:true}),{mode:0o600});recovered++;
  }
  return{recovered};
 });
 cache.set(key,{prefix,version:data.version});if(cache.size>64)cache.delete(cache.keys().next().value);return result;
}
