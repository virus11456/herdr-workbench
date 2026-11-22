import test from 'node:test';import assert from 'node:assert/strict';import {taskCards,flock,attentionItems,taskSummary,collaborationUpdates,isCollaborationReceipt} from './tasks.mjs';
const user={kind:'user',direct:true,target:'a',messageId:'m',text:'Check result'},delivery={kind:'delivery',messageId:'m',delivery:'sent'},terminal={address:'t1',agentId:'a',state:'live',status:{app:'codex',state:'working'}},base={agents:[{id:'a',name:'Engineer'}],agentWorkspace:true,messages:[user],terminals:[terminal],collaborations:[]};
test('only the exact generated completion receipt is compacted after durable acceptance',()=>{const state={chat:'chat',collaborations:[{id:'j',status:'done',verification:'Checked actual result'}]},receipt={kind:'progress',collaborationId:'j',text:'協作已驗收：Checked actual result'};assert(isCollaborationReceipt(state,receipt));assert(!isCollaborationReceipt(state,{...receipt,kind:'reply'}));assert(!isCollaborationReceipt(state,{...receipt,text:'Additional limits and evidence'}));state.collaborations[0].status='awaiting_review';assert(!isCollaborationReceipt(state,receipt));});
test('compacting a receipt never crosses old-chat job identities or hides unknown progress',()=>{const state={chat:'new',projectCollaborations:[{id:'j',sourceChat:'old',status:'done',verification:'Old acceptance'},{id:'j',sourceChat:'new',status:'working',verification:'New acceptance'}]},receipt={kind:'progress',sourceChat:'old',collaborationId:'j',text:'協作已驗收：Old acceptance'};assert(isCollaborationReceipt(state,receipt));assert(!isCollaborationReceipt(state,{...receipt,sourceChat:'new'}));assert(!isCollaborationReceipt(state,{...receipt,collaborationId:'missing'}));});
test('cards distinguish queue, delivery, actual reply and verified collaboration without invented completion',()=>{assert.equal(taskCards(base,'a')[0].phase,'queued');assert.equal(taskCards({...base,messages:[user,delivery]},'a')[0].phase,'working');const reply={kind:'reply',direct:true,target:'a',replyTo:'other'};assert.equal(taskCards({...base,messages:[user,delivery,reply]},'a')[0].phase,'working');reply.replyTo='m';assert.equal(taskCards({...base,messages:[user,delivery,reply]},'a')[0].phase,'replied');assert.equal(taskSummary(taskCards({...base,messages:[user,delivery,reply]},'a')).verified,0);});
test('review stays review, verified stays verified even if terminal later blocks; checklist and jobs do not duplicate',()=>{const j={id:'j',sourceAgent:'b',targetAgent:'a',task:'Review',status:'awaiting_review',acceptance:'Exact result'};let s={...base,collaborations:[j],checklist:{items:[{id:'j',status:'in_progress'}]},messages:[]};assert.equal(taskCards(s,'a').length,1);assert.equal(taskCards(s,'a')[0].phase,'review');s.terminals=[{...terminal,status:{app:'codex',state:'blocked'}}];assert.equal(taskCards(s,'a')[0].phase,'review');j.status='done';assert.equal(taskCards(s,'a')[0].phase,'done');assert.equal(taskCards(s,'unrelated').length,0);});
test('pasture green only for live real CLIs; blocked and finished sheep never animate as working',()=>{assert.equal(flock(base)[0].phase,'working');for(const state of ['blocked','error']){const s={...base,terminals:[{...terminal,status:{app:'codex',state}}]};assert.equal(flock(s)[0].connected,false);}const ended={...base,terminals:[{...terminal,state:'finished'}]};assert.equal(flock(ended)[0].phase,'offline');assert.equal(attentionItems(ended).length,0);assert.equal(attentionItems({...base,terminals:[{...terminal,status:{app:'codex',state:'blocked'}}]})[0].id,'t1');});

test('task actions follow server eligibility and cancelled messages do not show as queued',()=>{
 const user={kind:'user',messageId:'one',direct:true,target:'engineer',text:'Work'};
 const state={messages:[user],taskControls:{one:'cancel'}};
 assert.equal(taskCards(state)[0].action,'cancel');
 state.taskControls.one='cancelled';
 assert.equal(taskCards(state)[0].phase,'cancelled');
 assert.equal(taskCards(state)[0].action,undefined);
});

