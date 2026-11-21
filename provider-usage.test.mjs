import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {claudeTurnUsage,codexTurnUsage,antigravityTurnUsage,minimaxTurnUsage,saveProviderUsage,providerUsageRecords} from './provider-usage.mjs';
import {conversationUsage} from './web/usage.mjs';

const session='aabbccdd-1111-2222-3333-aabbccddeeff',turn='eeff0011-1111-2222-3333-aabbccddeeff';
const time='2026-11-21T03:00:00.000Z';

function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'herdr-usage-')));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=(filename,rows)=>{
  const file=path.join(dir,filename);fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  return file;
 };
 const cwd=path.join(dir,'workspace');fs.mkdirSync(cwd);
 return {dir,cwd,write};
}

test('Claude Stop matches the reply and deduplicates API responses while retaining cache counters',t=>{
 const {dir,cwd,write}=fixture(t);
 const user={type:'user',cwd,sessionId:session,uuid:turn,message:{role:'user',content:'prompt'}};
 const assistant=(id,text,output,more={})=>({type:'assistant',cwd,sessionId:session,message:{id,role:'assistant',content:[{type:'text',text}],
  usage:{input_tokens:4,output_tokens:output,cache_read_input_tokens:100,cache_creation_input_tokens:2}},...more});
 const transcript_path=write('projects/workspace/'+session+'.jsonl',[
  assistant('old','old',1000),user,assistant('first','working',2),assistant('first','working',7),
  {...user,message:{role:'user',content:[{type:'tool_result'}]}},assistant('side','side',900,{isSidechain:true}),assistant('second','final',5),
 ]);
 const event={session_id:session,transcript_path,last_assistant_message:'final'};
 assert.deepEqual(claudeTurnUsage(event,cwd,dir)?.tokens,{input:8,output:12,cacheRead:200,cacheWrite:4});
 assert.equal(claudeTurnUsage({...event,last_assistant_message:'different'},cwd,dir),null);
 assert.equal(claudeTurnUsage({...event,transcript_path:write(session+'.jsonl',[user])},cwd,dir),null);
});

test('Codex usage subtracts cumulative snapshots for the exact completed turn and keeps fresh provider quota',t=>{
 const {dir,cwd,write}=fixture(t);
 const row=(type,extra)=>({type:'event_msg',timestamp:time,payload:{type,...extra}});
 const sample=(input,output,cache)=>row('token_count',{info:{total_token_usage:{input_tokens:input,output_tokens:output,cached_input_tokens:cache}},rate_limits:{
  limit_id:'codex',primary:{used_percent:38,window_minutes:300,resets_at:1795233600},
 }});
 assert(Date.parse(time)<1795233600*1000);
 write('sessions/2026/11/21/rollout-test-'+session+'.jsonl',[
  {type:'session_meta',payload:{id:session,cwd}},row('task_started',{turn_id:'previous'}),sample(100,20,5),row('task_complete',{turn_id:'previous'}),
  row('task_started',{turn_id:turn}),sample(200,50,18),sample(300,80,28),row('task_complete',{turn_id:turn}),
  row('task_started',{turn_id:'unfinished'}),sample(900,190,400),
 ]);
 const event={'thread-id':session,'turn-id':turn};
 const usage=codexTurnUsage(event,cwd,dir);
 assert.deepEqual(usage?.tokens,{input:200,output:60,cacheRead:23});
 assert.equal(usage?.quota.windows[0].usedPercent,38);
 assert.equal(codexTurnUsage({...event,'turn-id':'unfinished'},cwd,dir),null);
 assert.equal(codexTurnUsage(event,dir,dir),null);
});

test('Antigravity completed model steps and MiniMax recorded messages use only their reported tokens',t=>{
 const steps=[
  {source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',step_index:1,input_tokens:900,output_tokens:400},
  {type:'USER_INPUT'},
  {source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',step_index:3,input_tokens:13,output_tokens:7,cache_read_tokens:60},
  {source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',step_index:4,input_tokens:29,output_tokens:8,cache_read_tokens:70},
 ];
 assert.deepEqual(antigravityTurnUsage({conversationId:session,executionNum:2},steps,1,steps.at(-1))?.tokens,{input:42,output:15,cacheRead:130});
 assert.equal(antigravityTurnUsage({conversationId:session,executionNum:2},steps,-1,steps.at(-1)),null);
 const {dir,write}=fixture(t);
 const message=(id,turn_id,input,output)=>({turn_id,message_id:id,message:{role:'assistant',usage:{input,output,cacheRead:120,cacheWrite:0,cost:{total:0}}}});
 const folder='sessions/2026/11/21/provider-directory';
 write(folder+'/manifest.json',[{sessionId:session}]);
 write(folder+'/messages.jsonl',[message('old','old',100,100),message('one',turn,20,18),message('one',turn,20,18),message('two',turn,40,10)]);
 assert.deepEqual(minimaxTurnUsage({session_id:session,turn_id:turn},dir)?.tokens,{input:60,output:28,cacheRead:240,cacheWrite:0});
 assert.equal(minimaxTurnUsage({session_id:'foreign',turn_id:turn},dir),null);
});

test('conversation stats deduplicate a repeated provider event, omit missing fields and hide reset quota',t=>{
 const {dir,cwd}=fixture(t),c={cwd,usageDir:dir,terminal:'ttest'};
 const providerUsage={identity:session+'/'+turn,tokens:{input:13,output:6,cacheRead:20}};
 saveProviderUsage(c,'antigravity',{},providerUsage);
 saveProviderUsage(c,'antigravity',{},providerUsage);
 saveProviderUsage({...c,usageDir:null},'antigravity',{}, {...providerUsage,identity:'should-not-save'});
 const records=providerUsageRecords(c);
 const quota={observedAt:time,windows:[{usedPercent:25,windowMinutes:300,resetsAt:1795233600}]};
 records.push({key:'a'.repeat(64),provider:'codex',tokens:{input:7,output:9},quota});
 const [agy,codex]=conversationUsage([],records,Date.parse(time));
 assert.equal(agy.measuredTurns,1);assert.deepEqual(agy.tokens,{input:13,output:6,cacheRead:20});
 assert.equal(codex.quota.windows[0].usedPercent,25);assert.equal(codex.tokens.cacheRead,undefined);
 assert.equal(conversationUsage([],records,quota.windows[0].resetsAt*1000)[1].quota,undefined);
});
