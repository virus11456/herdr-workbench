import test from 'node:test';import assert from 'node:assert/strict';
import {agentConnected,agentActivity,replyProgress} from './activity.mjs';
const terminal={state:'live',status:{app:'codex',state:'working'}},base={agentId:'engineer',name:'工程師',terminal};
const user={kind:'user',direct:true,target:'engineer',messageId:'message-1',time:'2026-11-20T00:00:00Z'};
const delivery={kind:'delivery',delivery:'sent',messageId:'message-1',time:'2026-11-20T00:00:01Z'};
test('only a ready real CLI gets a green connection light; shells, blocked, error and exited agents stay gray',()=>{
 assert.equal(agentConnected(null),false);assert.equal(agentConnected({state:'live',status:null}),false);
 for(const state of ['working','idle','done'])assert.equal(agentConnected({state:'live',status:{app:'codex',state}}),true);
 for(const state of ['blocked','error'])assert.equal(agentConnected({state:'live',status:{app:'codex',state}}),false);
 assert.equal(agentConnected({...terminal,state:'finished'}),false);
});
test('activity follows real work, pending startup, blocked and completed states',()=>{
 assert.equal(agentActivity(terminal),'working');assert.equal(agentActivity(null,{pending:true}),'starting');
 assert.equal(agentActivity({...terminal,status:{app:'codex',state:'blocked'}},{pending:true}),'');
 assert.equal(agentActivity({...terminal,status:{app:'codex',state:'done'}}),'');
 assert.equal(agentActivity({...terminal,waitingCollaboration:true}),'');assert.equal(agentActivity({...terminal,state:'finished'}),'');
});
test('reply indicator never calls queued messages delivered, isolates agents, and clears only after real reply',()=>{
 assert.equal(replyProgress({...base,messages:[user]}).phase,'queued');
 assert.equal(replyProgress({...base,messages:[user,delivery]}).phase,'working');
 const other={kind:'reply',direct:true,target:'other',replyTo:user.messageId,time:'2026-11-20T00:00:02Z'};
 const done={...terminal,status:{app:'codex',state:'done'}};
 assert.deepEqual(replyProgress({...base,terminal:done,messages:[user,delivery,other]}),{phase:'unconfirmed',text:'已送達 工程師，回覆未核對',animate:false});
 const answer={...other,target:'engineer'};assert.equal(replyProgress({...base,terminal:done,messages:[user,delivery,answer]}),null);
 assert.equal(replyProgress({...base,terminal:{...terminal,status:{app:'codex',state:'blocked'}},messages:[user,delivery]}).animate,false);
 assert.equal(replyProgress({...base,terminal:{...done,waitingCollaboration:true},messages:[user,delivery,answer]}).phase,'collaboration');
 assert.equal(replyProgress({...base,terminal:{state:'finished'},messages:[user]}).phase,'queued');
});
test('a second queued message does not inherit the previous reply or another message delivery',()=>{
 const second={...user,messageId:'message-2',time:'2026-11-20T00:00:03Z'},answer={kind:'reply',direct:true,target:'engineer',replyTo:user.messageId,time:'2026-11-20T00:00:04Z'};
 assert.equal(replyProgress({...base,messages:[user,delivery,second,answer]}).phase,'queued');
 assert.equal(replyProgress({...base,messages:[],posting:true}).phase,'sending');
 const leadUser={...user,direct:false,target:'team'},leadReply={kind:'reply',time:'2026-11-20T00:00:02Z'};
 assert.equal(replyProgress({messages:[leadUser,delivery,leadReply],terminal:{...terminal,status:{app:'claude-code',state:'done'}}}),null);
});