test('shared decisions and unlinked historical replies do not count as running work',()=>{
 const historical={kind:'reply',direct:true,target:'a',text:'Older reply without a message identifier'};
 const cards=taskCards({
  ...base,
  terminals:[{...terminal,status:{app:'codex',state:'done'}}],
  checklist:{items:[{id:'decision',title:'Confirm plan',status:'pending',owner:'Frank'}]},
  messages:[user,delivery,historical]
 },'a');
 assert.deepEqual(cards.map(card=>card.phase),['pending','unconfirmed']);
 assert.deepEqual(taskSummary(cards),{active:0,attention:1,review:0,verified:0,replied:0,unconfirmed:1});
});


test('compact collaboration route uses real jobs and confirmed delivery, never model claims',()=>{
 const state={...base,agents:[{id:'lead',name:'領頭羊'},{id:'a',name:'工程師'}],messages:[{kind:'reply',text:'工程師已經完成並驗收'}],collaborations:[]};
 assert.equal(collaborationUpdates(state,'lead').rows.length,0);
 state.collaborations=[{id:'job',sourceAgent:'lead',targetAgent:'a',targetTerminal:'t1',task:'核對結果',status:'queued'}];
 let row=collaborationUpdates(state,'lead').rows[0];assert.equal(row.source,'領頭羊');assert.equal(row.owner,'工程師');assert.equal(row.phase,'queued');
 state.collaborations[0].feedback='請補充步驟';assert.match(collaborationUpdates(state,'lead').rows[0].detail,/退回修正/);
 state.collaborations[0].status='working';assert.equal(collaborationUpdates(state,'lead').rows[0].phase,'dispatching');
 state.collaborations[0].deliveryConfirmed=true;assert.equal(collaborationUpdates(state,'lead').rows[0].phase,'working');
});

test('reported collaboration stays awaiting review until durable acceptance, even if a later CLI turn blocks',()=>{
 const state={...base,collaborations:[{id:'job',sourceAgent:'lead',targetAgent:'a',targetTerminal:'t1',task:'核對',status:'awaiting_review'}],terminals:[{...terminal,status:{app:'codex',state:'blocked'}}]};
 assert.equal(collaborationUpdates(state,'a').rows[0].phase,'review');assert.equal(taskCards(state,'a')[0].phase,'review');
 state.collaborations[0].status='done';state.collaborations[0].verification='已實際核對產物與算式一致';
 const row=collaborationUpdates(state,'a').rows[0];assert.equal(row.phase,'done');assert.equal(row.detail,state.collaborations[0].verification);
 assert.equal(collaborationUpdates(state,'unrelated').rows.length,0);
});

test('compact updates remain bounded and show only matching blocked workers, with access to remaining work',()=>{
 const state={...base,collaborations:Array.from({length:6},(_,i)=>({id:'job'+i,sourceAgent:'lead',targetAgent:'a',targetTerminal:i?'other':'t1',task:'任務'+i,status:'working',deliveryConfirmed:true})),terminals:[{...terminal,status:{app:'codex',state:'blocked'}}]};
 let update=collaborationUpdates(state,'lead');assert.equal(update.rows.length,3);assert.equal(update.remaining,3);assert.equal(update.rows[0].phase,'blocked');assert(update.rows.slice(1).every(r=>r.phase==='working'));
 state.collaborations.push({id:'completed',sourceAgent:'lead',targetAgent:'a',status:'done',verification:'已核對'});update=collaborationUpdates(state,'lead');assert.equal(update.rows.length,4);assert.equal(update.rows.at(-1).id,'completed');
 const expanded=collaborationUpdates(state,'lead',{expanded:true});assert.equal(expanded.rows.length,7);assert.equal(expanded.remaining,0);
});


test('merged agent chat shows old-chat jobs with explicit source routing and distinct keys',()=>{
 const state={...base,chat:'new',collaborations:[],projectCollaborations:[{id:'same-id',sourceChat:'old',sourceAgent:'lead',targetAgent:'a',task:'舊工作',status:'queued'},{id:'same-id',sourceChat:'new',sourceAgent:'lead',targetAgent:'a',task:'新工作',status:'queued'}]};
 const rows=collaborationUpdates(state,'a').rows;assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.chat),['old','new']);assert.equal(new Set(rows.map(r=>r.key)).size,2);
});
