import test from 'node:test';import assert from 'node:assert/strict';
import {agentConnected,agentActivity,replyProgress,messageReceipt} from './activity.mjs';
const terminal={state:'live',status:{app:'codex',state:'working'}},base={agentId:'engineer',name:'工程師',terminal};
const user={kind:'user',direct:true,target:'engineer',messageId:'message-1',time:'2026-11-20T00:00:00Z'};
const delivery={kind:'delivery',delivery:'sent',messageId:'message-1',time:'2026-11-20T00:00:01Z'};
test('message receipts require the exact message and recipient and follow cancellation or a matched reply',()=>{
 const receipt=(messages,taskControls={})=>messageReceipt({messageId:user.messageId,agentId:'engineer',messages,taskControls});
 assert.equal(receipt([]),null);assert.equal(receipt([user]),'queued');assert.equal(receipt([user,delivery]),'sent');
 const wrong={kind:'reply',direct:true,agentId:'other',replyTo:user.messageId};
 assert.equal(receipt([user,wrong]),'queued');
 assert.equal(receipt([user,{...wrong,agentId:'engineer',replyTo:'previous-message'}]),'queued');
 assert.equal(receipt([user,delivery,{...wrong,agentId:'engineer'}]),'replied');
 assert.equal(receipt([user,delivery],{[user.messageId]:'cancelled'}),'cancelled');
 assert.equal(receipt([user,delivery],{[user.messageId]:'stopped'}),'stopped');
});
test('leader receipts isolate direct agents, and an old reply cannot finish a later queued message',()=>{
 const leader={...user,direct:false},reply={kind:'reply',replyTo:user.messageId};
 assert.equal(messageReceipt({messageId:user.messageId,messages:[leader,delivery,reply]}),'replied');
 assert.equal(messageReceipt({messageId:user.messageId,messages:[user,delivery,reply]}),null);
 const next={...user,messageId:'message-2'};
 assert.equal(messageReceipt({messageId:next.messageId,agentId:'engineer',messages:[user,delivery,next,{...reply,direct:true,target:'engineer'}]}),'queued');
});
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
 const unconfirmed=replyProgress({...base,terminal:done,messages:[user,delivery,other]});
 assert.equal(unconfirmed.phase,'unconfirmed');assert.equal(unconfirmed.text,'已送達 工程師，回覆未核對');assert.equal(unconfirmed.animate,false);
 const answer={...other,target:'engineer'};assert.equal(replyProgress({...base,terminal:done,messages:[user,delivery,answer]}),null);
 assert.equal(replyProgress({...base,terminal:{...terminal,status:{app:'codex',state:'blocked'}},messages:[user,delivery]}).animate,false);
 assert.equal(replyProgress({...base,terminal:{...done,waitingCollaboration:true},messages:[user,delivery,answer]}),null);
 assert.equal(replyProgress({...base,terminal:{state:'finished'},messages:[user]}).phase,'queued');
});
test('a second queued message does not inherit the previous reply or another message delivery',()=>{
 const second={...user,messageId:'message-2',time:'2026-11-20T00:00:03Z'},answer={kind:'reply',direct:true,target:'engineer',replyTo:user.messageId,time:'2026-11-20T00:00:04Z'};
 assert.equal(replyProgress({...base,messages:[user,delivery,second,answer]}).phase,'queued');
 assert.equal(replyProgress({...base,messages:[],posting:true}).phase,'sending');
 const leadUser={...user,direct:false,target:'team'},leadReply={kind:'reply',time:'2026-11-20T00:00:02Z'};
 assert.equal(replyProgress({messages:[leadUser,delivery,leadReply],terminal:{...terminal,status:{app:'claude-code',state:'done'}}}),null);
});

test('waiting feedback describes observed progress and never treats a quiet task as completed',()=>{
 const now=Date.parse(user.time)+120000;
 const result=replyProgress({...base,messages:[user,delivery],now});
 assert.equal(result.phase,'working');assert.equal(result.elapsedSeconds,120);assert.equal(result.stalled,true);assert.match(result.reason,/模型/);
 const blocked=replyProgress({...base,messages:[user,delivery],terminal:{...terminal,status:{app:'codex',state:'blocked'}},now});
 assert.equal(blocked.stalled,false);assert.match(blocked.reason,/主機/);
 const fresh=replyProgress({...base,messages:[user,delivery],terminal:{...terminal,observedAt:now-1000},now});assert.equal(fresh.stalled,false);
});
test('a queued follow-up explains an earlier unpaired final reply without pretending the engine is working',()=>{
 const second={...user,messageId:'message-2'},idle={...terminal,status:{app:'codex',state:'done'},waitingReplyCapture:true,awaitingReplyMessageId:user.messageId};
 const p=replyProgress({...base,terminal:idle,messages:[user,delivery,second]});assert.equal(p.phase,'queued');assert.equal(p.animate,false);assert.match(p.text,/核對.*上一則回覆/);assert.match(p.reason,/仍在排隊/);
 assert.equal(replyProgress({...base,terminal:idle,messages:[user,delivery]}).phase,'unconfirmed');
 assert.equal(replyProgress({...base,terminal:{...idle,waitingReplyCapture:false},messages:[second]}).text,'等待 工程師 接收');
});

test('later owner work never restarts the clock of a previously answered direct message',()=>{
 const answer={kind:'reply',direct:true,target:'engineer',replyTo:user.messageId,time:'2026-11-20T00:00:02Z'};
 assert.equal(replyProgress({...base,terminal:{...terminal,waitingCollaboration:true},messages:[user,delivery,answer],now:Date.parse(user.time)+375*60000}),null);
});
