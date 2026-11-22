// A display projection of observed state. It never dispatches or accepts work.
export const taskLabels={pending:'待處理',queued:'等待接收',dispatching:'送達待核對',working:'工作中',blocked:'需要處理',stopped:'已停止',cancelled:'已取消',review:'待驗收',replied:'已回覆',unconfirmed:'回覆未核對',done:'已驗收'};
export function agentTerminal(state,id){return id?state.terminals?.filter(t=>t.agentId===id).at(-1):state.terminals?.find(t=>t.address===state.control?.terminal);}
export function flock(state){
 const list=[...(!state.agentWorkspace?[{id:null,name:state.coordinatorName||'領頭羊',provider:'claude'}]:[]),...(state.agents||[])];
 return list.map(a=>{const t=agentTerminal(state,a.id),live=t?.state==='live',status=t?.status?.state;let phase='offline';
  if(live&&status==='blocked')phase='blocked';else if(live&&status==='error')phase='error';else if(live&&t.status?.app&&status==='working')phase='working';else if(live&&t.status?.app&&['idle','done'].includes(status))phase=t.waitingCollaboration?'collaboration':'ready';else if(!t&&state.pendingAgents?.includes(a.id))phase='starting';
  return{...a,phase,terminal:t?.address||null,connected:live&&!!t.status?.app&&['working','idle','done'].includes(status),label:({offline:'未連線 · 收到訊息後啟動',starting:'啟動中',working:'工作中',blocked:'等待你確認',error:'發生錯誤',collaboration:'等待協作回報',ready:'已連線 · 待命'})[phase]};});
}
export function attentionItems(state){return flock(state).filter(a=>a.phase==='blocked').map(a=>({id:a.terminal,agentId:a.id,name:a.name,title:'需要你在主機確認',detail:'可能是登入、資料夾信任或工具權限。請查看這位代理的主機終端；此處不會替你同意。'}));}
export function taskCards(state,agentId=null){
 const rows=[],jobs=state.collaborations||[],jobIds=new Set(jobs.map(j=>j.id)),members=state.agents||[],name=id=>members.find(a=>a.id===id)?.name||id||state.coordinatorName||'領頭羊';
 for(const task of state.checklist?.items||[]){if(jobIds.has(task.id))continue;rows.push({id:'check:'+task.id,title:task.title,owner:task.owner,phase:({pending:'pending',in_progress:'working',blocked:'blocked',done:'done'})[task.status]||'pending',acceptance:task.acceptance,verification:task.verification,detail:task.reason,kind:'checklist',artifacts:task.artifacts});}
 for(const j of jobs){if(agentId&&j.sourceAgent!==agentId&&j.targetAgent!==agentId)continue;const t=agentTerminal(state,j.targetAgent),blocked=t?.state==='live'&&t.status?.state==='blocked';rows.push({id:'job:'+j.id,title:j.task,owner:j.targetName||name(j.targetAgent),agentId:j.targetAgent,source:name(j.sourceAgent),phase:j.status==='done'?'done':blocked?'blocked':({provisioning:'queued',queued:'queued',working:'working',awaiting_review:'review',failed:'blocked'})[j.status]||'queued',acceptance:j.acceptance,verification:j.verification,detail:j.feedback,kind:'collaboration',artifacts:j.artifacts});}
 const messages=state.messages||[],delivery=new Map(messages.filter(m=>m.kind==='delivery'&&m.delivery==='sent').map(m=>[m.messageId,m]));
 const users=messages.filter(m=>m.kind==='user'&&m.messageId&&(agentId?m.direct&&m.target===agentId:true)).slice(-12);
 for(const m of users){const target=m.direct?m.target:null,t=agentTerminal(state,target),sent=delivery.get(m.messageId);const belongs=r=>target?r.direct&&r.target===target:!r.direct;
  const reply=sent&&messages.find(r=>r.kind==='reply'&&belongs(r)&&r.replyTo===m.messageId);
  const latest=users.findLast(u=>(u.direct?u.target:null)===target)===m;let phase=reply?'replied':!sent?'queued':'unconfirmed';
  if(!reply&&latest&&t?.state==='live'&&t.status?.state==='blocked')phase='blocked';else if(!reply&&sent&&latest&&(t?.state==='finished'||t?.status?.state==='error'))phase='stopped';else if(!reply&&sent&&latest&&t?.status?.state==='working')phase='working';
  const control=state.taskControls?.[m.messageId];
  if(control==='cancelled'||control==='stopped')phase=control;
  const action=['cancel','stop'].includes(control)?control:undefined;
  const canPrepareDraft=!!m.text&&['cancelled','stopped'].includes(control)&&(!target||members.some(agent=>agent.id===target));
  rows.push({action,canPrepareDraft,id:'message:'+m.messageId,title:m.text||'對話任務',owner:name(target),agentId:target,phase,kind:'message',detail:phase==='cancelled'?'任務已從排隊移除。':phase==='stopped'&&control==='stopped'?'已確認代理停止這一回合。':phase==='replied'?'已收到這位代理的實際回覆，成果驗收另行追蹤。':phase==='unconfirmed'?'已送達。請查看原對話，確認是否已有回覆。':phase==='queued'?'訊息已保存，尚未確認送達代理。':undefined});
 }
 return rows;
}
export function taskSummary(cards){const count=p=>cards.filter(c=>p.includes(c.phase)).length;return{active:count(['queued','working']),attention:count(['pending','blocked']),review:count(['review']),verified:count(['done']),replied:count(['replied']),unconfirmed:count(['unconfirmed'])};}

