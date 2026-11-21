import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {pathToFileURL,fileURLToPath} from 'node:url';
import {context,captureReply} from './team-runtime.mjs';import {directTerminal} from './direct.mjs';
import {antigravityTurnUsage} from './provider-usage.mjs';
export function agyReply(event,c,brainRoot=path.join(os.homedir(),'.gemini/antigravity-cli/brain')){
 if(!c.terminal||event.fullyIdle!==true||!['model_stop','NO_TOOL_CALL'].includes(event.terminationReason)||event.error)return{captured:false,reason:'not_successfully_idle'};
 if(!/^[a-f0-9-]{36}$/.test(event.conversationId||''))return{captured:false,reason:'invalid_conversation'};
 if(!Array.isArray(event.workspacePaths)||!event.workspacePaths.some(p=>{try{return fs.realpathSync(p)===c.cwd;}catch{return false;}}))return{captured:false,reason:'workspace_mismatch'};
 // Authenticate the real Herdr binding before opening any CLI transcript.
 if(!directTerminal(c,c.terminal)){
  let binding,control;try{binding=JSON.parse(fs.readFileSync(path.join(c.teamDir,'worker-bindings.json')))[c.terminal];control=JSON.parse(fs.readFileSync(path.join(c.teamDir,'control.json')));}catch{return{captured:false};}
  if(!binding||binding.owner!==control.terminal||binding.chat!==(c.chat||'legacy'))return{captured:false};
  const t=c.run('hc',['get',c.terminal]);if(t.parent!==control.terminal||t.cwd!==c.cwd||t.labels?.['team.owner']!==control.terminal||t.labels?.['team.chat']!==binding.chat)return{captured:false};
 }
 const reported=event.transcriptPath?.startsWith('file:')?fileURLToPath(event.transcriptPath):event.transcriptPath;
 const filename=path.basename(reported||'');if(!['transcript.jsonl','transcript_full.jsonl'].includes(filename))return{captured:false,reason:'unsupported_transcript'};
 const canonicalBrain=fs.realpathSync(brainRoot),expected=path.join(canonicalBrain,event.conversationId,'.system_generated/logs',filename);
 if(!path.isAbsolute(reported||'')||!fs.existsSync(reported)||fs.realpathSync(reported)!==fs.realpathSync(expected)||!fs.realpathSync(expected).startsWith(path.join(canonicalBrain,event.conversationId)+path.sep))return{captured:false,reason:'transcript_path_mismatch',reportedRelative:path.relative(brainRoot,reported||'')};
 const stat=fs.statSync(expected);if(stat.size>8*1024*1024)return{captured:false,reason:'transcript_too_large'};
 const lines=fs.readFileSync(expected,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const lastUser=lines.findLastIndex(line=>line.type==='USER_INPUT'),last=lines.findLast(line=>line.source==='MODEL'&&line.type==='PLANNER_RESPONSE');
 if(!last||lines.indexOf(last)<=lastUser||last.status!=='DONE'||typeof last.content!=='string'||!last.content.trim()||last.tool_calls?.length)return{captured:false,reason:'no_final_response'};
 return captureReply({type:'agent-turn-complete','turn-id':event.conversationId+':'+event.executionNum,'last-assistant-message':last.content,modelName:event.modelName},c,'Antigravity',antigravityTurnUsage(event,lines,lastUser,last));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const event=JSON.parse(fs.readFileSync(0,'utf8')),home=path.dirname(fileURLToPath(import.meta.url)),diagnostic={time:new Date().toISOString(),hasTerminal:!!process.env.HC_TERMINAL_ID,hasHome:!!process.env.HERDR_WORKBENCH_HOME,keys:Object.keys(event),fullyIdle:event.fullyIdle,terminationReason:event.terminationReason};
  if(process.env.HC_TERMINAL_ID&&process.env.HERDR_WORKBENCH_HOME){const base=context(),t=base.run('hc',['get',base.terminal]),chat=t.labels?.['team.chat'];diagnostic.terminal=base.terminal;diagnostic.hookCwdMatchesTerminal=base.cwd===t.cwd;if(chat&&chat!=='legacy')diagnostic.result=agyReply(event,context(t.cwd,base.terminal,undefined,chat));}
  fs.mkdirSync(path.join(home,'logs'),{recursive:true,mode:0o700});fs.appendFileSync(path.join(home,'logs/agy-hook-status.jsonl'),JSON.stringify(diagnostic)+'\n',{mode:0o600});
 }catch(error){process.stderr.write('Herdr reply capture failed: '+error.message+'\n');}
 process.stdout.write('{"decision":"stop"}\n');
}
