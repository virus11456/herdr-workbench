import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {context,captureReply} from './team-runtime.mjs';import {directTerminal,bindNativeSession,pendingRegistrations,recoverWorkerBinding} from './direct.mjs';
const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
export function minimaxReply(event,home,run){
 if(event.hook_event_name!=='Stop'||typeof event.cwd!=='string'||typeof event.last_assistant_message!=='string'||!event.last_assistant_message.trim()||typeof event.session_id!=='string'||event.session_id.length>128||typeof event.turn_id!=='string')return{captured:false,reason:'not_final_stop'};
 const config=read(path.join(home,'service.json'));if(!config?.headless||config.appHome!==home)return{captured:false,reason:'not_workbench'};
 const workspace=fs.realpathSync(event.cwd),projects=read(path.join(home,'web/projects.json'),[]),roots=[...new Set(projects.flatMap(p=>{try{const root=fs.realpathSync(p.folder);return workspace===root||workspace.startsWith(root+path.sep)?[root]:[];}catch{return[];}}))];
 if(!roots.length)return{captured:false,reason:'unregistered_project'};
 const candidates=[],marker=event.last_assistant_message.match(/<herdr-reply-id>([a-f0-9-]{36})<\/herdr-reply-id>/)?.[1];
 const contexts=roots.flatMap(root=>{const base=context(root,null,run,null,config),dir=path.join(base.teamBase,'conversations'),chats=fs.existsSync(dir)?fs.readdirSync(dir).filter(id=>/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)):[];return[null,...chats].map(chat=>{const c=context(root,null,run,chat,config);return{c,bindings:read(path.join(c.teamDir,'direct-bindings.json'),{})};});});
 const ownerKey=(c,id)=>c.cwd+':'+c.chat+':'+id,knownOwners=contexts.flatMap(({c,bindings})=>Object.entries(bindings).filter(([,b])=>b.minimaxSessionId===event.session_id).map(([id])=>ownerKey(c,id)));
 for(const {c,bindings}of contexts){
  // A very fast first Stop can precede the launch command's return/normal binding.
  for(const intent of pendingRegistrations(c).filter(r=>r.provider==='minimax'&&r.cwd===workspace))try{
   const listing=intent.terminal?[{address:intent.terminal}]:c.run('hc',['ls','--json','--label','team.creation='+intent.id]),listed=Array.isArray(listing)?listing:listing.terminals;
   if(!Array.isArray(listed)||listed.length!==1)continue;const id=listed[0].address||listed[0].id;
   recoverWorkerBinding({...c,terminal:id});if(bindings[id])continue;
   const t=c.run('hc',['get',id]),screen=String(c.run('hc',['read',id,'--json','--lines','200']).text||'');
   if(t.cwd===workspace&&t.status?.app==='mcode'&&screen.replace(/[\s*_`~]/g,'').includes(event.last_assistant_message.replace(/[\s*_`~]/g,'')))candidates.push({c:{...c,terminal:id},known:false});
  }catch{}
  for(const [id,binding]of Object.entries(bindings)){
  if(binding.provider!=='minimax'||(!binding.awaitingReply&&!(binding.legacyOwner&&binding.ownerAwaitingReply)&&binding.minimaxSessionId!==event.session_id))continue;
  if(knownOwners.length&&!knownOwners.includes(ownerKey(c,id)))continue;
  if(marker&&binding.lastMessageId!==marker)continue;
  try{const actual=directTerminal(c,id);if(!actual||actual.t.cwd!==workspace||actual.t.status?.app!=='mcode')continue;const result=c.run('hc',['read',id,'--json','--lines','200']),screen=String(result.text||'');if(!screen.trim())continue;if(marker&&!screen.replace(/\s/g,'').includes(marker))continue;if(!marker&&binding.minimaxSessionId!==event.session_id&&!screen.replace(/[\s*_`~]/g,'').includes(event.last_assistant_message.replace(/[\s*_`~]/g,'')))continue;candidates.push({c:{...c,terminal:id},known:binding.minimaxSessionId===event.session_id});}catch{}
 }}
 const matches=candidates.some(x=>x.known)?candidates.filter(x=>x.known):candidates;
 if(matches.length!==1)return{captured:false,reason:matches.length?'ambiguous_terminal':'no_matching_terminal'};
 const c=matches[0].c,model=typeof event.model==='string'?event.model:event.model?.id;
 const result=captureReply({type:'agent-turn-complete','turn-id':event.session_id+':'+event.turn_id,'last-assistant-message':event.last_assistant_message,model},c,'MiniMax',{session_id:event.session_id,turn_id:event.turn_id});
 if(result.captured)bindNativeSession(c,event.session_id);return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const home=path.dirname(fileURLToPath(import.meta.url));try{const event=JSON.parse(fs.readFileSync(0,'utf8')),result=minimaxReply(event,home);fs.mkdirSync(path.join(home,'logs'),{recursive:true,mode:0o700});fs.appendFileSync(path.join(home,'logs/minimax-hook-status.jsonl'),JSON.stringify({time:new Date().toISOString(),event:event.hook_event_name,result})+'\n',{mode:0o600});}catch(error){process.stderr.write('Herdr MiniMax reply capture failed: '+error.message+'\n');}process.stdout.write('{}\n');
}