// Compact chat updates come from durable jobs, never from claims in model text.
export function collaborationUpdates(state,agentId=null,{expanded=false}={}){
 const members=state.agents||[],name=id=>members.find(a=>a.id===id)?.name||(id?'已移除的代理':state.coordinatorName||'領頭羊');
 const rows=(state.projectCollaborations||state.collaborations||[]).filter(j=>!agentId||j.sourceAgent===agentId||j.targetAgent===agentId).map(j=>{
  const t=agentTerminal(state,j.targetAgent);
  const blocked=j.status==='working'&&t&&(!j.targetTerminal||j.targetTerminal===t.address)&&(t.state==='finished'||['blocked','error'].includes(t.status?.state));
  const phase=blocked?'blocked':({provisioning:'queued',queued:'queued',working:j.deliveryConfirmed?'working':'dispatching',awaiting_review:'review',done:'done',failed:'blocked'})[j.status]||'unconfirmed';
  const source=name(j.sourceAgent),owner=members.find(a=>a.id===j.targetAgent)?.name||j.targetName||name(j.targetAgent);
  const detail=phase==='review'?`回報已到，等待 ${source} 驗收。`:phase==='done'?j.verification||'已記錄交付者的驗收結果。':phase==='blocked'?j.feedback||'目前受阻，請查看任務詳情或主機提示。':phase==='queued'?(j.feedback?'退回修正：'+j.feedback+'；等待重新接收。':'已安排，尚未確認代理開始執行。'):phase==='working'?'已送達，正在等待實際回報。':phase==='dispatching'?'已安排，送達結果尚未核對，請勿重複交辦。':'狀態尚未核對，請查看詳情。';
  return{id:j.id,key:(j.sourceChat||state.chat||'legacy')+':'+j.id,chat:j.sourceChat||state.chat,title:j.task,source,owner,agentId:j.targetAgent,phase,detail,verification:j.verification,acceptance:j.acceptance};
 });
 const rank={blocked:0,review:1,working:2,queued:3,dispatching:4,unconfirmed:5};
 const active=rows.filter(r=>r.phase!=='done').sort((a,b)=>rank[a.phase]-rank[b.phase]);
 const recent=rows.filter(r=>r.phase==='done').slice(-1);
 return{rows:[...(expanded?active:active.slice(0,3)),...recent],remaining:expanded?0:Math.max(0,active.length-3),active:active.length};
}
