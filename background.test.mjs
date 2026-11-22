import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {context,saveRoster,roster,enqueueChat,drainChats,setCoordinatorName,coordinatorProfile,captureReply,retryStartup,register} from './team-runtime.mjs';
import {deploymentPlan,applyDeployment,mergeProjects} from './setup.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-headless-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const project=path.join(root,"project space's");fs.mkdirSync(project);return{root,project};}
test('Drive project files and private runtime state remain separate, with project-scoped names and rosters',t=>{
 const {root,project}=fixture(t),config={headless:true,stateRoot:path.join(root,'private-state')};
 const c=context(project,null,()=>{throw Error('No actual core');},'unit-chat',config);saveRoster(c,[]);setCoordinatorName(c,'牧羊人總控');
 assert.equal(coordinatorProfile(context(project,null,null,'another-chat',config)).name,'牧羊人總控');assert.deepEqual(roster(c),[]);
 assert(!fs.existsSync(path.join(project,'.herdr-team')));assert(c.teamDir.startsWith(config.stateRoot+path.sep));assert.throws(()=>setCoordinatorName(c,'\n'),/名稱/);
 const other=path.join(root,'other');fs.mkdirSync(other);assert.equal(coordinatorProfile(context(other,null,null,null,config)).name,'領頭羊');
});
test('background chat starts core directly, waits for idle, and sends the same queued task only once',t=>{
 const {root,project}=fixture(t),calls=[];let ready=false;
 const run=(cmd,args)=>{calls.push([cmd,args]);assert.equal(cmd,'hc','desktop app must never be invoked');if(args[0]==='run')return{address:'tunitowner'};if(args[0]==='get')return{address:'tunitowner',state:'live',foreground:{argv:['claude']},status:{app:'claude-code',state:ready?'idle':'working'}};if(args[0]==='send')return{started:true};throw Error(args.join(' '));};
 const c=context(project,null,run,'unit-chat',{headless:true,stateRoot:path.join(root,'private-state')});enqueueChat(c,'Unit fixture only; never run a real agent');
 assert.equal(drainChats(c).reason,'starting');assert.equal(drainChats(c).reason,'working');ready=true;assert.equal(drainChats(c).sent,1);assert.equal(drainChats(c).pending,0);
 assert.equal(calls.filter(([,a])=>a[0]==='run').length,1);assert.equal(calls.filter(([,a])=>a[0]==='send').length,1);assert(!fs.existsSync(path.join(project,'.herdr-team')));
});
test('lost launch responses and a restart mid-launch preserve the message without creating duplicate coordinators',t=>{
 const {root,project}=fixture(t);let launches=0;
 const c=context(project,null,(_cmd,args)=>{assert.equal(args[0],'run');launches++;throw Error('Core response timed out');},'unit-chat',{headless:true,stateRoot:path.join(root,'private')});
 const message=enqueueChat(c,'Preserve this message until the real launch is verified');
 assert.equal(drainChats(c).reason,'startup_uncertain');
 for(let n=0;n<3;n++)assert.equal(drainChats(c).reason,'startup_uncertain');
 assert.equal(launches,1);assert(fs.existsSync(path.join(c.teamDir,'chat-queue',message.id+'.json')));
 const file=path.join(c.teamDir,'control.json'),current=JSON.parse(fs.readFileSync(file));
 fs.writeFileSync(file,JSON.stringify({...current,phase:undefined}));
 assert.equal(drainChats(c).reason,'startup_uncertain');assert.equal(launches,1);
});
test('a real coordinator registration recovers a lost launch response without a second launch or message loss',t=>{
 const {root,project}=fixture(t);let launches=0;
 const config={headless:true,stateRoot:path.join(root,'private')};let c;
 c=context(project,null,(_cmd,args)=>{if(args[0]==='run'){launches++;register({...c,terminal:'tregistered'},'claude');throw Error('response lost after registration');}if(args[0]==='get')return{address:'tregistered',state:'live',status:{app:'claude-code',state:'idle'}};if(args[0]==='send')return{ok:true};throw Error(args.join(' '));},'unit-chat',config);
 enqueueChat(c,'Original pending message');assert.equal(drainChats(c).reason,'starting');assert.equal(drainChats(c).sent,1);assert.equal(launches,1);
});
test('deployment plan is read-only; apply preserves previous settings and handles quoted paths',t=>{
 const {root,project}=fixture(t),home=path.join(root,"app's home"),bin=path.join(root,'bin');
 const input={home,bin,core:path.join(root,'core'),antigravityHooks:path.join(root,'google/hooks.json'),minimaxHooks:path.join(root,'minimax/hooks.json'),launchAgents:path.join(root,'agents'),origin:'https://unit.tail.test',login:'owner@example.test',projectRoot:project};
 const tools=Object.fromEntries(['node','hc','claude','codex','mcode'].map(n=>[n,path.join(bin,n)]));const plan=deploymentPlan(input,tools);assert(!fs.existsSync(home));
 const backup=applyDeployment(plan);assert(fs.existsSync(path.join(backup,'manifest.json')));const runtime=fs.readFileSync(path.join(bin,'herdr-team-runtime'),'utf8');assert(runtime.includes('HERDR_WORKBENCH_HOME='));assert(!runtime.includes('@NODE_SHELL@'));
 const file=path.join(home,'web/config.json');fs.writeFileSync(file,'{"keep":"fixture"}');const saved=applyDeployment(plan),manifest=JSON.parse(fs.readFileSync(path.join(saved,'manifest.json')));const item=manifest.files.find(x=>x.target===file);assert.equal(fs.readFileSync(item.backup,'utf8'),'{"keep":"fixture"}');
 assert.throws(()=>deploymentPlan({...input,origin:'http://unit.test'},tools),/HTTPS/);
});

