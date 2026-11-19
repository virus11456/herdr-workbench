import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {context,defaultRoster,validateRoster,saveRoster,roster,routeMessage,enqueueChat,executeRequest,drain} from './team-runtime.mjs';

const sampleRoster=()=>[
 {id:'planner',name:'規劃主管',group:'研究',provider:'claude',level:'manager',brief:'依任務安排協作'},
 {id:'developer',name:'開發工程師',group:'工程',provider:'codex',level:'worker',brief:'依任務處理工作'},
 {id:'reviewer',name:'審查成員',group:'驗收',provider:'minimax',level:'worker',brief:'依任務範圍協作'}
];
// Isolated fixtures and mock core: these tests never contact Herdr or start agents.
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-roster-unit-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const c=context(root,undefined,()=>{throw new Error('Unexpected real operation');},'unit-chat');
  return {root,c};
}
function owner(c) {
  fs.mkdirSync(c.teamDir,{recursive:true});
  fs.writeFileSync(path.join(c.teamDir,'control.json'),JSON.stringify({terminal:'tunitowner',role:'claude'}));
}
test('project membership is shared across its conversations, isolated from other projects, with no default workflow',t=>{
  const {root,c}=fixture(t);let calls=0;c.run=()=>{calls++;};
  const value=sampleRoster();value.push({...value[1],id:'frontend',name:'前端工程師'});
  assert.equal(saveRoster(c,value).started,false);
  assert.equal(roster(c).length,4);assert.equal(calls,0);
  assert.equal(roster(context(root,undefined,c.run,'another-chat')).length,4);
  assert.deepEqual(defaultRoster(),[]);
  const other=path.join(root,'other-project');fs.mkdirSync(other);assert.equal(roster(context(other)).length,0);
  assert.throws(()=>validateRoster([...value,value[0]]),/唯一/);
  assert.throws(()=>validateRoster([{...value[0],provider:'shell'}]),/引擎/);
});
test('custom agents route through coordinator with current roster and target metadata',t=>{
  const {c}=fixture(t);saveRoster(c,sampleRoster());
  const routed=routeMessage('@developer 修復側欄',roster(c));
  assert.equal(routed.target,'developer');assert.match(routed.text,/agentId=developer/);
  assert.throws(()=>routeMessage('@missing 修復',roster(c)),/找不到/);
  assert.throws(()=>routeMessage('@developer ',roster(c)),/輸入任務/);
  const msg=enqueueChat(c,'@planner 規劃協作');assert.equal(msg.target,'planner');
  const queued=JSON.parse(fs.readFileSync(path.join(c.teamDir,'chat-queue',msg.id+'.json')));
  assert.match(queued.text,/小組主管/);assert.equal(queued.original,'@planner 規劃協作');
  const event=JSON.parse(fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').trim());
  assert.equal(event.target,'planner');
});
test('named role chooses its real CLI template and gives manager a scoped report command',t=>{
  const {c}=fixture(t);owner(c);saveRoster(c,sampleRoster());const calls=[];
  c.run=(cmd,args)=>{calls.push([cmd,args]);if(args[0]==='ls')return {terminals:[]};if(args[0]==='run')return {address:'tunitworker'};throw new Error('unexpected');};
  const result=executeRequest(c,{sender:'tunitowner',action:'run',args:{agentId:'planner',name:'unit-planner',task:'規劃並協調驗收'}});
  assert.equal(result.address,'tunitworker');
  const run=calls.find(([,args])=>args[0]==='run')[1];
  assert(run.includes('herdr-claude-task'));assert(run.includes('team.agent=planner'));
  assert.match(run.at(-1),/小組主管/);assert.match(run.at(-1),/--chat unit-chat report tunitowner/);
  assert.match(run.at(-1),/不得自行啟動其他代理/);
});
test('foreign callers, escaping folders and duplicate live roles are rejected',t=>{
  const {c}=fixture(t);owner(c);saveRoster(c,sampleRoster());
  const args={agentId:'developer',name:'unit-developer',task:'測試'};
  assert.throws(()=>executeRequest(c,{sender:'tunitother',action:'run',args}),/active coordinator/);
  assert.throws(()=>executeRequest(c,{sender:'tunitowner',action:'run',args:{...args,cwd:'..'}}),/inside this project/);
  c.run=(_cmd,argv)=>argv[0]==='ls'?{terminals:[{address:'tunitworker'}]}:{address:'tunitworker',parent:'tunitowner',state:'live'};
  assert.throws(()=>executeRequest(c,{sender:'tunitowner',action:'run',args}),/already has a live/);
});
test('worker collaboration report is delivered to the coordinator, not executed as a new agent',t=>{
  const {c}=fixture(t);owner(c);const calls=[];
  fs.mkdirSync(path.join(c.teamDir,'outbox'));
  fs.writeFileSync(path.join(c.teamDir,'outbox','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json'),JSON.stringify({id:'unit-report',target:'tunitowner',from:'tunitworker',text:'協作請求：請 reviewer 驗收產物'}));
  c.run=(cmd,args)=>{calls.push([cmd,args]);return {ok:true};};
  assert.equal(drain(c).delivered,1);
  assert.equal(calls.length,1);assert.equal(calls[0][1][0],'send');assert.equal(calls[0][1][1],'tunitowner');
});
