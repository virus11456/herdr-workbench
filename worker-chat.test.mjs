import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {context,roster,saveRoster,captureReply,executeRequest,report} from './team-runtime.mjs';import {adoptWorkerChat,enqueueDirect,drainDirect,directTerminal} from './direct.mjs';
const read=p=>JSON.parse(fs.readFileSync(p));
function fixture(t,provider='codex'){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'herdr-adopted-chat-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let state='done',turn=1,exists=true;const calls=[],id='tworker',owner='tlead';
 const c=context(root,null,null,'chat',{headless:true,stateRoot:path.join(root,'private')});fs.mkdirSync(c.teamDir,{recursive:true});fs.writeFileSync(path.join(c.teamDir,'control.json'),JSON.stringify({terminal:owner,role:'claude',phase:'active'}));fs.writeFileSync(path.join(c.teamDir,'worker-bindings.json'),JSON.stringify({[id]:{owner,chat:'chat',name:'Codex',sentAt:Date.now()-20000}}));
 fs.writeFileSync(path.join(c.teamDir,'messages.jsonl'),JSON.stringify({kind:'worker-report',terminal:id,role:'逐字稿員',text:'原本的公開工作回報',time:new Date(Date.now()-60000).toISOString(),reportId:'old-report'})+'\n');
 const terminal=()=>({address:id,cwd:c.cwd,parent:owner,state:exists?'live':'finished',turn,status:{app:provider==='claude'?'claude-code':provider==='minimax'?'mcode':provider,state},labels:{'team.owner':owner,'team.chat':'chat'}});
 c.run=(_cmd,args)=>{calls.push(args);if(args[0]==='get'){if(!exists)throw Object.assign(Error('gone'),{stdout:JSON.stringify({error:{kind:'not_found'}})});return terminal();}if(args[0]==='send'){assert.equal(args[1],id);turn++;return{ok:true};}if(args[0]==='read')return{text:'GPT-6.1-Sol medium · Context 20%'};assert.fail('Unexpected Core mutation '+args[0]);};
 return {c,id,owner,calls,terminal,setState:value=>{state=value;},setMissing:()=>{exists=false;}};
}
for(const provider of ['codex','claude','antigravity','minimax'])test(`an existing ${provider} child becomes directly chat-capable without creating or relabeling a terminal`,t=>{
 const f=fixture(t,provider),result=adoptWorkerChat(f.c,f.terminal());assert.equal(result.terminal,f.id);assert(result.reused);assert.equal(roster(f.c).length,1);assert.equal(roster(f.c)[0].provider,provider);assert.equal(roster(f.c)[0].name,'逐字稿員');assert.equal(adoptWorkerChat(f.c,f.terminal()).agentId,result.agentId);assert.equal(roster(f.c).length,1);assert(directTerminal(f.c,f.id));
 const messages=()=>fs.readFileSync(path.join(f.c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(messages().filter(m=>m.kind==='worker-report').length,1);assert.equal(messages().filter(m=>m.direct&&m.target===result.agentId).length,1);
 enqueueDirect(f.c,result.agentId,'Answer 6+7','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');assert.equal(drainDirect(f.c).terminal,f.id);assert(f.calls.some(x=>x[0]==='send'));assert(!f.calls.some(x=>['run','kill','keys'].includes(x[0])));
 const event=provider==='claude'?{hook_event_name:'Stop',last_assistant_message:'6+7=13'}:{type:'agent-turn-complete','turn-id':'direct-turn','last-assistant-message':'6+7=13'};const role={claude:'Claude',codex:'Codex',antigravity:'Antigravity',minimax:'MiniMax'}[provider];
 assert(captureReply(event,{...f.c,terminal:f.id},role).captured);const reply=messages().find(m=>m.replyTo==='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');assert.equal(reply.target,result.agentId);assert.equal(reply.text,'6+7=13');assert(!fs.existsSync(path.join(f.c.teamDir,'outbox')));
});
test('user messages wait for the original owner task, whose report remains visible to both the owner and the adopted agent',t=>{
 const f=fixture(t);f.setState('working');const adopted=adoptWorkerChat(f.c,f.terminal());enqueueDirect(f.c,adopted.agentId,'Next task','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');assert.equal(drainDirect(f.c).reason,'waiting_owner_task');assert(!f.calls.some(x=>x[0]==='send'));
 f.setState('done');const reply=captureReply({type:'agent-turn-complete','turn-id':'owner-turn','last-assistant-message':'原交辦已完成，已核對結果'},{...f.c,terminal:f.id},'Codex');assert(reply.captured);assert.equal(read(path.join(f.c.teamDir,'direct-bindings.json'))[f.id].ownerAwaitingReply,false);assert.equal(drainDirect(f.c).sent,1);
 const rows=fs.readFileSync(path.join(f.c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert(rows.some(r=>r.kind==='worker-report'&&r.text==='原交辦已完成，已核對結果'));assert(rows.some(r=>r.direct&&r.target===adopted.agentId&&r.text==='原交辦已完成，已核對結果'));assert(fs.readdirSync(path.join(f.c.teamDir,'outbox')).some(n=>n.endsWith('.json')));
});
test('legacy owner sends cannot interleave with queued or delivered user messages, and cannot start a duplicate adopted agent',t=>{
 const f=fixture(t),adopted=adoptWorkerChat(f.c,f.terminal()),owner={...f.c,terminal:f.owner},send={sender:f.owner,action:'send',args:{terminal:f.id,text:'Owner task'}};
 enqueueDirect(f.c,adopted.agentId,'User first','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');assert.throws(()=>executeRequest(owner,send),/直接訊息/);assert.equal(drainDirect(f.c).sent,1);assert.throws(()=>executeRequest(owner,send),/直接訊息/);
 assert.throws(()=>executeRequest(owner,{sender:f.owner,action:'run',args:{agentId:adopted.agentId,name:'duplicate',task:'Do work'}}),/already has/);assert(!f.calls.some(x=>x[0]==='run'));
});
test('adoption refuses foreign workers and leaves the roster unchanged',t=>{
 const f=fixture(t);for(const terminal of [{...f.terminal(),cwd:'/other'},{...f.terminal(),parent:'tforeign'},{...f.terminal(),labels:{'team.owner':f.owner,'team.chat':'other'}}])assert.throws(()=>adoptWorkerChat(f.c,terminal),/無法核對/);assert.equal(roster(f.c).length,0);
});

test('changing the engine of a busy adopted worker never creates a second active agent',t=>{
 const f=fixture(t),adopted=adoptWorkerChat(f.c,f.terminal());saveRoster(f.c,roster(f.c).map(a=>({...a,provider:'antigravity'})));f.setState('working');enqueueDirect(f.c,adopted.agentId,'Later task','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');assert.equal(drainDirect(f.c).reason,'waiting_engine_switch');assert(!f.calls.some(x=>['run','kill','send'].includes(x[0])));
});

test('an adopted idle worker can move like another agent, with one verified stop and its history retained',async t=>{
 const f=fixture(t),adopted=adoptWorkerChat(f.c,f.terminal()),{manageAgent,rosterRevision}=await import('./web/agent-management.mjs'),targetFolder=path.join(f.c.cwd,'target');fs.mkdirSync(targetFolder);const target=context(targetFolder,null,null,'target-chat',{headless:true,stateRoot:path.join(f.c.cwd,'private')});saveRoster(target,[]);let kills=0;
 const core=async args=>{if(args[0]==='kill'){kills++;f.setMissing();return{ok:true};}return f.c.run('hc',args);};
 const result=await manageAgent({source:f.c,target,sourceWorkspace:false,targetWorkspace:true,agentId:adopted.agentId,expectedRevision:rosterRevision(f.c),core});assert(result.moved);assert.equal(kills,1);assert.equal(roster(f.c).length,0);assert.equal(roster(target)[0].name,'逐字稿員');assert(fs.readFileSync(path.join(f.c.teamDir,'messages.jsonl'),'utf8').includes('原本的公開工作回報'));
});
test('an adopted worker waiting on its owner task cannot be deleted or moved',async t=>{
 const f=fixture(t);f.setState('working');const adopted=adoptWorkerChat(f.c,f.terminal()),{manageAgent,rosterRevision}=await import('./web/agent-management.mjs');await assert.rejects(()=>manageAgent({source:f.c,target:null,sourceWorkspace:false,agentId:adopted.agentId,expectedRevision:rosterRevision(f.c),core:args=>f.c.run('hc',args)}),/等待回覆/);assert.equal(roster(f.c).length,1);assert(!f.calls.some(x=>x[0]==='kill'));
});

test('direct replies and stale report instructions never leak to the old owner; later explicit owner work still reports normally',t=>{
 const f=fixture(t),adopted=adoptWorkerChat(f.c,f.terminal()),message='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';enqueueDirect(f.c,adopted.agentId,'User direct task',message);drainDirect(f.c);
 const manual=report({...f.c,terminal:f.id},f.owner,'逐字稿員','Progress from an old report instruction');assert.equal(manual.forwardedToCoordinator,false);assert(!fs.existsSync(path.join(f.c.teamDir,'outbox')));
 const event={type:'agent-turn-complete','turn-id':'user-turn','last-assistant-message':'User result'};assert(captureReply(event,{...f.c,terminal:f.id},'Codex').captured);assert.equal(captureReply(event,{...f.c,terminal:f.id},'Codex').captured,false);assert(!fs.existsSync(path.join(f.c.teamDir,'outbox')));
 executeRequest({...f.c,terminal:f.owner},{sender:f.owner,action:'send',args:{terminal:f.id,text:'New owner task'}});const ownerEvent={type:'agent-turn-complete','turn-id':'new-owner-turn','last-assistant-message':'Owner result'};assert(captureReply(ownerEvent,{...f.c,terminal:f.id},'Codex').captured);assert.equal(fs.readdirSync(path.join(f.c.teamDir,'outbox')).length,1);
});
