import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {context,saveRoster,captureReply,switchAgentModel,roster,appointAgent,enqueueChat,drainChats} from './team-runtime.mjs';import {enqueueDirect,drainDirect,collaborate,drainCollaboration,directReply,retryDirect} from './direct.mjs';import {agyReply} from './agy-reply.mjs';import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {minimaxReply} from './minimax-reply.mjs';
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'herdr-direct-unit-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const c=context(root,null,null,'unit-chat',{headless:true,stateRoot:path.join(root,'private')});saveRoster(c,[{id:'engineer',name:'Engineer',provider:'codex',level:'worker'}]);return{c,root};}
for(const direct of [false,true])test(`only the ${direct?'appointed':'legacy'} leader can provision one specialist for an authorized message and verify its report`,t=>{
 const {c}=fixture(t),leader='tunitlead',worker='tunitworker',messageId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 const cases={
  [leader]:{app:'claude-code',state:'idle',labels:direct?{'team.direct':'true','team.chat':c.chat,'team.agent':'engineer'}:{}},
 };
 const sent=[];
 c.run=(_cmd,[verb,id,...args])=>{
  if(verb==='get')return{address:id,cwd:c.cwd,state:'live',parent:null,status:{app:cases[id].app,state:cases[id].state},labels:cases[id].labels};
  if(verb==='send'){sent.push({id,text:args[0]});return{ok:true};}
  if(verb==='read')return{text:'Verified answer: 42'};
  if(verb==='run'){
   assert.equal(cases[worker],undefined);
   assert(args.at(-1).endsWith('/herdr-team-codex'));
   const agent=roster(c).find(a=>a.name==='Arithmetic checker');
   assert(args.includes('team.agent='+agent.id));
   cases[worker]={app:'codex',state:'blocked',labels:{'team.direct':'true','team.chat':c.chat,'team.agent':agent.id}};
   return{address:worker};
  }
  assert.fail('Unexpected Core command: '+verb);
 };
 const current={...c,terminal:leader},jobFile=path.join(c.teamDir,'collaborations.json');
 const request=(name,message=messageId)=>'<herdr-action>'+JSON.stringify({action:'create-agent-and-delegate',messageId:message,name,provider:'codex',brief:'Check small calculations independently',task:'Compute 21+21',acceptance:'Report the result as 42'})+'</herdr-action>';
 const reply=text=>captureReply({hook_event_name:'Stop',last_assistant_message:text},current,'Claude');
 fs.mkdirSync(c.teamDir,{recursive:true});
 if(direct){
  assert.throws(()=>enqueueDirect(c,'engineer','No authorization for worker',messageId,true),/領頭羊/);
  saveRoster(c,roster(c).map(agent=>({...agent,provider:'claude'})));
  appointAgent(c,'engineer');
  fs.writeFileSync(path.join(c.teamDir,'direct-bindings.json'),JSON.stringify({[leader]:{agentId:'engineer',provider:'claude',chat:c.chat}}));
 }else fs.writeFileSync(path.join(c.teamDir,'control.json'),JSON.stringify({terminal:leader}));
 assert.throws(()=>collaborate(current,{action:'create-agent-and-delegate',messageId}),/開啟新增代理/);
 reply(request('Unauthorized specialist'));
 assert.equal(fs.existsSync(jobFile),false);
 if(direct){enqueueDirect(c,'engineer','Hire one arithmetic checker',messageId,true);assert.equal(drainDirect(c).sent,1);}
 else{enqueueChat(c,'Hire one arithmetic checker',messageId,true);assert.equal(drainChats(c).sent,1);}
 assert(sent.at(-1).text.includes(messageId));
 reply('我會安排核對。\n'+request('Arithmetic checker')+'\n'+request('Too many'));
 const jobs=()=>Object.values(JSON.parse(fs.readFileSync(jobFile,'utf8'))),job=()=>jobs()[0];
 assert.equal(jobs().length,1);assert.equal(job().status,'provisioning');assert.equal(roster(c).length,1);
 reply(request('Replayed request'));
 assert.equal(drainDirect(c).started,worker);
 assert.equal(jobs().length,1);
 assert.match(roster(c).find(a=>a.id===job().targetAgent).brief,/independently/);
 assert.equal(job().status,'queued');
 assert.equal(drainDirect(c).reason,'agent_not_ready');
 assert.equal(sent.length,1);
 cases[worker].state='idle';assert.equal(drainDirect(c).sent,1);
 assert(sent.at(-1).text.includes('Report the result as 42'));assert(sent.at(-1).text.includes('本則訊息沒有新增代理的授權'));
 assert.equal(job().status,'working');
 directReply({...c,terminal:worker},'Verified answer: 42\n'+request('Unauthorized child'),'worker-result');
 assert.equal(jobs().length,1);assert.equal(job().status,'awaiting_review');
 assert.throws(()=>collaborate(current,{action:'accept',id:job().id,revision:job().revision,verification:'Verified the arithmetic'}),/終端核對/);
 assert.equal(drainCollaboration(c).sent,1);assert.equal(sent.at(-1).id,leader);
 reply('驗收完成。\n<herdr-action>'+JSON.stringify({action:'accept',id:job().id,revision:job().revision,verification:'Verified that 21+21 equals 42',evidence:[]})+'</herdr-action>');
 assert.equal(job().status,'done');assert.equal(job().evidence[0].type,'terminal-read');
 assert.equal(roster(c).length,2);
});
test('direct conversation starts its selected engine once, needs no coordinator, and reuses its session',t=>{
 const {c}=fixture(t),calls=[],terminals=[];let state='idle';
 c.run=(_cmd,args)=>{calls.push(args);if(args[0]==='ls')return{terminals};if(args[0]==='run'){assert(args.at(-1).endsWith('/herdr-team-codex'));assert(!args.includes('herdr-codex-implement'));assert(args.includes('--no-parent'));terminals.push({address:'tunitdirect'});return{address:'tunitdirect'};}if(args[0]==='get')return{address:args[1],cwd:c.cwd,parent:null,state:'live',status:{app:'codex',state},labels:{'team.direct':'true','team.agent':'engineer','team.chat':c.chat}};if(args[0]==='send')return{ok:true};throw Error('Unexpected command');};
 const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';enqueueDirect(c,'engineer','Hello',id);assert.equal(drainDirect(c).started,'tunitdirect');assert.equal(drainDirect(c).sent,1);
 assert(!fs.existsSync(path.join(c.teamDir,'control.json')));assert.equal(calls.filter(a=>a[0]==='run').length,1);assert.equal(calls.filter(a=>a[0]==='send')[0][1],'tunitdirect');
 assert.throws(()=>enqueueDirect(c,'engineer','Different',id),/ID/);assert.throws(()=>enqueueDirect(c,'missing','Hello',id),/代理/);
 const worker={...c,terminal:'tunitdirect'},event={type:'agent-turn-complete','turn-id':'first','last-assistant-message':'Hello from the engineer'};
 assert.equal(captureReply(event,worker,'Codex').direct,true);assert.equal(captureReply(event,worker,'Codex').reason,'duplicate');
 const lines=fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert(lines.some(e=>e.kind==='reply'&&e.target==='engineer'&&e.direct));
 enqueueDirect(c,'engineer','Second question','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');fs.unlinkSync(path.join(c.teamDir,'direct-delivery.json'));state='working';assert.equal(drainDirect(c).reason,'agent_not_ready');state='idle';assert.equal(drainDirect(c).sent,1);assert.equal(calls.filter(a=>a[0]==='run').length,1);
});
test('agents delegate in each other conversations, reject queued acceptance, revise, inspect real replies, and accept verified evidence',t=>{
 const {c}=fixture(t);saveRoster(c,[{id:'engineer',name:'Engineer',provider:'codex',level:'worker'},{id:'reviewer',name:'Reviewer',provider:'claude',level:'worker'}]);
 fs.mkdirSync(c.teamDir,{recursive:true});const bindings={tunitengineer:{agentId:'engineer',provider:'codex',chat:c.chat},tunitreviewer:{agentId:'reviewer',provider:'claude',chat:c.chat}};
 fs.writeFileSync(path.join(c.teamDir,'direct-bindings.json'),JSON.stringify(bindings));let screen='Injected result: 41';const sent=[];
 c.terminal='tunitengineer';c.run=(_cmd,args)=>{if(args[0]==='ls')return{terminals:Object.keys(bindings).map(address=>({address}))};if(args[0]==='get')return{address:args[1],cwd:c.cwd,parent:null,state:'live',status:{app:'unit',state:'idle'},labels:{'team.direct':'true','team.agent':bindings[args[1]].agentId,'team.chat':c.chat}};if(args[0]==='send'){sent.push(args);return{ok:true};}if(args[0]==='read')return{text:screen};throw Error('Unexpected operation');};
 const queued=collaborate(c,{action:'delegate',agentId:'reviewer',task:'Return 42; first round inject 41',acceptance:'Final verified number must be 42'}),file=path.join(c.teamDir,'collaborations.json'),job=()=>JSON.parse(fs.readFileSync(file))[queued.id];
 assert.throws(()=>collaborate(c,{action:'accept',id:queued.id,revision:1,verification:'Not yet verified'}),/真實回報/);
 assert.equal(drainDirect(c).sent,1);assert.equal(sent[0][1],'tunitreviewer');const worker={...c,terminal:'tunitreviewer'};directReply(worker,'Injected result: 41','first');assert.equal(job().status,'awaiting_review');
 assert.equal(drainCollaboration(c).sent,1);assert.equal(sent.at(-1)[1],'tunitengineer');assert.equal(drainCollaboration(c).sent,0);assert(job().replyReadHash);
 assert.throws(()=>collaborate(c,{action:'accept',id:queued.id,revision:1,verification:'Stale acceptance'}),/版本/);
 collaborate(c,{action:'revise',id:queued.id,revision:job().revision,feedback:'41 is wrong; return 42'});fs.unlinkSync(path.join(c.teamDir,'direct-delivery.json'));assert.equal(drainDirect(c).sent,1);screen='Correct result: 42';directReply(worker,screen,'second');assert.equal(drainCollaboration(c).sent,1);
 const artifact=path.join(c.cwd,'result.txt');fs.writeFileSync(artifact,'42');const sha256=createHash('sha256').update('42').digest('hex');
 assert.throws(()=>collaborate(c,{action:'accept',id:queued.id,revision:job().revision,verification:'Verified the final arithmetic',evidence:[{path:'result.txt',sha256:'bad'}]}),/雜湊/);
 assert.equal(collaborate(c,{action:'accept',id:queued.id,revision:job().revision,verification:'Verified terminal report and result.txt equal 42',evidence:[{path:'result.txt',sha256}]}).done,true);assert.equal(job().status,'done');
 assert.throws(()=>collaborate({...c,terminal:'tunitforeign'},{action:'delegate',agentId:'reviewer',task:'x',acceptance:'x'}),/registered/);
});
test('appointment preserves the selected engine; Claude model switches require a real CLI confirmation',async t=>{
 const {c}=fixture(t);const codex=appointAgent(c,'engineer');assert.equal(codex.provider,'codex');assert.equal(roster(c)[0].provider,'codex');assert.equal(roster(c)[0].model,undefined);
 saveRoster(c,roster(c).map(agent=>({...agent,provider:'claude'})));const claude=appointAgent(c,'engineer');assert.equal(claude.provider,'claude');assert.equal(roster(c)[0].model,'claude-opus-5-5');assert.equal(roster(c)[0].level,'manager');
 fs.mkdirSync(c.teamDir,{recursive:true});fs.writeFileSync(path.join(c.teamDir,'direct-bindings.json'),JSON.stringify({tunitdirect:{agentId:'engineer',chat:c.chat}}));let confirm=true;const calls=[];
 c.run=(_cmd,args)=>{calls.push(args);if(args[0]==='get')return{address:args[1],cwd:c.cwd,parent:null,state:'live',status:{app:'claude-code',state:'idle'},labels:{'team.direct':'true','team.agent':'engineer','team.chat':c.chat}};if(args[0]==='send')return{ok:true};if(args[0]==='read')return{text:confirm?'/model claude-fable-5-2\nSet model to Fable 5.2':'Permission confirmation required'};throw Error('No unexpected keys or real operation');};
 assert.equal((await switchAgentModel(c,'engineer','claude-fable-5-2',async()=>{})).applied,true);assert.equal(roster(c)[0].model,'claude-fable-5-2');confirm=false;
 await assert.rejects(()=>switchAgentModel(c,'engineer','claude-opus-5-5',async()=>{}),/尚未確認/);assert.equal(roster(c)[0].model,'claude-fable-5-2');assert(!calls.some(args=>args[0]==='keys'));
});
test('Antigravity official Stop hook captures only the final current bound conversation, never thoughts or tool calls',t=>{
 const {c,root}=fixture(t);const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',brain=path.join(root,'brain'),transcript=path.join(brain,id,'.system_generated/logs/transcript_full.jsonl');fs.mkdirSync(path.dirname(transcript),{recursive:true});
 fs.mkdirSync(c.teamDir,{recursive:true});fs.writeFileSync(path.join(c.teamDir,'direct-bindings.json'),JSON.stringify({tunitdirect:{agentId:'engineer',chat:c.chat}}));c.terminal='tunitdirect';c.run=()=>({cwd:c.cwd,parent:null,labels:{'team.direct':'true','team.agent':'engineer','team.chat':c.chat}});
 const event={conversationId:id,workspacePaths:[c.cwd],transcriptPath:transcript,terminationReason:'NO_TOOL_CALL',fullyIdle:true,executionNum:1};
 fs.writeFileSync(transcript,[{type:'USER_INPUT',content:'Question'},{source:'MODEL',type:'GENERIC',status:'DONE',content:'Private thought'},{source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',content:'Final answer'}].map(JSON.stringify).join('\n'));
 assert.equal(agyReply({...event,fullyIdle:false},c,brain).captured,false);assert.equal(agyReply({...event,transcriptPath:path.join(root,'other')},c,brain).captured,false);assert.equal(agyReply(event,c,brain).captured,true);assert.equal(agyReply(event,c,brain).reason,'duplicate');
 assert(!fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').includes('Private thought'));
 fs.writeFileSync(transcript,JSON.stringify({source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',content:'Thinking',tool_calls:[{}]}));assert.equal(agyReply({...event,executionNum:2},c,brain).captured,false);
});
test('two real isolated processes preserve both agent bindings and every concurrent reply',async t=>{
 const {c,root}=fixture(t);saveRoster(c,[{id:'engineer',name:'Engineer',provider:'codex',level:'worker'},{id:'reviewer',name:'Reviewer',provider:'claude',level:'worker'}]);fs.mkdirSync(c.teamDir,{recursive:true});
 fs.writeFileSync(path.join(c.teamDir,'direct-bindings.json'),JSON.stringify({tunita:{agentId:'engineer',chat:c.chat},tunitb:{agentId:'reviewer',chat:c.chat}}));
 const code=`import {context} from ${JSON.stringify(new URL('./team-runtime.mjs',import.meta.url).href)};import {directReply} from ${JSON.stringify(new URL('./direct.mjs',import.meta.url).href)};const [root,id,agent]=process.argv.slice(1);const c=context(root,id,()=>({cwd:root,parent:null,labels:{'team.direct':'true','team.agent':agent,'team.chat':'unit-chat'}}),'unit-chat',{headless:true,stateRoot:root+'/private'});for(let n=0;n<12;n++)directReply(c,agent+' result '+n,String(n));`;
 await Promise.all([['tunita','engineer'],['tunitb','reviewer']].map(([id,agent])=>promisify(execFile)(process.execPath,['--input-type=module','-e',code,root,id,agent])));
 const lines=fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(lines.length,24);assert.equal(lines.filter(e=>e.agentId==='engineer').length,12);assert.equal(lines.filter(e=>e.agentId==='reviewer').length,12);
 const bindings=JSON.parse(fs.readFileSync(path.join(c.teamDir,'direct-bindings.json')));assert(bindings.tunita.captureHash);assert(bindings.tunitb.captureHash);assert(!fs.existsSync(path.join(c.teamDir,'direct-state.lock')));
});
test('MiniMax native Stop without inherited Herdr environment binds only an unambiguous real terminal and hides correlation markers',t=>{
 const {c,root}=fixture(t),home=path.join(root,'host'),marker='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 saveRoster(c,[{id:'mini-one',name:'Mini one',provider:'minimax',level:'worker'},{id:'mini-two',name:'Mini two',provider:'minimax',level:'worker'}]);fs.mkdirSync(path.join(home,'web'),{recursive:true});fs.writeFileSync(path.join(home,'service.json'),JSON.stringify({appHome:home,headless:true,stateRoot:path.join(root,'private')}));fs.writeFileSync(path.join(home,'web/projects.json'),JSON.stringify([{folder:root}]));fs.mkdirSync(c.teamDir,{recursive:true});
 const file=path.join(c.teamDir,'direct-bindings.json'),bindings={tunitone:{agentId:'mini-one',provider:'minimax',chat:c.chat,awaitingReply:true,lastMessageId:marker},tunittwo:{agentId:'mini-two',provider:'minimax',chat:c.chat,awaitingReply:true,lastMessageId:other}};fs.writeFileSync(file,JSON.stringify(bindings));
 const run=(_cmd,args)=>args[0]==='get'?{cwd:root,parent:null,status:{app:'mcode',state:'done'},labels:{'team.direct':'true','team.chat':c.chat,'team.agent':bindings[args[1]].agentId}}:{text:'9 <herdr-reply-id>'+bindings[args[1]].lastMessageId+'</herdr-reply-id>'};
 const event={hook_event_name:'Stop',session_id:'unit-session',turn_id:'unit-turn',cwd:root,model:'MiniMax-M3.1-Flash',last_assistant_message:'9 <herdr-reply-id>'+marker+'</herdr-reply-id>'};
 assert.equal(minimaxReply(event,home,run).captured,true);assert.equal(minimaxReply(event,home,run).reason,'duplicate');
 const logs=fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(logs.length,1);assert.equal(logs[0].text,'9');assert.equal(logs[0].target,'mini-one');assert.equal(JSON.parse(fs.readFileSync(file)).tunitone.minimaxSessionId,'unit-session');
 const updated=JSON.parse(fs.readFileSync(file));updated.tunitone.awaitingReply=true;fs.writeFileSync(file,JSON.stringify(updated));assert.equal(minimaxReply({...event,session_id:'new-unbound',last_assistant_message:'9'},home,run).reason,'ambiguous_terminal');
 assert.equal(minimaxReply({...event,last_assistant_message:'9 <herdr-reply-id>'+other+'</herdr-reply-id>'},home,run).reason,'no_matching_terminal');
 const outside=path.join(root,'outside');fs.mkdirSync(outside);assert.equal(minimaxReply({...event,cwd:outside},home,run).reason,'unregistered_project');
});
test('quoted or fenced action examples stay text and never dispatch work',t=>{
 const {c}=fixture(t);c.terminal='tunitdirect';fs.mkdirSync(c.teamDir,{recursive:true});fs.writeFileSync(path.join(c.teamDir,'direct-bindings.json'),JSON.stringify({tunitdirect:{agentId:'engineer',chat:c.chat}}));
 c.run=(_cmd,args)=>{assert.equal(args[0],'get');return{cwd:c.cwd,parent:null,labels:{'team.direct':'true','team.agent':'engineer','team.chat':c.chat}};};
 const action='<herdr-action>'+JSON.stringify({action:'delegate',agentId:'missing',task:'Never execute',acceptance:'Example only'})+'</herdr-action>';
 const text='Example only:\n```xml\n'+action+'\n```\n`'+action+'`\n> '+action;
 assert.equal(directReply(c,text,'example-turn').captured,true);assert(!fs.existsSync(path.join(c.teamDir,'collaborations.json')));const line=JSON.parse(fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').trim());assert.equal(line.text,text);
});
test('one agent waiting for permission never blocks another ready agent conversation',t=>{
 const {c}=fixture(t);saveRoster(c,[{id:'engineer',name:'Engineer',provider:'codex',level:'worker'},{id:'reviewer',name:'Reviewer',provider:'claude',level:'worker'}]);fs.mkdirSync(c.teamDir,{recursive:true});const bindings={tunita:{agentId:'engineer',chat:c.chat},tunitb:{agentId:'reviewer',chat:c.chat}};fs.writeFileSync(path.join(c.teamDir,'direct-bindings.json'),JSON.stringify(bindings));const sent=[];
 c.run=(_cmd,args)=>{if(args[0]==='get')return{address:args[1],cwd:c.cwd,parent:null,state:'live',status:{app:args[1]==='tunita'?'codex':'claude-code',state:args[1]==='tunita'?'blocked':'idle'},labels:{'team.direct':'true','team.agent':bindings[args[1]].agentId,'team.chat':c.chat}};if(args[0]==='send'){sent.push(args);return{ok:true};}throw Error('Permission must not be answered');};
 enqueueDirect(c,'engineer','Wait for my permission','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');enqueueDirect(c,'reviewer','Independent question','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');assert.equal(drainDirect(c).terminal,'tunitb');assert.equal(sent.length,1);assert(fs.existsSync(path.join(c.teamDir,'direct-queue/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json')));
});
test('nested agent delegation keeps its parent task open until the child is actually verified',t=>{
 const {c}=fixture(t),members=['alpha','beta','gamma'].map(id=>({id,name:id,provider:'codex',level:'worker'}));saveRoster(c,members);fs.mkdirSync(c.teamDir,{recursive:true});const bindings=Object.fromEntries(members.map(a=>['tunit'+a.id,{agentId:a.id,chat:c.chat}]));fs.writeFileSync(path.join(c.teamDir,'direct-bindings.json'),JSON.stringify(bindings));const screens={};
 c.run=(_cmd,args)=>{if(args[0]==='get')return{address:args[1],cwd:c.cwd,parent:null,state:'live',status:{app:'codex',state:'idle'},labels:{'team.direct':'true','team.agent':bindings[args[1]].agentId,'team.chat':c.chat}};if(args[0]==='send')return{ok:true};if(args[0]==='read')return{text:screens[args[1]]||''};throw Error('No real operations');};
 const alpha={...c,terminal:'tunitalpha'},beta={...c,terminal:'tunitbeta'},gamma={...c,terminal:'tunitgamma'},file=path.join(c.teamDir,'collaborations.json'),jobs=()=>JSON.parse(fs.readFileSync(file));
 const parent=collaborate(alpha,{action:'delegate',agentId:'beta',task:'Obtain and verify 42',acceptance:'Verified answer must be 42'});assert.equal(drainDirect(c).sent,1);
 const queued=enqueueDirect(c,'beta','Another question must wait','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),queuedFile=path.join(c.teamDir,'direct-queue',queued.id+'.json'),queuedItem=JSON.parse(fs.readFileSync(queuedFile));queuedItem.createdAt=1;fs.writeFileSync(queuedFile,JSON.stringify(queuedItem));
 directReply(beta,'Waiting for gamma. <herdr-action>'+JSON.stringify({action:'delegate',agentId:'gamma',task:'Calculate 21+21',acceptance:'Answer is 42'})+'</herdr-action>','beta-first');assert.equal(jobs()[parent.id].status,'working');assert.equal(JSON.parse(fs.readFileSync(path.join(c.teamDir,'direct-bindings.json'))).tunitbeta.activeJob,parent.id);
 const child=Object.values(jobs()).find(j=>j.sourceAgent==='beta');assert.equal(drainDirect(c).terminal,'tunitgamma');screens.tunitgamma='42';directReply(gamma,'42','gamma-final');assert.equal(drainCollaboration(c).sent,1);
 screens.tunitbeta='Verified answer: 42';directReply(beta,screens.tunitbeta+' <herdr-action>'+JSON.stringify({action:'accept',id:child.id,revision:jobs()[child.id].revision,verification:'Verified 21+21 equals 42',evidence:[]})+'</herdr-action>','beta-final');assert.equal(jobs()[child.id].status,'done');assert.equal(jobs()[parent.id].status,'awaiting_review');assert.equal(drainCollaboration(c).sent,1);assert.equal(jobs()[parent.id].status,'awaiting_review');
});
test('a startup trust exit is not reopened until the user explicitly retries the real agent',t=>{
 const {c}=fixture(t);fs.mkdirSync(c.teamDir,{recursive:true});fs.writeFileSync(path.join(c.teamDir,'direct-bindings.json'),JSON.stringify({tunitold:{agentId:'engineer',provider:'codex',chat:c.chat}}));let launches=0;
 c.run=(_cmd,args)=>{if(args[0]==='get')return{address:args[1],cwd:c.cwd,parent:null,state:args[1]==='tunitold'?'finished':'live',status:{app:'codex',state:args[1]==='tunitold'?'blocked':'idle'},labels:{'team.direct':'true','team.agent':'engineer','team.chat':c.chat}};if(args[0]==='run'){launches++;return{address:'tunitnew'};}if(args[0]==='send')return{ok:true};throw Error('Do not answer trust prompts');};
 enqueueDirect(c,'engineer','Pending user question','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');assert.equal(drainDirect(c).reason,'startup_stopped');assert.equal(drainDirect(c).reason,'startup_stopped');assert.equal(launches,0);
 assert.equal(retryDirect(c,'engineer').restarted,false);assert.equal(drainDirect(c).started,'tunitnew');assert.equal(launches,1);assert.equal(drainDirect(c).sent,1);assert.throws(()=>retryDirect(c,'engineer'),/仍在執行/);assert(!fs.existsSync(path.join(c.teamDir,'control.json')));
});

test('cancel archives undelivered chat tasks and cannot dispatch or retry the cancelled message',async t=>{
 const {actOnChatTask,chatTaskControls}=await import('./direct.mjs');
 const {enqueueChat,drainChats}=await import('./team-runtime.mjs');
 const {c}=fixture(t);
 c.run=()=>assert.fail('Cancellation must not contact Core');
 const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',legacy='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 enqueueDirect(c,'engineer','Cancel this turn',id);
 enqueueChat(c,'Cancel legacy queue',legacy);
 const events=fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(chatTaskControls(c,events,[],{}),{[id]:'cancel',[legacy]:'cancel'});
 const lock=path.join(c.teamBase,'chat-delivery.lock');
 fs.writeFileSync(lock,'worker');
 assert.throws(()=>actOnChatTask(c,{id,action:'cancel'}),e=>e.status===409);
 fs.unlinkSync(lock);
 for(const message of [id,legacy])assert.deepEqual(actOnChatTask(c,{id:message,action:'cancel'}),{status:'cancelled'});
 assert.deepEqual(chatTaskControls(c,events,[],{}),{[id]:'cancelled',[legacy]:'cancelled'});
 assert.equal(drainDirect(c).sent,0);
 assert.equal(drainChats(c).sent,0);
 assert.equal(enqueueDirect(c,'engineer','Cancel this turn',id).status,'cancelled');
 assert.equal(enqueueChat(c,'Cancel legacy queue',legacy).status,'cancelled');
 assert.equal(fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').length,2);
});

test('stop only interrupts the same verified live direct turn and requires a confirmed result',async t=>{
 const {actOnChatTask,chatTaskControls}=await import('./direct.mjs');
 const {c}=fixture(t),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',next='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 let state='idle',turn=4,outcome='still_working',foreign=false,interrupts=0;
 c.run=(_cmd,[verb,terminal])=>{
  if(verb==='run')return{address:'tunittask'};
  if(verb==='get')return{address:terminal,cwd:foreign?'/foreign':c.cwd,parent:null,state:'live',status:{app:'codex',state},turn,labels:{'team.direct':'true','team.agent':'engineer','team.chat':c.chat}};
  if(verb==='send'){state='working';return{ok:true};}
  if(verb==='interrupt'){assert.equal(terminal,'tunittask');interrupts++;if(outcome==='stopped'){state='idle';turn++;}return{outcome};}
  assert.fail(verb);
 };
 enqueueDirect(c,'engineer','First task',id);
 drainDirect(c);assert.equal(drainDirect(c).sent,1);
 enqueueDirect(c,'engineer','Second task',next);
 const events=fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const bindings=()=>JSON.parse(fs.readFileSync(path.join(c.teamDir,'direct-bindings.json'),'utf8'));
 const terminal=()=>c.run('hc',['get','tunittask']);
 assert.deepEqual(chatTaskControls(c,events,[terminal()],bindings()),{[id]:'stop',[next]:'cancel'});
 const act=()=>actOnChatTask(c,{id,action:'stop'});
 for(const stale of ['blocked','done']){state=stale;assert.throws(act,e=>e.status===409);}
 state='working';turn=5;assert.throws(act,e=>e.status===409);turn=4;
 foreign=true;assert.throws(act,/Foreign/);foreign=false;
 assert.throws(()=>actOnChatTask(c,{id:next,action:'stop'}),e=>e.status===409);
 assert.equal(interrupts,0);
 assert.throws(act,/尚未確認/);
 assert.equal(chatTaskControls(c,events,[terminal()],bindings())[id],'stop');
 outcome='stopped';assert.deepEqual(act(),{status:'stopped'});assert.deepEqual(act(),{status:'stopped'});
 assert.equal(interrupts,2);
 assert.equal(chatTaskControls(c,events,[terminal()],bindings())[id],'stopped');
 assert.equal(directReply({...c,terminal:'tunittask'},'Late reply','old').reason,'stopped_turn');
 assert.equal(drainDirect(c).sent,1);
 assert.equal(directReply({...c,terminal:'tunittask'},'New reply','new').captured,true);
});
