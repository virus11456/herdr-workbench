import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {context,captureReply} from './team-runtime.mjs';import {directTerminal,bindNativeSession} from './direct.mjs';
const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
export function minimaxReply(event,home,run){
 if(event.hook_event_name!=='Stop'||typeof event.cwd!=='string'||typeof event.last_assistant_message!=='string'||!event.last_assistant_message.trim()||typeof event.session_id!=='string'||event.session_id.length>128||typeof event.turn_id!=='string')return{captured:false,reason:'not_final_stop'};
 const config=read(path.join(home,'service.json'));if(!config?.headless||config.appHome!==home)return{captured:false,reason:'not_workbench'};
 const root=fs.realpathSync(event.cwd),projects=read(path.join(home,'web/projects.json'),[]);if(!projects.some(p=>{try{return fs.realpathSync(p.folder)===root;}catch{return false;}}))return{captured:false,reason:'unregistered_project'};
 const base=context(root,null,run,null,config),dir=path.join(base.teamBase,'conversations'),chats=fs.existsSync(dir)?fs.readdirSync(dir).filter(id=>/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)):[],candidates=[],marker=event.last_assistant_message.match(/<herdr-reply-id>([a-f0-9-]{36})<\/herdr-reply-id>/)?.[1];
 const contexts=chats.map(chat=>{const c=context(root,null,run,chat,config);return{c,bindings:read(path.join(c.teamDir,'direct-bindings.json'),{})};}),knownOwners=contexts.flatMap(({c,bindings})=>Object.entries(bindings).filter(([,b])=>b.minimaxSessionId===event.session_id).map(([id])=>c.chat+':'+id));
 for(const {c,bindings}of contexts){for(const [id,binding]of Object.entries(bindings)){
  if(binding.provider!=='minimax'||(!binding.awaitingReply&&binding.minimaxSessionId!==event.session_id))continue;
  if(knownOwners.length&&!knownOwners.includes(c.chat+':'+id))continue;
  if(marker&&binding.lastMessageId!==marker)continue;
  try{const actual=directTerminal(c,id);if(!actual||actual.t.status?.app!=='mcode')continue;const result=c.run('hc',['read',id,'--json','--lines','200']),screen=String(result.text||'');if(!screen.trim())continue;if(marker&&!screen.replace(/\s/g,'').includes(marker))continue;if(!marker&&binding.minimaxSessionId!==event.session_id&&!screen.replace(/[\s*_`~]/g,'').includes(event.last_assistant_message.replace(/[\s*_`~]/g,'')))continue;candidates.push({c:{...c,terminal:id},known:binding.minimaxSessionId===event.session_id});}catch{}
 }}
 const matches=candidates.some(x=>x.known)?candidates.filter(x=>x.known):candidates;
 if(matches.length!==1)return{captured:false,reason:matches.length?'ambiguous_terminal':'no_matching_terminal'};
 const c=matches[0].c,model=typeof event.model==='string'?event.model:event.model?.id;
 const result=captureReply({type:'agent-turn-complete','turn-id':event.session_id+':'+event.turn_id,'last-assistant-message':event.last_assistant_message,model},c,'MiniMax');
 if(result.captured)bindNativeSession(c,event.session_id);return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const home=path.dirname(fileURLToPath(import.meta.url));try{const event=JSON.parse(fs.readFileSync(0,'utf8')),result=minimaxReply(event,home);fs.mkdirSync(path.join(home,'logs'),{recursive:true,mode:0o700});fs.appendFileSync(path.join(home,'logs/minimax-hook-status.jsonl'),JSON.stringify({time:new Date().toISOString(),event:event.hook_event_name,result})+'\n',{mode:0o600});}catch(error){process.stderr.write('Herdr MiniMax reply capture failed: '+error.message+'\n');}process.stdout.write('{}\n');
}
