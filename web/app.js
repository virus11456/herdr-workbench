import {bindViewport,layoutDiagnostics} from './viewport.mjs';
import {formatMessage} from './format.mjs';
import {flock,attentionItems,taskCards,taskSummary,taskLabels} from './tasks.mjs';
import {agentConnected,agentActivity,replyProgress} from './activity.mjs';
'use strict';
const $=id=>document.getElementById(id);
const UI_BUILD='20261120-pasture22';
const providers={claude:'Claude',codex:'Codex',minimax:'MiniMax',antigravity:'Google / Antigravity'};
const providerName=value=>providers[value]||value||'代理';
const modelNames={'claude-opus-5-5':'Opus 5.5','claude-fable-5-2':'Fable 5.2'};
const modelLabel=(a,t)=>t?.model?(modelNames[t.model]||t.model):a.provider==='claude'?'下次：'+(modelNames[a.model||'claude-opus-5-5']):t?'模型讀取中':providerName(a.provider)+' · 本對話未啟動';
const compactMode=matchMedia('(max-width:767px), (max-width:1023px) and (max-height:520px)');
const initialQuery=new URLSearchParams(location.search);
let state=null,selection={project:initialQuery.get('project'),chat:initialQuery.get('chat')},selectedAgent=initialQuery.get('agent'),details=false,historyVisible=false,editing=null,posting=false,revision=0;
const el=(tag,className,text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;};
let sheepSource=null,navSnapshot='',messageSnapshot='',checklistSnapshot='',pastureSnapshot='',attentionSnapshot='';
function hydrateSheep(wrap){
 if(!sheepSource)return;
 const svg=sheepSource.cloneNode(true);svg.classList.add('sheep-character');svg.setAttribute('aria-hidden','true');wrap.replaceChildren(svg);
}
const avatar=(provider,shepherd=false)=>{
 const wrap=el('span','avatar '+(shepherd?'shepherd':provider));wrap.setAttribute('aria-hidden','true');
 if(!shepherd){wrap.classList.add('sheep-avatar');wrap.dataset.sheep='';}
 const img=document.createElement('img');img.src=shepherd?'./shepherd.svg':'./sheep.svg';img.alt='';wrap.append(img);
 if(!shepherd)hydrateSheep(wrap);return wrap;
};
fetch('./sheep.svg').then(r=>{if(!r.ok)throw Error('Missing sheep asset');return r.text();}).then(text=>{
 const parsed=new DOMParser().parseFromString(text,'image/svg+xml');
 if(parsed.querySelector('parsererror'))throw Error('Invalid sheep asset');
 sheepSource=parsed.documentElement;document.querySelectorAll('[data-sheep]').forEach(hydrateSheep);
}).catch(()=>{});
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
let pointer=null,animationFrame=0;
function updateSheep(){
 animationFrame=0;
 document.querySelectorAll('[data-sheep]').forEach(wrap=>{
  const bounds=wrap.getBoundingClientRect();if(bounds.bottom<0||bounds.top>innerHeight)return;
  const x=pointer?Math.max(-1,Math.min(1,(pointer.x-bounds.left-bounds.width/2)/220)):0;
  const y=pointer?Math.max(-1,Math.min(1,(pointer.y-bounds.top-bounds.height/2)/220)):0;
  const body=wrap.querySelector('[data-part="body"]'),head=wrap.querySelector('[data-part="head"]'),eyes=wrap.querySelector('[data-part="eyes"]');
  if(body)body.setAttribute('transform',`translate(${x*.8} ${y*.4}) rotate(${x*1.5} 72 85)`);
  if(head)head.setAttribute('transform',`translate(${x*2} ${y*1.5}) rotate(${x*4} 47 49)`);
  if(eyes)eyes.setAttribute('transform',`translate(${x*1.4} ${y*1.1})`);
  wrap.dataset.gaze=x.toFixed(2)+','+y.toFixed(2);
 });
}
function scheduleSheep(){if(!animationFrame)animationFrame=requestAnimationFrame(updateSheep);}
document.addEventListener('pointermove',event=>{if(reducedMotion.matches||event.pointerType!=='mouse')return;pointer={x:event.clientX,y:event.clientY};scheduleSheep();},{passive:true});
function resetSheep(){pointer=null;scheduleSheep();}
document.documentElement.addEventListener('pointerleave',resetSheep);window.addEventListener('blur',resetSheep);reducedMotion.addEventListener('change',resetSheep);

