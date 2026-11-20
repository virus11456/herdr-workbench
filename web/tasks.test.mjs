import test from 'node:test';import assert from 'node:assert/strict';import {taskCards,flock,attentionItems,taskSummary} from './tasks.mjs';
const user={kind:'user',direct:true,target:'a',messageId:'m',text:'Check result'},delivery={kind:'delivery',messageId:'m',delivery:'sent'},terminal={address:'t1',agentId:'a',state:'live',status:{app:'codex',state:'working'}},base={agents:[{id:'a',name:'Engineer'}],agentWorkspace:true,messages:[user],terminals:[terminal],collaborations:[]};
test('cards distinguish queue, delivery, actual reply and verified collaboration without invented completion',()=>{assert.equal(taskCards(base,'a')[0].phase,'queued');assert.equal(taskCards({...base,messages:[user,delivery]},'a')[0].phase,'working');const reply={kind:'reply',direct:true,target:'a',replyTo:'other'};assert.equal(taskCards({...base,messages:[user,delivery,reply]},'a')[0].phase,'working');reply.replyTo='m';assert.equal(taskCards({...base,messages:[user,delivery,reply]},'a')[0].phase,'replied');assert.equal(taskSummary(taskCards({...base,messages:[user,delivery,reply]},'a')).verified,0);});
test('review stays review, verified stays verified even if terminal later blocks; checklist and jobs do not duplicate',()=>{const j={id:'j',sourceAgent:'b',targetAgent:'a',task:'Review',status:'awaiting_review',acceptance:'Exact result'};let s={...base,collaborations:[j],checklist:{items:[{id:'j',status:'in_progress'}]},messages:[]};assert.equal(taskCards(s,'a').length,1);assert.equal(taskCards(s,'a')[0].phase,'review');s.terminals=[{...terminal,status:{app:'codex',state:'blocked'}}];assert.equal(taskCards(s,'a')[0].phase,'blocked');j.status='done';assert.equal(taskCards(s,'a')[0].phase,'done');assert.equal(taskCards(s,'unrelated').length,0);});
test('pasture green only for live real CLIs; blocked and finished sheep never animate as working',()=>{assert.equal(flock(base)[0].phase,'working');for(const state of ['blocked','error']){const s={...base,terminals:[{...terminal,status:{app:'codex',state}}]};assert.equal(flock(s)[0].connected,false);}const ended={...base,terminals:[{...terminal,state:'finished'}]};assert.equal(flock(ended)[0].phase,'offline');assert.equal(attentionItems(ended).length,0);assert.equal(attentionItems({...base,terminals:[{...terminal,status:{app:'codex',state:'blocked'}}]})[0].id,'t1');});

test('task actions follow server eligibility and cancelled messages do not show as queued',()=>{
 const user={kind:'user',messageId:'one',direct:true,target:'engineer',text:'Work'};
 const state={messages:[user],taskControls:{one:'cancel'}};
 assert.equal(taskCards(state)[0].action,'cancel');
 state.taskControls.one='cancelled';
 assert.equal(taskCards(state)[0].phase,'cancelled');
 assert.equal(taskCards(state)[0].action,undefined);
});