test('migration merges desktop and web chats without losing existing workbench conversations',t=>{
 const {project}=fixture(t);
 const merged=mergeProjects([[{folder:project,name:'Current',chats:[{id:'new-chat',createdAt:3}]}],[{folder:project,name:'Desktop',chats:[{id:'old-chat',createdAt:1},{id:'second-chat',createdAt:2}]}],[{folder:project,name:'Stale web',chats:[{id:'old-chat',createdAt:1}]}]]);
 assert.equal(merged.length,1);assert.equal(merged[0].name,'Current');assert.deepEqual(merged[0].chats.map(c=>c.id),['old-chat','second-chat','new-chat']);
});
test('worker notifications only report to the registered real parent and reject duplicates or foreign workers',t=>{
 const {root,project}=fixture(t),config={headless:true,stateRoot:path.join(root,'private')};
 const c=context(project,'tunitworker',()=>({parent:'tunitowner',turn:1,labels:{'team.owner':'tunitowner','team.chat':'unit-chat'}}),'unit-chat',config);
 fs.mkdirSync(c.teamDir,{recursive:true});fs.writeFileSync(path.join(c.teamDir,'control.json'),JSON.stringify({terminal:'tunitowner'}));
 fs.writeFileSync(path.join(c.teamDir,'worker-bindings.json'),JSON.stringify({tunitworker:{owner:'tunitowner',chat:'unit-chat',name:'Codex',sentAt:Date.now()-1000}}));
 const event={type:'agent-turn-complete','turn-id':'unit-turn','last-assistant-message':'Unit result: 55'};
 assert.equal(captureReply({...event,'last-assistant-message':'{"title":"Session title"}'},c,'Codex').reason,'session_title_metadata');
 assert.equal(captureReply(event,c,'Codex').captured,true);assert.equal(captureReply(event,c,'Codex').reason,'duplicate');
 assert.equal(fs.readdirSync(path.join(c.teamDir,'outbox')).length,1);
 assert.equal(captureReply({...event,'turn-id':'next-turn','last-assistant-message':'{"sum":55}'},c,'Codex').captured,true);
 assert.equal(fs.readdirSync(path.join(c.teamDir,'outbox')).length,2);
 fs.appendFileSync(path.join(c.teamDir,'messages.jsonl'),JSON.stringify({terminal:c.terminal,kind:'worker-report',time:new Date().toISOString(),text:'Manual report'})+'\n');
 assert.equal(captureReply({...event,'turn-id':'manual-turn'},c,'Codex').reason,'explicit_report_already_sent');
 const foreign={...c,terminal:'tunitforeign'};assert.equal(captureReply(event,foreign,'Codex').reason,'unregistered_worker');
 const tampered={...c,run:()=>({parent:'tunitother',labels:{}})};assert.equal(captureReply({...event,'turn-id':'other-turn'},tampered,'Codex').reason,'foreign_worker');
});
test('message retries reuse durable queue identity across restarts and reject different payloads',t=>{
 const {root,project}=fixture(t),config={headless:true,stateRoot:path.join(root,'private')};
 const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',c=context(project,null,null,'unit-chat',config);
 const first=enqueueChat(c,'Unit retry fixture',id),restarted=context(project,null,null,'unit-chat',config);
 assert.deepEqual(enqueueChat(restarted,'Unit retry fixture',id),first);
 const queue=path.join(c.teamDir,'chat-queue');assert.equal(fs.readdirSync(queue).length,1);
 fs.renameSync(path.join(queue,id+'.json'),path.join(queue,id+'.json.sent'));
 assert.deepEqual(enqueueChat(restarted,'Unit retry fixture',id),first);
 assert.throws(()=>enqueueChat(restarted,'Different task',id),/其他內容/);
 assert.equal(fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').length,1);
});

test('queued tasks use the latest project roster at delivery, and never silently change a removed recipient',t=>{
 const {root,project}=fixture(t),calls=[],config={headless:true,stateRoot:path.join(root,'private')};
 const run=(cmd,args)=>{assert.equal(cmd,'hc');calls.push(args);if(args[0]==='get')return{address:'tunitowner',state:'live',foreground:{argv:['claude']},status:{app:'claude-code',state:'idle'}};if(args[0]==='send')return{started:true};throw Error(args.join(' '));};
 const c=context(project,null,run,'unit-chat',config);fs.mkdirSync(c.teamDir,{recursive:true});fs.writeFileSync(path.join(c.teamDir,'control.json'),JSON.stringify({terminal:'tunitowner',startedAt:Date.now()}));
 enqueueChat(c,'Unit fixture queued before members were added');
 saveRoster(c,[{id:'engineer',name:'工程師',provider:'codex',level:'worker',group:'',brief:'檢查成果'}]);
 assert.equal(drainChats(c).sent,1);const delivered=calls.find(a=>a[0]==='send')[2];assert(delivered.includes('工程師'));assert(delivered.includes('檢查成果'));assert(delivered.includes('queued 不是成功'));
 fs.rmSync(path.join(c.teamBase,'chat-delivery.json'));
 enqueueChat(c,'@engineer Unit fixture for an explicitly selected role');saveRoster(c,[]);
 assert.equal(drainChats(c).sent,0);assert.equal(calls.filter(a=>a[0]==='send').length,1);assert.equal(fs.readdirSync(path.join(c.teamDir,'chat-queue')).filter(n=>n.endsWith('.json')).length,1);
});

test('startup exit does not auto-reopen permission prompts; reopening requires an explicit request',async t=>{
 const {root,project}=fixture(t);let starts=0,finished=true;
 const c=context(project,null,(cmd,args)=>{assert.equal(cmd,'hc');if(args[0]==='get')return{address:'tunitold',state:finished?'finished':'live',status:null};if(args[0]==='run'){starts++;return{address:'tunitnew'};}throw Error(args.join(' '));},'unit-chat',{headless:true,stateRoot:path.join(root,'private')});
 enqueueChat(c,'Unit startup fixture; no real agents');fs.writeFileSync(path.join(c.teamDir,'control.json'),JSON.stringify({terminal:'tunitold',role:'claude',phase:'active',startedAt:Date.now()}));
 for(let i=0;i<3;i++)assert.equal(drainChats(c).reason,'startup_stopped');assert.equal(starts,0);
 finished=false;await assert.rejects(()=>retryStartup(c),/仍在執行/);finished=true;
 assert.equal((await retryStartup(c)).queued,true);assert.equal(drainChats(c).reason,'starting');assert.equal(starts,1);
});

test('a removed coordinator preserves queued messages and resumes only after explicit retry; core failures never authorize replacement',async t=>{
 const {root,project}=fixture(t);let starts=0,missing=true,unavailable=false;
 const c=context(project,null,(_cmd,args)=>{if(args[0]==='get'){if(unavailable)throw Error('core transport offline');if(missing)throw Object.assign(Error('removed'),{stdout:JSON.stringify({error:{kind:'not_found'}})});return{address:'tunitnew',state:'live',status:{app:'claude-code',state:'idle'}};}if(args[0]==='run'){starts++;missing=false;return{address:'tunitnew'};}if(args[0]==='send')return{ok:true};throw Error(args.join(' '));},'unit-chat',{headless:true,stateRoot:path.join(root,'private')});
 enqueueChat(c,'Existing queued message');fs.writeFileSync(path.join(c.teamDir,'control.json'),JSON.stringify({terminal:'tunitremoved',role:'claude',phase:'active',sessionId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}));
 assert.equal(drainChats(c).reason,'coordinator_unavailable');assert.equal(starts,0);
 unavailable=true;await assert.rejects(()=>retryStartup(c),/transport/);assert.equal(drainChats(c).sent,0);unavailable=false;
 await retryStartup(c);assert.equal(drainChats(c).reason,'starting');assert.equal(starts,1);assert.equal(drainChats(c).sent,1);assert.equal(drainChats(c).sent,0);
});

test('replacement registration requires explicit retry and its own real project terminal',t=>{
 const {root,project}=fixture(t);let wrongFolder=false;const c=context(project,'tunitreplacement',(_cmd,args)=>{if(args[1]==='tunitold')throw Object.assign(Error('removed'),{stderr:JSON.stringify({error:{kind:'not_found'}})});return{address:'tunitreplacement',state:'live',cwd:wrongFolder?root:fs.realpathSync(project)};},'unit-chat',{headless:true,stateRoot:path.join(root,'private')});
 fs.mkdirSync(c.teamDir,{recursive:true});const file=path.join(c.teamDir,'control.json');fs.writeFileSync(file,JSON.stringify({terminal:'tunitold',phase:'active'}));assert.throws(()=>register(c,'claude'),/Cannot verify/);
 fs.writeFileSync(file,JSON.stringify({terminal:'tunitold',phase:'retry_requested'}));wrongFolder=true;assert.throws(()=>register(c,'claude'),/real local/);wrongFolder=false;assert.equal(register(c,'claude').terminal,'tunitreplacement');
});

test('a saved Codex preference waits for the Claude owner and its active workers before delivering in the same chat',t=>{
 const {root,project}=fixture(t),calls=[];let oldState='working',workerState='working',closed=false;
 const c=context(project,null,(_cmd,args)=>{
  calls.push(args);
  if(args[0]==='get'&&args[1]==='told')return{cwd:fs.realpathSync(project),state:closed?'finished':'live',status:{app:'claude-code',state:oldState}};
  if(args[0]==='get'&&args[1]==='tworker')return{parent:'told',state:'live',status:{state:workerState}};
  if(args[0]==='get'&&args[1]==='tcodex')return{cwd:project,state:'live',status:{app:'codex',state:'idle'}};
  if(args[0]==='ls')return{terminals:[{address:'tworker'}]};
  if(args[0]==='kill'){assert.equal(args[1],'told');closed=true;return{ok:true};}
  if(args[0]==='run'){assert(args.includes('--team-preferred'));assert(args.some(x=>x.endsWith('/herdr-team-backup')));return{address:'tcodex'};}
  if(args[0]==='send'){assert.equal(args[1],'tcodex');assert.match(args[2],/Same conversation/);return{ok:true};}
  assert.fail('Unexpected call '+args[0]);
 },'unit-chat',{headless:true,stateRoot:path.join(root,'private')});
 enqueueChat(c,'Same conversation');const controlFile=path.join(c.teamDir,'control.json'),messages=path.join(c.teamDir,'messages.jsonl'),before=fs.readFileSync(messages,'utf8');
 fs.writeFileSync(controlFile,JSON.stringify({terminal:'told',role:'claude',phase:'active',sessionId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}));
 assert.throws(()=>setCoordinatorName(c,'領頭羊','unknown'),/引擎/);
 assert.equal(setCoordinatorName(c,'領頭羊','codex').provider,'codex');assert.equal(calls.length,0);
 assert.equal(drainChats(c).reason,'waiting_engine_switch');
 oldState='done';assert.equal(drainChats(c).reason,'waiting_engine_switch');assert.equal(closed,false);
 workerState='done';assert.equal(drainChats(c).reason,'starting');assert.equal(closed,true);
 const control=JSON.parse(fs.readFileSync(controlFile));assert.equal(control.role,'codex');assert.equal(control.sessionId,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
 assert.equal(drainChats(c).sent,1);assert(fs.readFileSync(messages,'utf8').startsWith(before));
 assert.equal(calls.filter(args=>args[0]==='run').length,1);assert.equal(calls.filter(args=>args[0]==='send').length,1);
});
