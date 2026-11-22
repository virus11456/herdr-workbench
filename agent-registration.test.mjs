import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {context,roster,saveRoster,executeRequest,captureReply} from './team-runtime.mjs';
import {enqueueDirect,drainDirect,directTerminal,reconcileWorkerMembers,pendingRegistrations,retryDirect} from './direct.mjs';
const read=p=>JSON.parse(fs.readFileSync(p));
function fixture(t,provider='codex'){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'herdr-register52-'))),home=path.join(root,'host'),config={headless:true,stateRoot:path.join(root,'state'),appHome:home};t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const c=context(root,null,null,'chat',config);fs.mkdirSync(c.teamDir,{recursive:true});fs.mkdirSync(path.join(home,'web'),{recursive:true});fs.writeFileSync(path.join(home,'service.json'),JSON.stringify(config));fs.writeFileSync(path.join(home,'web/projects.json'),JSON.stringify([{folder:root,chats:[{id:'chat'}]}]));fs.writeFileSync(path.join(c.teamDir,'control.json'),JSON.stringify({terminal:'towner',role:'claude',phase:'active'}));
 const calls=[],terminals=new Map();let failGet=false,lostResponse=false,firstSent=true;const app=provider==='claude'?'claude-code':provider==='minimax'?'mcode':provider;
 const run=(_cmd,args)=>{calls.push(args);if(args[0]==='run'){
  const labels={};for(let i=0;i<args.length;i++)if(args[i]==='--label'){const at=args[++i].indexOf('=');labels[args[i].slice(0,at)]=args[i].slice(at+1);}
  const terminal={address:'tworker',pid:1234,cwd:args[args.indexOf('--cwd')+1],parent:'towner',state:'live',turn:1,status:{app,state:firstSent?'working':'blocked'},labels};terminals.set('tworker',terminal);
  if(lostResponse)throw Error('Core response was lost');return{address:'tworker',first_message:{sent:firstSent}};
 }if(args[0]==='get'){
  if(failGet)throw Error('Core temporarily unavailable');const terminal=terminals.get(args[1]);if(!terminal)throw Object.assign(Error('not found'),{stdout:JSON.stringify({error:{kind:'not_found'}})});return structuredClone(terminal);
 }if(args[0]==='ls'){
  const filters=args.flatMap((x,i)=>x==='--label'?[args[i+1]]:[]);return{terminals:[...terminals.values()].filter(t=>filters.every(f=>{const at=f.indexOf('=');return t.labels[f.slice(0,at)]===f.slice(at+1);})).map(t=>({address:t.address}))};
 }if(args[0]==='send'){const t=terminals.get(args[1]);assert(t);t.turn++;t.status.state='working';return{ok:true};}if(args[0]==='read')return{text:'GPT-6.1-Sol medium · Context 20%\n算術結果'};assert.fail('Unexpected Core action '+args[0]);};c.run=run;
 const template={claude:'herdr-claude-task',codex:'herdr-codex-implement',minimax:'herdr-minimax-cn',antigravity:'herdr-antigravity-task'}[provider];
 const req={id:randomUUID(),sender:'towner',action:'run',args:{template,name:'registration-test',displayName:'資料核對員',brief:'依目前任務唯讀核對資料',task:'只計算 10+17，不修改檔案'}};
 return{c,root,home,config,req,provider,calls,terminals,run,setFailGet:v=>failGet=v,setLostResponse:v=>lostResponse=v,setFirstSent:v=>firstSent=v};
}
const event=(provider,text,key)=>provider==='claude'?{hook_event_name:'Stop',session_id:key,last_assistant_message:text}:{type:'agent-turn-complete','turn-id':key,'last-assistant-message':text};
for(const provider of ['claude','codex','minimax','antigravity'])test(`${provider} legacy creation immediately registers one normal chat member, keeps its process, and pairs later direct replies`,t=>{
 const f=fixture(t,provider),made=executeRequest(f.c,f.req);assert(made.registered);assert.equal(made.address,'tworker');assert.equal(roster(f.c).length,1);assert.equal(roster(f.c)[0].name,'資料核對員');assert.equal(roster(f.c)[0].brief,'依目前任務唯讀核對資料');assert.equal(directTerminal(f.c,'tworker').binding.agentId,made.agentId);
 assert.equal(executeRequest(f.c,f.req).agentId,made.agentId);assert.equal(f.calls.filter(a=>a[0]==='run').length,1);
 const message=randomUUID();enqueueDirect(f.c,made.agentId,'Answer 12+13',message);assert.equal(drainDirect(f.c).reason,'waiting_owner_task');f.terminals.get('tworker').status.state='done';
 const role={claude:'Claude',codex:'Codex',minimax:'MiniMax',antigravity:'Antigravity'}[provider];assert(captureReply(event(provider,'10+17=27','owner-turn'),{...f.c,terminal:'tworker'},role).captured);assert.equal(drainDirect(f.c).terminal,'tworker');assert(captureReply(event(provider,'12+13=25','direct-turn'),{...f.c,terminal:'tworker'},role).captured);
 const rows=fs.readFileSync(path.join(f.c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert(rows.some(r=>r.kind==='worker-report'&&r.text==='10+17=27'));assert(rows.some(r=>r.replyTo===message&&r.agentId===made.agentId&&r.text==='12+13=25'));assert.equal(f.calls.filter(a=>a[0]==='run').length,1);assert(fs.existsSync(path.join(f.c.teamBase,'registration-backups')));
});
test('existing member names, models, briefs, and pins survive legacy launch without a second roster identity',t=>{
 const f=fixture(t,'claude'),member={id:'planner',name:'我的企劃',provider:'claude',model:'claude-fable-5-2',brief:'保留我的設定',level:'manager'};saveRoster(f.c,[member]);fs.writeFileSync(path.join(f.c.teamBase,'sidebar.json'),JSON.stringify({revision:3,order:['planner'],pinned:['planner']}));f.req.args.agentId='planner';delete f.req.args.template;
 const before=fs.readFileSync(path.join(f.c.teamBase,'roster.json')),pins=fs.readFileSync(path.join(f.c.teamBase,'sidebar.json'));const made=executeRequest(f.c,f.req);assert(made.registered);assert.equal(made.agentId,'planner');assert.equal(executeRequest(f.c,f.req).agentId,'planner');assert(fs.readFileSync(path.join(f.c.teamBase,'roster.json')).equals(before));assert(fs.readFileSync(path.join(f.c.teamBase,'sidebar.json')).equals(pins));
});
test('unknown launch results block duplicate engines and management until real Core identity is recovered',async t=>{
 const f=fixture(t);f.setLostResponse(true);assert.throws(()=>executeRequest(f.c,f.req),/啟動結果待核對/);const agent=roster(f.c)[0];assert.equal(pendingRegistrations(f.c).length,1);enqueueDirect(f.c,agent.id,'Later task',randomUUID());assert.equal(drainDirect(f.c).reason,'registration_pending');
 assert.throws(()=>executeRequest(f.c,{...f.req,id:randomUUID()}),/尚未核對/);assert.equal(f.calls.filter(a=>a[0]==='run').length,1);const {manageAgent,rosterRevision}=await import('./web/agent-management.mjs');await assert.rejects(()=>manageAgent({source:f.c,sourceWorkspace:false,agentId:agent.id,expectedRevision:rosterRevision(f.c),core:a=>f.run('hc',a)}),/啟動結果仍待核對/);
 assert.equal(reconcileWorkerMembers(f.c).registered,1);assert.equal(pendingRegistrations(f.c).length,0);assert.equal(directTerminal(f.c,'tworker').binding.agentId,agent.id);assert.equal(f.calls.filter(a=>a[0]==='run').length,1);
});
test('only an explicit retry and authoritative empty listing clears an unresolved launch; it never retries permission or starts work',t=>{
 const f=fixture(t);f.setLostResponse(true);assert.throws(()=>executeRequest(f.c,f.req));const agent=roster(f.c)[0];f.terminals.clear();const original=f.c.run;f.c.run=()=>{throw Error('Core temporarily unavailable');};assert.throws(()=>retryDirect(f.c,agent.id));assert.equal(pendingRegistrations(f.c).length,1);f.c.run=original;assert.equal(retryDirect(f.c,agent.id).restarted,false);assert.equal(pendingRegistrations(f.c).length,0);assert.equal(f.calls.filter(a=>a[0]==='run').length,1);assert(!f.calls.some(a=>a[0]==='keys'));
});
test('a worker pending folder trust registers without pretending its first task was delivered',t=>{
 const f=fixture(t);f.setFirstSent(false);const made=executeRequest(f.c,f.req);assert(made.registered);assert.equal(made.first_message.sent,false);const binding=directTerminal(f.c,'tworker').binding;assert.equal(binding.ownerAwaitingReply,false);enqueueDirect(f.c,made.agentId,'Wait for user',randomUUID());assert.equal(drainDirect(f.c).reason,'agent_not_ready');assert(!f.calls.some(a=>a[0]==='send'||a[0]==='keys'));
});
test('legacy children automatically join once without replaying tasks, while removed members never resurrect',t=>{
 const f=fixture(t);const t1={address:'told',cwd:f.c.cwd,parent:'towner',state:'live',status:{app:'codex',state:'done'},labels:{'team.owner':'towner','team.chat':'chat'}};f.terminals.set('told',t1);fs.writeFileSync(path.join(f.c.teamDir,'worker-bindings.json'),JSON.stringify({told:{owner:'towner',chat:'chat',name:'舊核對員'}}));assert.equal(reconcileWorkerMembers(f.c).registered,1);const id=roster(f.c)[0].id;assert.equal(reconcileWorkerMembers(f.c).registered,0);assert.equal(roster(f.c).length,1);saveRoster(f.c,[]);assert.equal(reconcileWorkerMembers(f.c).registered,0);assert.equal(roster(f.c).length,0);assert(!f.calls.some(a=>a[0]==='run'||a[0]==='send'));
});
test('new launch limits, foreign callers and mismatched recovered terminals fail before any duplicate launch',t=>{
 const f=fixture(t);saveRoster(f.c,Array.from({length:24},(_,i)=>({id:'member-'+i,name:'成員'+i,provider:'codex',level:'worker'})));assert.throws(()=>executeRequest(f.c,f.req),/24/);assert(!f.calls.some(a=>a[0]==='run'));assert.throws(()=>executeRequest(f.c,{...f.req,sender:'tforeign'}),/active coordinator/);
 saveRoster(f.c,[]);f.setLostResponse(true);assert.throws(()=>executeRequest(f.c,f.req));f.terminals.get('tworker').parent='tforeign';assert.equal(reconcileWorkerMembers(f.c).registered,0);assert.equal(pendingRegistrations(f.c).length,1);assert.equal(f.calls.filter(a=>a[0]==='run').length,1);
});
test('subdirectory workers retain their sandbox cwd and use project-scoped metadata for later direct messages',t=>{
 const f=fixture(t),child=path.join(f.root,'child');fs.mkdirSync(child);f.req.args.cwd='child';const made=executeRequest(f.c,f.req);assert(made.registered);assert.equal(f.terminals.get('tworker').cwd,child);assert.equal(f.terminals.get('tworker').labels['team.project'],f.root);f.terminals.get('tworker').status.state='done';captureReply(event('codex','First task done','owner-turn'),{...f.c,terminal:'tworker'},'Codex');enqueueDirect(f.c,made.agentId,'Next task',randomUUID());assert.equal(drainDirect(f.c).terminal,'tworker');assert(f.calls.findLast(a=>a[0]==='send')[2].includes('專案根目錄：'+f.root));assert.equal(f.calls.filter(a=>a[0]==='run').length,1);
});


test('MiniMax native Stop locates a registered subdirectory worker without broadening its workspace',async t=>{
 const f=fixture(t,'minimax'),child=path.join(f.root,'child');fs.mkdirSync(child);f.req.args.cwd='child';const made=executeRequest(f.c,f.req);f.terminals.get('tworker').status.state='done';
 const {minimaxReply}=await import('./minimax-reply.mjs');const event={hook_event_name:'Stop',session_id:'mini-child-session',turn_id:'first',cwd:child,last_assistant_message:'算術結果'};assert(minimaxReply(event,f.home,f.run).captured);
 assert.equal(read(path.join(f.c.teamDir,'direct-bindings.json')).tworker.ownerAwaitingReply,false);assert.equal(roster(f.c)[0].id,made.agentId);
});

test('Antigravity validates its real subdirectory workspace before reading the final transcript',async t=>{
 const f=fixture(t,'antigravity'),child=path.join(f.root,'child');fs.mkdirSync(child);f.req.args.cwd='child';executeRequest(f.c,f.req);f.terminals.get('tworker').status.state='done';
 const {agyReply}=await import('./agy-reply.mjs'),conversationId=randomUUID(),brain=path.join(f.root,'brain'),logs=path.join(brain,conversationId,'.system_generated/logs');fs.mkdirSync(logs,{recursive:true});const transcriptPath=path.join(logs,'transcript.jsonl');fs.writeFileSync(transcriptPath,[{type:'USER_INPUT',content:'核對'},{source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',content:'10+17=27'}].map(JSON.stringify).join('\n'));
 const event={fullyIdle:true,terminationReason:'model_stop',conversationId,workspacePaths:[child],transcriptPath,executionNum:1};assert.equal(agyReply({...event,workspacePaths:[f.root]},{...f.c,terminal:'tworker'},brain).reason,'workspace_mismatch');assert(agyReply(event,{...f.c,terminal:'tworker'},brain).captured);
});

for(const provider of ['claude','codex','minimax','antigravity'])test(`${provider} fast first reply survives a lost launch response before background registration`,t=>{
 const f=fixture(t,provider);f.setLostResponse(true);assert.throws(()=>executeRequest(f.c,f.req));f.terminals.get('tworker').status.state='done';
 const role={claude:'Claude',codex:'Codex',minimax:'MiniMax',antigravity:'Antigravity'}[provider];assert(captureReply(event(provider,'First result captured','early-turn'),{...f.c,terminal:'tworker'},role).captured);assert.equal(reconcileWorkerMembers(f.c).registered,1);const agent=roster(f.c)[0];assert.equal(directTerminal(f.c,'tworker').binding.ownerAwaitingReply,false);enqueueDirect(f.c,agent.id,'Next direct task',randomUUID());assert.equal(drainDirect(f.c).terminal,'tworker');assert.equal(f.calls.filter(a=>a[0]==='run').length,1);
});
test('MiniMax early native Stop recovers the true worker and preserves its session through registration',async t=>{
 const f=fixture(t,'minimax');f.setLostResponse(true);assert.throws(()=>executeRequest(f.c,f.req));f.terminals.get('tworker').status.state='done';const {minimaxReply}=await import('./minimax-reply.mjs');
 assert(minimaxReply({hook_event_name:'Stop',session_id:'early-mini',turn_id:'first',cwd:f.root,last_assistant_message:'算術結果'},f.home,f.run).captured);assert.equal(reconcileWorkerMembers(f.c).registered,1);assert.equal(directTerminal(f.c,'tworker').binding.minimaxSessionId,'early-mini');
});


test('manual and delegated members share name validation while unchanged legacy duplicates stay intact',t=>{
 const f=fixture(t);saveRoster(f.c,[{id:'one',name:'核對員',provider:'codex',level:'worker'}]);assert.throws(()=>saveRoster(f.c,[...roster(f.c),{id:'two',name:'核對員',provider:'claude',level:'worker'}]),/同名/);f.req.args.displayName='核對員';assert.throws(()=>executeRequest(f.c,f.req),/同名/);assert(!f.calls.some(a=>a[0]==='run'));
 fs.writeFileSync(path.join(f.c.teamBase,'roster.json'),JSON.stringify([{id:'one',name:'舊同名',provider:'codex',level:'worker'},{id:'two',name:'舊同名',provider:'claude',level:'worker'}]));saveRoster(f.c,roster(f.c));assert.deepEqual(roster(f.c).map(a=>a.name),['舊同名','舊同名']);
});


test('adding a worker preserves private custom fields on existing members without exposing them as runtime attributes',t=>{
 const f=fixture(t),file=path.join(f.c.teamBase,'roster.json');fs.writeFileSync(file,JSON.stringify([{id:'existing',name:'既有成員',provider:'claude',model:'claude-fable-5-2',level:'worker',brief:'保留職責',localPreference:{color:'cream'}}]));const made=executeRequest(f.c,f.req);assert(made.registered);const existing=read(file).find(a=>a.id==='existing');assert.deepEqual(existing.localPreference,{color:'cream'});assert.equal(existing.model,'claude-fable-5-2');assert.equal(roster(f.c).find(a=>a.id==='existing').localPreference,undefined);
});


test('legacy launch refuses an existing direct member in another chat instead of creating a duplicate',t=>{
 const f=fixture(t);saveRoster(f.c,[{id:'engineer',name:'工程師',provider:'codex',level:'worker'}]);f.req.args.agentId='engineer';delete f.req.args.template;
 f.terminals.set('totherchat',{address:'totherchat',cwd:f.root,parent:null,state:'live',status:{app:'codex',state:'done'},labels:{'team.direct':'true','team.agent':'engineer','team.chat':'old-chat'}});assert.throws(()=>executeRequest(f.c,f.req),/already has a live/);assert(!f.calls.some(a=>a[0]==='run'));
});


test('new Claude members share the manual Opus default while existing unset preferences are preserved',t=>{
 const f=fixture(t,'claude');fs.writeFileSync(path.join(f.c.teamDir,'model.json'),JSON.stringify({model:'claude-fable-5-2'}));const made=executeRequest(f.c,f.req);assert.equal(roster(f.c).find(a=>a.id===made.agentId).model,'claude-opus-5-5');
 const file=path.join(f.c.teamBase,'roster.json'),old={id:'legacy-member',name:'舊設定',provider:'claude',level:'worker'};const all=read(file);all.push(old);fs.writeFileSync(file,JSON.stringify(all));saveRoster(f.c,roster(f.c));assert.equal(roster(f.c).find(a=>a.id===old.id).model,undefined);
});


test('registration preserves a newly selected engine while the original process is still busy, without launching a duplicate',t=>{
 const f=fixture(t);f.setLostResponse(true);assert.throws(()=>executeRequest(f.c,f.req));const agent=roster(f.c)[0];saveRoster(f.c,roster(f.c).map(a=>({...a,provider:'claude',model:'claude-fable-5-2'})));assert.equal(reconcileWorkerMembers(f.c).registered,1);assert.equal(roster(f.c)[0].provider,'claude');assert.equal(roster(f.c)[0].model,'claude-fable-5-2');assert.equal(directTerminal(f.c,'tworker').binding.provider,'codex');enqueueDirect(f.c,agent.id,'Later work',randomUUID());assert.equal(drainDirect(f.c).reason,'waiting_engine_switch');assert.equal(f.calls.filter(a=>a[0]==='run').length,1);assert(!f.calls.some(a=>a[0]==='kill'));
});