const currentAgent=()=>state?.agents.find(a=>a.id===selectedAgent);
const terminalFor=a=>state?.terminals.findLast(t=>t.agentId===a.id&&t.direct&&(!t.provider||t.provider===a.provider))||state?.terminals.findLast(t=>t.agentId===a.id&&!t.direct&&(!t.provider||t.provider===a.provider));
const status=t=>!t?'可開始對話':t.state==='finished'?'已結束':t.parked?'待命，收到訊息後啟動':t.waitingCollaboration?'等待協作回報':!t.status?.app&&typeof t.status!=='string'?'啟動中，請查看主機提示':({working:'處理中',blocked:'等待你確認',idle:'待命',done:'回合結束',error:'發生錯誤'}[typeof t.status==='string'?t.status:t.status?.state]||'已啟動 · 狀態未回報');
const agentStatus=(a,t)=>!t&&state?.pendingAgents?.includes(a.id)?'啟動中':status(t);
const activityFor=(a,t)=>agentActivity(t,{pending:!!a&&state?.pendingAgents?.includes(a.id),starting:!a&&state?.control?.phase==='starting'});
function animateSheep(node,activity){node.classList.toggle('is-starting',activity==='starting');node.classList.toggle('is-working',activity==='working');}
let progressSnapshot='';
function renderReplyProgress(){
 const agent=currentAgent(),terminal=agent?terminalFor(agent):state?.terminals.find(t=>t.address===state.control?.terminal),name=agent?.name||state?.coordinatorName||'領頭羊';
 const progress=historyVisible?null:replyProgress({messages:state?.messages,agentId:agent?.id||null,terminal,name,posting,stopped:agent?state?.stoppedAgents?.includes(agent.id):state?.startupStopped});
 const box=$('reply-progress'),key=JSON.stringify([progress,selectedAgent]);if(key===progressSnapshot)return;progressSnapshot=key;box.hidden=!progress;box.replaceChildren();if(!progress)return;
 box.dataset.phase=progress.phase;const sheep=avatar(agent?.provider||'claude');animateSheep(sheep,progress.phase==='working'?'working':progress.phase==='sending'||progress.phase==='queued'?'starting':'');box.append(sheep,el('span','',progress.text));
 if(progress.animate){const dots=el('span','reply-dots');dots.setAttribute('aria-hidden','true');for(let i=0;i<3;i++)dots.append(el('i'));box.append(dots);}
}
const draftKey=()=>`herdr-draft:${selection.project}:${selection.chat}:${selectedAgent||'team'}`;
function persistDraft(){try{localStorage.setItem(draftKey(),$('draft').value);}catch{}}
function restoreDraft(){try{$('draft').value=localStorage.getItem(draftKey())||'';}catch{$('draft').value='';}updateSend();}
function updateSend(){$('send').disabled=posting||!state?.project||state?.projectAvailable===false||!$('draft').value.trim();fitDraft();}
function notice(text){$('notice').textContent=text;}
async function api(route,data){
 const response=await fetch('./api/'+route,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json','X-Herdr-CSRF':state?.csrfToken}:{},body:data?JSON.stringify({...selection,...data}):undefined});
 const result=await response.json();if(!response.ok)throw Error(result.error||'連線失敗');return result;
}
async function refresh(){
 const n=++revision;const q=new URLSearchParams();if(selection.project)q.set('project',selection.project);if(selection.chat)q.set('chat',selection.chat);
 try{
  const result=await api('state?'+q);if(n!==revision)return;
  const first=!state;state=result;$('reload-app').hidden=!result.uiBuild||result.uiBuild===UI_BUILD;selection.project=result.project||null;selection.chat=result.chat||null;
  const link=new URL(location.href);if(selection.project)link.searchParams.set('project',selection.project);if(selection.chat)link.searchParams.set('chat',selection.chat);if(selectedAgent)link.searchParams.set('agent',selectedAgent);else link.searchParams.delete('agent');history.replaceState(null,'',link);
  if(selectedAgent&&!currentAgent())selectedAgent=null;if(state.agentWorkspace&&!selectedAgent)selectedAgent=state.agents.find(a=>a.id===state.coordinatorAgentId)?.id||state.agents[0]?.id||null;
  render();if(first)restoreDraft();
 }catch(e){if(n===revision){notice(e.message);$('status').textContent='主機離線，請檢查 Tailscale';if(!state)$('members').replaceChildren(el('p','project-summary','暫時無法載入專案；請恢復主機連線，不必重建代理。'));}}
}
function switchAgent(id,focusDraft=true){historyVisible=false;persistDraft();selectedAgent=id;const link=new URL(location.href);if(id)link.searchParams.set('agent',id);else link.searchParams.delete('agent');history.replaceState(null,'',link);restoreDraft();render();document.body.classList.remove('show-sidebar');if(focusDraft)$('draft').focus();}
async function switchChat(project,chat,agent=null){try{persistDraft();await api('select',{project,chat});historyVisible=false;selection={project,chat};selectedAgent=agent;state=null;await refresh();restoreDraft();document.body.classList.remove('show-sidebar');}catch(e){notice(e.message);}}
let menuContext=null,dragAgent=null;
const protectedAgent=id=>id==='starter'||id==='__coordinator__';
const sidebarPrefs=()=>state?.sidebar||{revision:0,order:[...(!state?.agentWorkspace?['__coordinator__']:[]),...(state?.agents||[]).map(a=>a.id)],pinned:[]};
const visibleAgentIds=()=>{const s=sidebarPrefs();return[...s.order.filter(id=>s.pinned.includes(id)),...s.order.filter(id=>!s.pinned.includes(id))];};
async function saveSidebar(order,pinned,focusId){try{await api('sidebar',{revision:sidebarPrefs().revision,order,pinned});await refresh();if(focusId)document.querySelector('.member[data-agent="'+CSS.escape(focusId)+'"] .member-more')?.focus();}catch(e){notice(e.message);await refresh();}}
async function reorderAgent(id,beforeId,after=false){const s=sidebarPrefs();if(s.pinned.includes(id)!==s.pinned.includes(beforeId)){notice('置頂代理保留在上方；請先取消置頂，再跨區排序。');return;}const order=visibleAgentIds().filter(x=>x!==id),at=order.indexOf(beforeId);if(at<0)return;order.splice(at+(after?1:0),0,id);await saveSidebar(order,s.pinned,id);}
async function stepAgent(id,direction){const s=sidebarPrefs(),ids=visibleAgentIds().filter(x=>s.pinned.includes(x)===s.pinned.includes(id)),at=ids.indexOf(id),target=ids[at+direction];if(!target)return;const order=visibleAgentIds(),a=order.indexOf(id),b=order.indexOf(target);[order[a],order[b]]=[order[b],order[a]];await saveSidebar(order,s.pinned,id);}
function closeAgentMenu(focus=true){if(!menuContext)return;const button=menuContext.button;menuContext=null;$('agent-menu').hidden=true;button?.setAttribute('aria-expanded','false');if(focus&&button?.isConnected)button.focus();}
function openAgentMenu(id,button){closeAgentMenu(false);const a=id==='__coordinator__'?{id,name:state.coordinatorName||'領頭羊'}:state.agents.find(a=>a.id===id);if(!a)return;menuContext={id,button};const menu=$('agent-menu');menu.replaceChildren();
 const item=(text,action,disabled=false,danger=false)=>{const b=el('button','agent-menu-item'+(danger?' danger':''),text);b.type='button';b.setAttribute('role','menuitem');b.disabled=disabled;b.onclick=()=>{closeAgentMenu(false);action();};menu.append(b);};
 const prefs=sidebarPrefs(),pinned=prefs.pinned.includes(id);item(pinned?'取消置頂':'Pin 到頂端',()=>saveSidebar(prefs.order,pinned?prefs.pinned.filter(x=>x!==id):[...prefs.pinned,id],id));
 item('設定',()=>editAgent(a));item('重新命名',()=>{$('rename-error').textContent='';$('rename-name').value=a.name;$('rename-form').dataset.agent=id;$('rename-dialog').showModal();$('rename-name').focus();});
 item('移至其他專案…',()=>openAgentAction(id,'move'),protectedAgent(id)||state.coordinatorAgentId===id||state.projects.length<2);
 const group=visibleAgentIds().filter(x=>prefs.pinned.includes(x)===pinned),position=group.indexOf(id);menu.append(el('div','menu-divider'));item('向上移動',()=>stepAgent(id,-1),position<=0);item('向下移動',()=>stepAgent(id,1),position>=group.length-1);
 menu.append(el('div','menu-divider'));item(protectedAgent(id)?'領頭羊不能刪除':'刪除代理…',()=>openAgentAction(id,'delete'),protectedAgent(id)||state.coordinatorAgentId===id,true);
 menu.hidden=false;button.setAttribute('aria-expanded','true');const r=button.getBoundingClientRect(),w=216;menu.style.left=Math.max(8,Math.min(r.right-w,innerWidth-w-8))+'px';menu.style.top=Math.max(8,Math.min(r.bottom+5,innerHeight-menu.offsetHeight-8))+'px';menu.querySelector('button').focus();
}
function openAgentAction(id,action,targetProject){const a=state.agents.find(a=>a.id===id);if(!a)return;const form=$('agent-action-form');form.dataset.agent=id;form.dataset.action=action;$('agent-action-title').textContent=action==='move'?'轉移 '+a.name:'刪除 '+a.name;$('agent-action-copy').textContent=action==='move'?'將引擎、模型與職責設定移至目的專案。原對話與檔案保留，目標專案使用自己的會話；不會複製登入資料。':'移除這個專案中的角色設定，停止已核對的閒置會話；原對話與專案檔案保留。';$('move-target-label').hidden=action!=='move';$('move-target').required=action==='move';$('move-target').disabled=action!=='move';$('move-target').replaceChildren();for(const p of state.projects.filter(p=>p.id!==state.project&&p.available!==false)){const o=el('option','',p.name);o.value=p.id;$('move-target').append(o);}if(targetProject)$('move-target').value=targetProject;$('agent-action-submit').textContent=action==='move'?'移至專案':'刪除代理';$('agent-action-error').textContent='';$('agent-action-dialog').showModal();}
function renderNav(){
 if(menuContext)return;
 const snapshot=JSON.stringify([selection,selectedAgent,$('search').value,state?.projects,state?.agents,state?.terminals,state?.control,state?.pendingAgents,state?.sidebar]);if(snapshot===navSnapshot)return;navSnapshot=snapshot;closeAgentMenu(false);
 const nav=$('members');nav.replaceChildren();const query=$('search').value.toLocaleLowerCase().trim();
 for(const project of state?.projects||[]){const members=project.id===selection.project?state.agents:(project.agents||[]);if(query&&!`${project.name} ${members.map(a=>a.name+' '+providerName(a.provider)).join(' ')}`.toLocaleLowerCase().includes(query))continue;
  const total=members.length+(project.agentWorkspace?0:1),caption=el('button','project-caption');caption.append(el('span','project-name',project.name),el('span','project-agent-count',total+' 隻羊'));caption.setAttribute('aria-label',project.name+'，'+total+' 位代理');caption.dataset.project=project.id;caption.setAttribute('aria-pressed',String(project.id===selection.project));caption.onclick=()=>switchChat(project.id,project.chats.at(-1)?.id);
  caption.ondragover=e=>{if(dragAgent&&project.id!==selection.project&&!protectedAgent(dragAgent)){e.preventDefault();caption.classList.add('drag-over');}};caption.ondragleave=()=>caption.classList.remove('drag-over');caption.ondrop=e=>{e.preventDefault();caption.classList.remove('drag-over');if(dragAgent&&project.id!==selection.project)openAgentAction(dragAgent,'move',project.id);};nav.append(caption);if(project.id!==selection.project){
   const preview=[...(!project.agentWorkspace?[{id:null,name:project.coordinatorName||'領頭羊',provider:'claude'}]:[]),...members];
   const prefs=project.sidebar,ids=prefs?[...prefs.order.filter(id=>prefs.pinned.includes(id)),...prefs.order.filter(id=>!prefs.pinned.includes(id))]:preview.map(a=>a.id||'__coordinator__');for(const id of ids){const a=preview.find(a=>(a.id||'__coordinator__')===id);if(!a)continue;const b=el('button','project-member-preview');b.type='button';b.dataset.project=project.id;b.dataset.agent=a.id||'__coordinator__';b.append(avatar(a.provider||'claude'));const copy=el('span','member-copy');copy.append(el('strong','member-name',(prefs?.pinned.includes(id)?'Pin · ':'')+a.name),el('span','member-sub',providerName(a.provider)+' · 切換查看狀態'));b.append(copy);b.setAttribute('aria-label',project.name+'的'+a.name+'，切換查看狀態');b.onclick=()=>switchChat(project.id,project.chats.at(-1)?.id,a.id);nav.append(b);}continue;
  }
  for(const id of visibleAgentIds()){const a=id==='__coordinator__'?null:members.find(a=>a.id===id);if(id!=='__coordinator__'&&!a)continue;const lead=!a,name=a?.name||state.coordinatorName||'領頭羊',t=a?terminalFor(a):state.terminals.find(t=>t.address===state.control?.terminal),activity=activityFor(a,t),active=lead?!selectedAgent:selectedAgent===id;
   const row=el('div','member'+(active?' active':'')+(sidebarPrefs().pinned.includes(id)?' pinned':''));row.dataset.agent=id;row.draggable=true;
   const handle=el('span','drag-handle');handle.setAttribute('aria-hidden','true');row.append(handle);
   const b=el('button','member-main');b.type='button';b.setAttribute('aria-pressed',String(active));b.setAttribute('aria-label',name+(sidebarPrefs().pinned.includes(id)?'，已置頂':''));const sheep=avatar(a?.provider||'claude');animateSheep(sheep,activity);b.append(sheep);const copy=el('span','member-copy'),title=el('span','member-name',name+(state.coordinatorAgentId===id?' · 協調者':''));if(sidebarPrefs().pinned.includes(id)){const pin=document.createElementNS('http://www.w3.org/2000/svg','svg');pin.setAttribute('viewBox','0 0 24 24');pin.setAttribute('class','pin-mark');pin.setAttribute('aria-hidden','true');const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('d','M8 3h8l-1 7 4 4v2H5v-2l4-4-1-7ZM12 16v6');line.setAttribute('fill','none');line.setAttribute('stroke','currentColor');line.setAttribute('stroke-width','1.7');pin.append(line);title.prepend(pin);}copy.append(title,el('div','member-sub',lead?(t?status(t):'聊聊這個專案的目標'):`${modelLabel(a,t)} · ${agentStatus(a,t)}`));b.append(copy);
   const connected=agentConnected(t),dot=el('span','live-dot'+(connected?' is-connected':'')+(connected&&activity?' is-busy':''));dot.setAttribute('aria-hidden','true');dot.title=connected?'已連線':'未連線';b.append(dot);b.onclick=()=>switchAgent(lead?null:id);b.onkeydown=e=>{if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();stepAgent(id,e.key==='ArrowUp'?-1:1);}};row.append(b);
   const more=el('button','member-more','⋯');more.type='button';more.setAttribute('aria-label',name+'的操作選單');more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');more.onclick=()=>menuContext?.id===id?closeAgentMenu():openAgentMenu(id,more);row.append(more);
   row.ondragstart=e=>{if(e.target.closest('.member-more')){e.preventDefault();return;}dragAgent=id;row.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('application/x-herdr-agent',id);closeAgentMenu(false);};row.ondragend=()=>{dragAgent=null;row.classList.remove('dragging');document.querySelectorAll('.drag-over').forEach(n=>n.classList.remove('drag-over'));};row.ondragover=e=>{if(dragAgent&&dragAgent!==id){e.preventDefault();row.classList.add('drag-over');row.dataset.drop=e.clientY>row.getBoundingClientRect().top+row.offsetHeight/2?'after':'before';}};row.ondragleave=()=>row.classList.remove('drag-over');row.ondrop=e=>{e.preventDefault();row.classList.remove('drag-over');if(dragAgent&&dragAgent!==id)reorderAgent(dragAgent,id,row.dataset.drop==='after');};nav.append(row);
  }
 }
 if(!state?.projects.length)nav.append(el('div','project-summary','按右上角 ＋ 建立第一個專案。'));
}
function renderPasture(){
 const sheep=flock(state),key=JSON.stringify([selection,selectedAgent,sheep]);$('pasture').hidden=historyVisible;
 const counts={working:sheep.filter(a=>['working','starting'].includes(a.phase)).length,blocked:sheep.filter(a=>a.phase==='blocked').length,ready:sheep.filter(a=>a.phase==='ready').length};
 $('pasture-counts').textContent=counts.blocked?counts.blocked+' 等你確認':counts.working?counts.working+' 工作中':counts.ready+' 已連線';
 if(key===pastureSnapshot)return;pastureSnapshot=key;const area=$('pasture-flock');area.replaceChildren();
 for(const a of sheep){const b=el('button','pasture-sheep');b.type='button';b.dataset.phase=a.phase;b.dataset.agent=a.id||'__coordinator__';b.setAttribute('aria-pressed',String((a.id||null)===(selectedAgent||null)));b.setAttribute('aria-label',a.name+'，'+a.label);const figure=el('span','pasture-figure'),pet=avatar(a.provider||'claude');animateSheep(pet,a.phase==='working'?'working':a.phase==='starting'?'starting':'');figure.append(pet);const dot=el('span','live-dot'+(a.connected?' is-connected':'')+(a.connected&&a.phase==='working'?' is-busy':''));dot.setAttribute('aria-hidden','true');figure.append(dot);if(a.phase==='blocked')figure.append(el('span','sheep-alert','!'));b.append(figure,el('strong','',a.name),el('span','pasture-state',a.label));b.onclick=()=>switchAgent(a.id,false);area.append(b);}
}
function renderAttention(){
 const items=attentionItems(state),key=JSON.stringify([selection,items]);$('attention-panel').hidden=historyVisible||!items.length;
 if(key===attentionSnapshot)return;attentionSnapshot=key;$('attention-items').replaceChildren();
 for(const a of items){const row=el('div','attention-item');row.append(el('strong','',a.name),el('p','',a.detail));const action=el('button','','查看處理方式');action.type='button';action.onclick=()=>{switchAgent(a.agentId,false);$('permission-agent').textContent=a.name;$('permission-terminal').textContent=a.id;$('permission-command').textContent='~/.local/bin/hc attach '+a.id;$('permission-dialog').showModal();};row.append(action);$('attention-items').append(row);}
}
function renderTasks(){
 const tasks=taskCards(state,selectedAgent),totals=taskSummary(tasks),key=JSON.stringify([selection,selectedAgent,tasks]);$('task-checklist').hidden=historyVisible||!tasks.length;
 $('task-summary').textContent='任務進度'+(totals.attention?' · '+totals.attention+' 等待處理':totals.active?' · '+totals.active+' 進行中':totals.review?' · '+totals.review+' 待驗收':' · '+totals.verified+' 已驗收');
 if(key===checklistSnapshot)return;checklistSnapshot=key;const open=new Set([...$('task-items').querySelectorAll('details[open]')].map(n=>n.dataset.id));$('task-items').replaceChildren();
 const rank={blocked:0,stopped:1,working:2,delivered:3,queued:4,review:5,replied:6,done:7};
 for(const task of tasks.sort((a,b)=>rank[a.phase]-rank[b.phase])){const row=el('details','progress-card');row.dataset.id=task.id;row.dataset.phase=task.phase;row.open=open.has(task.id);const summary=el('summary'),title=el('span','task-title',task.title.slice(0,140)),badge=el('span','task-badge',taskLabels[task.phase]);summary.append(title,badge);row.append(summary,el('p','task-owner',(task.source?task.source+' → ':'')+task.owner));
  if(task.acceptance)row.append(el('p','','驗收條件：'+task.acceptance));if(task.verification)row.append(el('p','','驗收結果：'+task.verification));if(task.detail)row.append(el('p','',task.detail));
  if(task.phase==='review')row.append(el('p','','代理已回報，等待交付者核對；尚未驗收完成。'));
  if(task.kind!=='checklist'){const b=el('button','','前往代理對話');b.type='button';b.onclick=()=>switchAgent(task.agentId||null,false);row.append(b);}$('task-items').append(row);
 }
}
function render(){
 renderNav();const agent=currentAgent(),live=agent?terminalFor(agent):state.terminals.find(t=>t.address===state.control?.terminal);
 $('title').textContent=agent?.name||state.coordinatorName||'領頭羊';
 $('draft').placeholder=agent?`告訴 ${agent.name}，你想完成什麼…`:'告訴總控，你想完成什麼…';
 $('subtitle').textContent=agent?[agent.group,providerName(agent.provider),modelLabel(agent,live),agent.level==='manager'?'管理者':'工作代理'].filter(Boolean).join(' · '):`${state.projects.find(p=>p.id===selection.project)?.name||'專案協作'}`;
 $('recipient').textContent=agent?`交給 ${agent.name}`:'專案協作';
 $('edit-agent').hidden=true;
 $('status').textContent=state.coreError||(!state.appOpen?(state.backendMode==='background'?'背景服務未就緒，請查看主機設定':'請在主機開啟 Herdr，面板才會處理訊息'):state.startupStopped?'總控啟動已停止，等待你重新開啟':agent?`${providerName(agent.provider)} · ${agentStatus(agent,live)}`:live&&state.coordinatorReady===false?'總控尚未就緒，請在主機查看登入或資料夾信任提示':live?`總控 · ${status(live)}`:'隨時可以開始');
 $('retry-start').hidden=agent?!(state.stoppedAgents||[]).includes(agent.id):!state.startupStopped;$('retry-start').textContent=agent?'重新開啟代理':'重新開啟總控';
 if(!agent&&state.coordinatorParked&&!state.coreError&&state.appOpen)$('status').textContent='領頭羊待命，收到訊息後續接會話';
 $('counts').hidden=state.terminals.length===0;
 $('counts').textContent=`${state.agents.length+(state.agentWorkspace?0:1)} 位成員 · ${state.terminals.filter(t=>t.state==='live').length} 個執行中終端`;
 renderPasture();renderAttention();renderTasks();
 const all=state.messages||[],deliveries={};for(const e of all)if(e.kind==='delivery')deliveries[e.messageId]=e.delivery;
 const messages=all.filter(m=>m.kind!=='delivery'&&(details||m.kind!=='assignment')&&(details||!agent||m.role===agent.name||m.agentId===agent.id||m.target===agent.id||(live&&m.terminal===live.address)));
 $('welcome').hidden=historyVisible||messages.length>0;$('messages').hidden=historyVisible;$('history-panel').hidden=!historyVisible;document.querySelector('.compose-wrap').hidden=historyVisible;
 if(historyVisible){const list=$('history-list');list.replaceChildren();const p=state.projects.find(p=>p.id===selection.project);for(const [i,c]of(p?.chats||[]).entries()){const b=el('button','history-row',c.title==='新對話'?`對話 ${i+1}`:c.title);b.onclick=()=>switchChat(p.id,c.id);list.append(b);}}
 $('welcome-description').textContent=agent?agent.brief:'先和協調總控聊聊目標，其他夥伴需要時再加入。';
 const welcomeHeading=$('welcome').querySelector('h2');welcomeHeading.replaceChildren();welcomeHeading.textContent=agent?`交給${agent.name}的下一件事`:'今天，想和羊群完成什麼？';
 const stamp=JSON.stringify([selection,selectedAgent,details,historyVisible,state.coordinatorName,state.agents.map(a=>[a.id,a.name]),state.messagesRevision??messages]);
 const container=$('messages'),wasBottom=$('feed').scrollHeight-$('feed').scrollTop-$('feed').clientHeight<100;
 if(stamp!==messageSnapshot){messageSnapshot=stamp;container.replaceChildren();
 if(details){container.append(el('div','details-note','這個專案自行設定成員與職責，沒有固定部門或工作順序。每位代理都能直接對話，並在你授權後交付協作與驗收。角色設定不代表已啟動，queued 只代表排入等待。'));}
 for(const m of messages){
  const user=m.role==='你',row=el('article','message'+(user?' user':''));
  if(!user){const a=state.agents.find(a=>a.name===m.role||a.id===m.agentId);row.append(avatar(a?.provider||'claude'));}
  const bubble=el('div','message-bubble'),role=el('div','message-role',m.terminal===state.control?.terminal&&['Claude','Codex','總控'].includes(m.role)?state.coordinatorName||m.role:m.role||'總控');
  if(user&&m.messageId&&(deliveries[m.messageId]||m.delivery)!=='sent')role.append(el('span','message-time',m.direct?'等待代理接收':'等待總控處理'));
  if(m.time){const time=el('time','message-time',new Date(m.time).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'}));role.append(time);}
  bubble.append(role,formatMessage(document,m.text||''));row.append(bubble);if(user)row.append(avatar(null,true));container.append(row);
 }
 if(wasBottom&&messages.length)$('feed').scrollTop=$('feed').scrollHeight;}renderReplyProgress();if(wasBottom&&messages.length)$('feed').scrollTop=$('feed').scrollHeight;updateSend();
}
const suggestions=[['釐清目標','先一起想清楚要做什麼','請先協助我釐清這個專案的目標與限制：'],['開始協作','依任務安排適合的成員','請依這個專案已加入的代理與職責，協助以下目標：'],['核對成果','需要時再安排交叉檢查','請檢查以下成果，依需要安排已加入的代理交叉驗證：'],['整理資訊','把零散內容整理清楚','請協助整理以下內容，保留重點、待辦與需要確認的問題：']];
for(const [title,sub,prompt]of suggestions){const b=el('button','suggestion');b.type='button';b.append(el('strong','',title),el('small','',sub));b.onclick=()=>{$('draft').value=prompt;persistDraft();updateSend();$('draft').focus();};$('suggestions').append(b);}
$('draft').oninput=()=>{persistDraft();updateSend();};
$('draft').onkeydown=e=>{if(compactMode.matches)return;if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('composer').requestSubmit();}};
$('composer').onsubmit=async e=>{
 e.preventDefault();if(posting||!$('draft').value.trim()||!state?.project)return;
 const original=$('draft').value,a=currentAgent(),text=original;
 posting=true;updateSend();renderReplyProgress();
 const pendingKey=draftKey()+':pending';let pending;try{pending=JSON.parse(localStorage.getItem(pendingKey)||'null');}catch{}
 if(!pending||pending.text!==text)pending={text,id:crypto.randomUUID()};try{localStorage.setItem(pendingKey,JSON.stringify(pending));}catch{}
 try{const delivered=await api('message',{text,id:pending.id,...(a?{agentId:a.id}:{})});try{localStorage.removeItem(pendingKey);}catch{}$('draft').value='';persistDraft();if(delivered.direct&&delivered.target!==selectedAgent){selectedAgent=delivered.target;restoreDraft();}notice(delivered.direct?'訊息已排隊，將直接送給 '+(state.agents.find(x=>x.id===delivered.target)?.name||'選定代理')+'。':'訊息已排隊，等待總控接收。');await refresh();}catch(error){notice(error.message);}finally{posting=false;updateSend();renderReplyProgress();}
};
$('search').oninput=renderNav;
$('sidebar-toggle').onclick=()=>{if(matchMedia('(max-width:760px)').matches)document.body.classList.toggle('show-sidebar');else document.body.classList.toggle('hide-sidebar');};
$('details-toggle').onclick=()=>{$('team-dialog').close();historyVisible=false;details=!details;$('details-toggle').textContent=details?'一般對話':'詳細紀錄';render();};
function editAgent(agent=null){
 if(!state?.project){notice('請先建立工作專案。');return;}
 editing=agent?.id||null;const coordinator=editing==='__coordinator__';$('agent-dialog').querySelector('h2').textContent=coordinator?'總控名稱':'代理設定';$('agent-dialog').querySelectorAll('label').forEach(label=>label.hidden=coordinator&&!label.contains($('agent-name')));$('agent-model-observed').hidden=false;$('agent-name').value=agent?.name||'';$('agent-group').value=agent?.group||'';$('agent-brief').value=agent?.brief||'';$('agent-provider').value=coordinator?'claude':agent?.provider||'codex';$('agent-level').value=agent?.level||'worker';$('agent-model').value=coordinator?state.coordinatorPreferredModel||'claude-opus-5-5':agent?.model||'claude-opus-5-5';$('agent-model-label').hidden=$('agent-provider').value!=='claude';const observed=coordinator?state.coordinatorModel:terminalFor(agent||{})?.model;$('agent-model-observed').textContent=observed?'最近確認模型：'+(modelNames[observed]||observed):'尚未取得會話的模型確認；選項會保存為下次使用。';
 $('appoint-agent').hidden=!agent||coordinator;$('appoint-agent').disabled=state.coordinatorAgentId===agent?.id;$('remove-agent').hidden=true;$('remove-agent').disabled=!!agent&&!!terminalFor(agent);$('agent-dialog').showModal();
}
$('manage-team').onclick=openTeam;$('edit-agent').onclick=()=>editAgent(currentAgent()||{id:'__coordinator__',name:state?.coordinatorName||'領頭羊'});
$('close-dialog').onclick=$('cancel-dialog').onclick=()=>$('agent-dialog').close();
async function saveAgent(remove=false){
 if(editing==='__coordinator__'){let message='名稱已保存。';if($('agent-model').value!==(state.coordinatorPreferredModel||'claude-opus-5-5'))message=(await api('model',{model:$('agent-model').value})).message;await api('coordinator',{name:$('agent-name').value.trim()});$('agent-dialog').close();notice(message);await refresh();return;}
 const a={id:editing||'agent-'+crypto.randomUUID().slice(0,12),name:$('agent-name').value.trim(),group:$('agent-group').value.trim(),brief:$('agent-brief').value.trim(),provider:$('agent-provider').value,level:$('agent-level').value};
 let modelMessage='';if(!remove&&a.provider==='claude'){a.model=$('agent-model').value;const old=state.agents.find(x=>x.id===a.id);if(old?.provider==='claude'&&a.model!==(old.model||'claude-opus-5-5')){const result=await api('agent-model',{agentId:a.id,model:a.model});modelMessage=result.message;}}
 const agents=state.agents.filter(x=>x.id!==a.id);if(!remove)agents.push(a);
 await api('roster',{agents,rosterRevision:state.rosterRevision});selectedAgent=remove?null:a.id;$('agent-dialog').close();notice(modelMessage||'代理設定已保存。');await refresh();restoreDraft();
}
$('agent-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{await saveAgent();}catch(error){notice(error.message);}finally{b.disabled=false;}};
$('remove-agent').onclick=async()=>{try{await saveAgent(true);}catch(e){notice(e.message);}};
$('new-chat').onclick=async()=>{if(posting||!state?.project)return;try{const next=await api('chat',{});await switchChat(next.project,next.chat);notice('已建立空白對話，尚未啟動代理。');}catch(e){notice(e.message);}};
window.addEventListener('beforeunload',persistDraft);
refresh();setInterval(()=>{if(!document.hidden&&!posting)refresh();},4000);

$('new-project').onclick=()=>{$('project-name').value='';$('project-dialog').showModal();};
$('project-cancel').onclick=()=>$('project-dialog').close();
$('project-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const result=await api('project',{name:$('project-name').value.trim()});$('project-dialog').close();await switchChat(result.project,result.chat);notice('專案已建立。加入需要的代理，自行設定職責。');}catch(error){notice(error.message);}finally{button.disabled=false;}};

$('hero-sheep').append(avatar('claude'));
$('search-toggle').onclick=()=>{const show=$('search-wrap').hidden;$('search-wrap').hidden=!show;if(show)$('search').focus();else{$('search').value='';renderNav();}};
$('quick-new-chat').onclick=()=>$('new-chat').click();
function openTeam(){ $('project-rename').value=state?.projects.find(p=>p.id===selection.project)?.name||'';
 const drive=state?.drive;
 $('storage-status').textContent=drive?.status==='configured'?'Google Drive 資料夾已設定；雲端上傳狀態由 Drive 桌面版確認。':drive?.status==='needs_login'?'Google Drive 需要重新登入，原檔已保留。':'Google Drive 未連線：請先在主機完成官方桌面版登入。';
 $('storage-folder').value=drive?.folder||'';
 $('storage-form').hidden=state?.backendMode!=='background';

 const p=state?.projects.find(p=>p.id===selection.project);$('team-project-name').textContent=p?.name||'請先建立專案';
 const list=$('team-member-list');list.replaceChildren();
 if(!state.agentWorkspace){const director=el('div','team-row');director.append(avatar('claude'),el('span','',state.coordinatorName||'領頭羊'));const rename=el('button','','改名');rename.onclick=()=>{$('team-dialog').close();editAgent({id:'__coordinator__',name:state.coordinatorName||'領頭羊'});};list.append(director);}
 for(const a of state?.agents||[]){const row=el('div','team-row');row.append(avatar(a.provider),el('span','',a.name));const b=el('button','','設定');b.onclick=()=>{$('team-dialog').close();editAgent(a);};list.append(row);}
 $('team-add').disabled=!p;$('team-history').disabled=!p;$('team-dialog').showModal();
}
$('team-close').onclick=()=>$('team-dialog').close();
$('team-add').onclick=()=>{$('team-dialog').close();editAgent();};
$('team-history').onclick=()=>{$('team-dialog').close();historyVisible=true;render();};

$('sidebar-add-agent').onclick=()=>editAgent();

// A focused drawer on phones, a persistent rail on iPad and desktop.
function closeDrawer(restoreFocus=true){document.body.classList.remove('show-sidebar');if(restoreFocus)$('sidebar-toggle').focus();}
function openDrawer(){document.body.classList.remove('hide-sidebar');document.body.classList.add('show-sidebar');$('sidebar-close').focus();}
$('sidebar-toggle').onclick=()=>{if(compactMode.matches){if(document.body.classList.contains('show-sidebar'))closeDrawer();else openDrawer();}else document.body.classList.toggle('hide-sidebar');};
$('sidebar-close').onclick=()=>closeDrawer();$('sidebar-backdrop').onclick=()=>closeDrawer();
document.addEventListener('keydown',e=>{
 if(!compactMode.matches||!document.body.classList.contains('show-sidebar')||document.querySelector('dialog[open]'))return;
 if(e.key==='Escape'){e.preventDefault();closeDrawer();return;}
 if(e.key==='Tab'){
  const list=Array.from($('sidebar').querySelectorAll('button,input')).filter(n=>!n.disabled&&n.getClientRects().length);
  const first=list[0],last=list.at(-1);if(!first)return;
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
 }
});
compactMode.addEventListener('change',()=>{document.body.classList.remove('show-sidebar','hide-sidebar');});
let draftMeasure='';
function fitDraft(){const input=$('draft'),measure=input.value+'\n'+input.clientWidth;if(measure===draftMeasure)return;draftMeasure=measure;input.style.height='auto';input.style.height=Math.min(input.scrollHeight,128)+'px';}
if('ResizeObserver' in window)new ResizeObserver(()=>fitDraft()).observe($('composer'));
bindViewport(window,document);
document.documentElement.dataset.layoutBuild=UI_BUILD;

// Install only the app shell. Conversations, credentials and task requests stay online.
if('serviceWorker' in navigator && location.protocol==='https:') {
 navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'}).catch(()=>notice('暫時無法啟用主畫面 App；你仍可使用網頁。'));
}

fitDraft();

$('storage-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{await api('storage',{folder:$('storage-folder').value.trim()});await refresh();notice('已設定新專案的 Drive 資料夾；雲端同步請查看 Drive 桌面版。');$('storage-status').textContent='Google Drive 資料夾已設定；雲端同步請查看 Drive 桌面版。';}catch(error){notice(error.message);}finally{b.disabled=false;}};

$('copy-layout').onclick=async()=>{
 const text=JSON.stringify(layoutDiagnostics(window,document),null,2);
 $('layout-diagnostics').textContent=text;$('layout-diagnostics').hidden=false;
 try{await navigator.clipboard.writeText(text);notice('已複製版面診斷，內容只有視窗尺寸，不含對話。');}catch{notice('無法自動複製，可選取下方的版面診斷文字。');}
};

$('copy-chat-link').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);notice('已複製目前專案與對話連結；在另一台同 Tailnet 裝置開啟即可。');}catch{notice('請複製目前網址，連結已包含專案與對話位置。');}};

$('retry-start').onclick=async()=>{const button=$('retry-start');button.disabled=true;try{await api(currentAgent()?'retry-agent':'retry-start',currentAgent()?{agentId:currentAgent().id}:{});notice('已請求重新開啟；登入、信任與權限仍需你親自確認。');await refresh();}catch(error){notice(error.message);}finally{button.disabled=false;}};

$('project-rename-form').onsubmit=async e=>{e.preventDefault();try{await api('project-name',{name:$('project-rename').value.trim()});await refresh();$('team-project-name').textContent=$('project-rename').value.trim();notice('專案名稱已保存。');}catch(error){notice(error.message);}};

$('agent-level').onchange=()=>{if($('agent-level').value==='manager'){$('agent-provider').value='claude';$('agent-model').value='claude-opus-5-5';$('agent-model-label').hidden=false;}};
$('agent-provider').onchange=()=>{$('agent-model-label').hidden=$('agent-provider').value!=='claude';};

$('appoint-agent').onclick=async()=>{try{const result=await api('appoint',{agentId:editing});$('agent-dialog').close();selectedAgent=editing;notice(result.providerChanged?'已任命協調者；依你的設定，管理者下次使用 Claude Opus 5.5。':result.modelApplied?'已任命協調者，CLI 已確認使用 Opus 5.5。':'已任命協調者，下次開啟使用 Opus 5.5。');await refresh();}catch(error){notice(error.message);}};

$('reload-app').onclick=()=>{persistDraft();location.reload();};

$('rename-cancel').onclick=()=>$('rename-dialog').close();
$('rename-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{const id=e.currentTarget.dataset.agent,name=$('rename-name').value.trim();if(id==='__coordinator__')await api('coordinator',{name});else await api('roster',{rosterRevision:state.rosterRevision,agents:state.agents.map(a=>a.id===id?{...a,name}:a)});$('rename-dialog').close();await refresh();notice('名稱已保存。');}catch(error){$('rename-error').textContent=error.message;}finally{b.disabled=false;}};
$('agent-action-cancel').onclick=()=>$('agent-action-dialog').close();
$('agent-action-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{const {agent:agentId,action}=e.currentTarget.dataset;await api('agent-manage',{agentId,action,targetProject:action==='move'?$('move-target').value:undefined,rosterRevision:state.rosterRevision});$('agent-action-dialog').close();if(selectedAgent===agentId){persistDraft();selectedAgent=null;restoreDraft();}await refresh();notice(action==='move'?'代理已轉移；原對話與檔案保留。':'代理設定已刪除；原對話與檔案保留。');}catch(error){$('agent-action-error').textContent=error.message;}finally{b.disabled=false;}};
document.addEventListener('pointerdown',e=>{if(menuContext&&!e.target.closest('#agent-menu')&&!e.target.closest('.member-more'))closeAgentMenu(false);});
document.addEventListener('keydown',e=>{if(!menuContext)return;if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeAgentMenu();return;}if(e.key==='Tab'){closeAgentMenu();return;}const buttons=[...$('agent-menu').querySelectorAll('button:not(:disabled)')],at=buttons.indexOf(document.activeElement);if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(at+(e.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();}},true);
$('members').addEventListener('scroll',()=>closeAgentMenu(false),{passive:true});window.addEventListener('resize',()=>closeAgentMenu(false),{passive:true});

$('permission-close').onclick=()=>$('permission-dialog').close();
$('pasture').addEventListener('toggle',()=>{try{localStorage.setItem('herdr-pasture-open',String($('pasture').open));}catch{}});try{if(localStorage.getItem('herdr-pasture-open')==='false')$('pasture').open=false;}catch{}
let notificationSub=null;
async function notificationStatus(){
 const supported='Notification' in window&&'serviceWorker' in navigator&&'PushManager' in window;
 $('notification-diagnostics').textContent='版本 '+UI_BUILD+' · 系統權限：'+(supported?Notification.permission:'不支援');$('enable-notifications').disabled=!supported;$('notification-status').textContent=supported?'通知尚未開啟':'此瀏覽器不支援通知；iPhone 請從主畫面開啟 Herdr。';
 if(!supported)return;try{const reg=await navigator.serviceWorker.getRegistration();notificationSub=await reg?.pushManager.getSubscription();const s=notificationSub?await api('notifications',{action:'status',endpoint:notificationSub.endpoint}):null;$('notification-diagnostics').textContent+=' · 裝置訂閱：'+(notificationSub?'有':'無');$('enable-notifications').hidden=!!s?.subscribed;$('disable-notifications').hidden=!notificationSub;$('test-notifications').hidden=!s?.subscribed;$('notification-status').textContent=s?.subscribed?(s.lastError||'此對話通知已開啟；可傳送測試通知確認這台裝置實際收到。'):Notification.permission==='denied'?'通知已被此裝置封鎖，可到系統／瀏覽器設定調整；頁內提醒仍可用。':'尚未為此對話開啟通知。';}catch{$('notification-status').textContent='暫時無法讀取通知設定，請稍後再試。';}
}
$('enable-notifications').onclick=async()=>{
 const button=$('enable-notifications');button.disabled=true;let step='系統通知授權';
 try{const permission=Notification.permission==='granted'?Promise.resolve('granted'):Notification.requestPermission();if(await permission!=='granted'){await notificationStatus();return;}
 step='連線主機';$('notification-status').textContent='正在向主機登記通知…';const key=await api('notifications-key');
 step='啟用裝置推播';const reg=await navigator.serviceWorker.ready;const bytes=Uint8Array.from(atob(key.publicKey.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));notificationSub=await reg.pushManager.getSubscription()||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
 step='保存通知訂閱';await api('notifications',{action:'subscribe',subscription:notificationSub.toJSON()});await notificationStatus();
 }catch(error){const reason=['NotAllowedError','InvalidStateError','NetworkError','AbortError','NotSupportedError'].includes(error.name)?'（'+error.name+'）':'';$('notification-status').textContent=step+'未完成'+reason+'。請重試；若仍失敗，回報這段文字即可。';$('notification-diagnostics').textContent='版本 '+UI_BUILD+' · 系統權限：'+Notification.permission+' · 裝置訂閱：'+(notificationSub?'有':'無');}finally{button.disabled=false;}
};
$('disable-notifications').onclick=async()=>{try{if(notificationSub){await api('notifications',{action:'unsubscribe',endpoint:notificationSub.endpoint});await notificationSub.unsubscribe();notificationSub=null;}await notificationStatus();}catch{$('notification-status').textContent='關閉通知失敗，請重試。';}};
$('test-notifications').onclick=async()=>{const b=$('test-notifications');b.disabled=true;try{await api('notifications',{action:'test',endpoint:notificationSub?.endpoint});$('notification-status').textContent='通知服務已接受測試；請確認裝置有實際收到，這還不代表送達。';}catch{$('notification-status').textContent='測試通知未送出，請檢查通知設定與主機連線。';}finally{b.disabled=false;}};
$('manage-team').addEventListener('click',()=>{$('settings-pasture').checked=$('pasture').open;notificationStatus();});
$('settings-pasture').onchange=()=>$('pasture').open=$('settings-pasture').checked;

$('show-pasture').onclick=()=>{historyVisible=false;render();$('pasture').open=true;$('pasture').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});$('pasture').querySelector('summary').focus({preventScroll:true});};
