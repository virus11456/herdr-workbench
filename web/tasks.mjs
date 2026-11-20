// A display projection of observed state. It never dispatches or accepts work.
export const taskLabels={queued:'等待接收',delivered:'已送達，等待回覆',working:'工作中',blocked:'等待你確認',stopped:'已停止',review:'待驗收',replied:'已回覆',done:'已驗收'};
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
 for(const task of state.checklist?.items||[]){if(jobIds.has(task.id))continue;rows.push({id:'check:'+task.id,title:task.title,owner:task.owner,phase:({pending:'queued',in_progress:'working',blocked:'blocked',done:'done'})[task.status]||'queued',acceptance:task.acceptance,verification:task.verification,detail:task.reason,kind:'checklist'});}
 for(const j of jobs){if(agentId&&j.sourceAgent!==agentId&&j.targetAgent!==agentId)continue;const t=agentTerminal(state,j.targetAgent),blocked=t?.state==='live'&&t.status?.state==='blocked';rows.push({id:'job:'+j.id,title:j.task,owner:name(j.targetAgent),agentId:j.targetAgent,source:name(j.sourceAgent),phase:j.status==='done'?'done':blocked?'blocked':({queued:'queued',working:'working',awaiting_review:'review'})[j.status]||'queued',acceptance:j.acceptance,verification:j.verification,detail:j.feedback,kind:'collaboration'});}
 const messages=state.messages||[],delivery=new Map(messages.filter(m=>m.kind==='delivery'&&m.delivery==='sent').map(m=>[m.messageId,m]));
 const users=messages.filter(m=>m.kind==='user'&&m.messageId&&(agentId?m.direct&&m.target===agentId:true)).slice(-12);
 for(const m of users){const target=m.direct?m.target:null,t=agentTerminal(state,target),sent=delivery.get(m.messageId);const belongs=r=>target?r.direct&&r.target===target:!r.direct;
  const reply=sent&&messages.find(r=>r.kind==='reply'&&belongs(r)&&r.replyTo===m.messageId);
  const latest=users.findLast(u=>(u.direct?u.target:null)===target)===m;let phase=reply?'replied':!sent?'queued':'delivered';
  if(!reply&&latest&&t?.state==='live'&&t.status?.state==='blocked')phase='blocked';else if(!reply&&sent&&latest&&(t?.state==='finished'||t?.status?.state==='error'))phase='stopped';else if(!reply&&sent&&latest&&t?.status?.state==='working')phase='working';
  rows.push({id:'message:'+m.messageId,title:m.text||'對話任務',owner:name(target),agentId:target,phase,kind:'message',detail:phase==='replied'?'已收到這位代理的實際回覆；這不代表成果已通過驗收。':phase==='queued'?'訊息已保存，尚未確認送達代理。':undefined});
 }
 return rows;
}
export function taskSummary(cards){const count=p=>cards.filter(c=>p.includes(c.phase)).length;return{active:count(['queued','delivered','working']),attention:count(['blocked','stopped']),review:count(['review']),verified:count(['done']),replied:count(['replied'])};}
