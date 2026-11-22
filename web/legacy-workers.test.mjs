import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {workerCandidates,workerView,createWorkerObserver} from './legacy-workers.mjs';
const scope={cwd:'/project',teamDir:'/private/state/chat',chat:'chat'},candidate={address:'tworker',binding:{owner:'tlead',chat:'chat',name:'Codex'},scope};
const terminal={address:'tworker',cwd:'/project',parent:'tlead',name:'transcriber-job',state:'live',status:{app:'codex',state:'working'},labels:{'team.owner':'tlead','team.chat':'chat'}};
test('a temporary worker is named from its real public report and stays separate from the permanent roster',()=>{
 const reports=[{terminal:'tworker',kind:'worker-report',role:'逐字稿員',text:'Audio unavailable',time:'2026-11-22T03:00:00Z'}];
 const view=workerView(candidate,terminal,reports);assert.equal(view.name,'逐字稿員');assert.equal(view.provider,'codex');assert.equal(view.lastReport,'Audio unavailable');assert(view.temporary);assert.equal(view.terminal,'tworker');assert.equal(view.status.state,'working');
 assert.equal(workerView(candidate,{...terminal,labels:{...terminal.labels,'team.agent':'registered-agent'}},reports),null);
});
test('foreign, finished, unverified or cross-chat terminals cannot appear as this project worker',()=>{
 for(const value of [null,{...terminal,cwd:'/other'},{...terminal,parent:'tother'},{...terminal,state:'finished'},{...terminal,status:{app:'zsh',state:'idle'}},{...terminal,labels:{...terminal.labels,'team.chat':'foreign'}}])assert.equal(workerView(candidate,value),null);
});
test('only current or previous coordinator bindings are candidates, and each scope keeps its real chat',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-workers-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const ctx=(_folder,chat=null)=>({cwd:'/project',chat,teamDir:path.join(root,chat||'legacy')});
 for(const chat of [null,'chat']){const c=ctx('/project',chat);fs.mkdirSync(c.teamDir,{recursive:true});fs.writeFileSync(path.join(c.teamDir,'control.json'),JSON.stringify({terminal:'tlead'}));fs.writeFileSync(path.join(c.teamDir,'worker-bindings.json'),JSON.stringify({[chat?'tworker':'troot']:{owner:'tlead',chat:chat||'legacy'},tforeign:{owner:'tother',chat:chat||'legacy'}}));}
 const rows=workerCandidates({folder:'/project',chats:[{id:'legacy'},{id:'chat'}]},ctx);assert.deepEqual(rows.map(r=>[r.address,r.scope.chat]),[['troot',null],['tworker','chat']]);
});
test('worker observation uses verified Core results with a bounded cache and never sends or creates work',async()=>{
 const calls=[],core=async args=>{calls.push(args);if(args[0]==='ls')return{terminals:[{address:'tworker'}]};if(args[0]==='get')return terminal;assert.fail('Mutation attempted');};
 const observer=createWorkerObserver(core,()=>[]),plans=[{id:'project',candidates:[candidate]}];
 assert.equal((await observer(plans))[0].workers[0].name,'transcriber-job');await observer(plans);assert.equal(calls.length,2);
});
