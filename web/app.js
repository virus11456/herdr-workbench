import {formatMessage} from './format.mjs';
'use strict';
const $=id=>document.getElementById(id);
const providers={claude:'Claude',codex:'Codex',minimax:'MiniMax'};
const compactMode=matchMedia('(max-width:767px), (max-width:1023px) and (max-height:520px)');
let state=null,selection={project:null,chat:null},selectedAgent=null,details=false,historyVisible=false,editing=null,posting=false,revision=0;
const el=(tag,className,text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;};
let sheepSource=null,navSnapshot='',messageSnapshot='',checklistSnapshot='';
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
const terminalFor=a=>state?.terminals.find(t=>t.agentId===a.id);
const status=t=>!t?'尚未啟動':t.state==='finished'?'已結束':({working:'處理中',blocked:'等待你確認',idle:'待命',done:'回合結束',error:'發生錯誤'}[typeof t.status==='string'?t.status:t.status?.state]||'已啟動 · 狀態未回報');
const draftKey=()=>`herdr-draft:${selection.project}:${selection.chat}:${selectedAgent||'team'}`;
function persistDraft(){try{localStorage.setItem(draftKey(),$('draft').value);}catch{}}
function restoreDraft(){try{$('draft').value=localStorage.getItem(draftKey())||'';}catch{$('draft').value='';}updateSend();}
function updateSend(){$('send').disabled=posting||!state?.project||state?.projectAvailable===false||!$('draft').value.trim();}
function notice(text){$('notice').textContent=text;}
async function api(route,data){
 const response=await fetch('./api/'+route,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json','X-Herdr-CSRF':state?.csrfToken}:{},body:data?JSON.stringify({...selection,...data}):undefined});
 const result=await response.json();if(!response.ok)throw Error(result.error||'連線失敗');return result;
}
async function refresh(){
 const n=++revision;const q=new URLSearchParams();if(selection.project)q.set('project',selection.project);if(selection.chat)q.set('chat',selection.chat);
 try{
  const result=await api('state?'+q);if(n!==revision)return;
  const first=!state;state=result;selection.project=result.project||null;selection.chat=result.chat||null;
  if(selectedAgent&&!currentAgent())selectedAgent=null;
  render();if(first)restoreDraft();
 }catch(e){if(n===revision){notice(e.message);$('status').textContent='連線尚未就緒';}}
}
function switchAgent(id){historyVisible=false;persistDraft();selectedAgent=id;restoreDraft();render();document.body.classList.remove('show-sidebar');$('draft').focus();}
async function switchChat(project,chat){historyVisible=false;persistDraft();selection={project,chat};selectedAgent=null;state=null;await refresh();restoreDraft();document.body.classList.remove('show-sidebar');}
function renderNav(){
 const snapshot=JSON.stringify([selection,selectedAgent,$('search').value,state?.projects,state?.agents,state?.terminals,state?.control]);if(snapshot===navSnapshot)return;navSnapshot=snapshot;
 const nav=$('members');nav.replaceChildren();const query=$('search').value.toLocaleLowerCase().trim();
 const heading=name=>nav.append(el('div','section-label',name));
 const member=(name,subtitle,provider,active,action,live)=>{
  const b=el('button','member'+(active?' active':''));b.type='button';b.setAttribute('aria-pressed',String(active));
  b.append(avatar(provider));
  const copy=el('span','member-copy');copy.append(el('span','member-name',name),el('div','member-sub',subtitle));b.append(copy);
  if(live)b.append(el('span','live-dot'));b.onclick=action;nav.append(b);
 };
 for(const project of state?.projects||[]){
  const members=project.id===selection.project?state.agents:(project.agents||[]);
  if(query&&!`${project.name} ${members.map(a=>a.name+' '+providers[a.provider]).join(' ')}`.toLocaleLowerCase().includes(query))continue;
  const caption=el('button','project-caption',project.name);caption.onclick=()=>switchChat(project.id,project.chats.at(-1)?.id);nav.append(caption);
  const current=project.id===selection.project,lead=current?state.terminals.find(t=>t.address===state.control?.terminal):null;
  if(!current)continue;
  const open=async agent=>{if(selection.project!==project.id)await switchChat(project.id,project.chats.at(-1)?.id);switchAgent(agent?.id||null);};
  member(project.coordinatorName||'協調總控',lead?status(lead):'聊聊這個專案的目標','claude',current&&!selectedAgent,()=>open(null),lead?.state==='live');
  for(const a of members){const t=current?terminalFor(a):null;member(a.name,t?status(t):`${providers[a.provider]} · 尚未啟動`,a.provider,current&&selectedAgent===a.id,()=>open(a),t?.state==='live');}
 }
 if(!state?.projects.length)nav.append(el('div','project-summary','按右上角 ＋ 建立第一個專案。'));

}
function render(){
 renderNav();const agent=currentAgent(),live=agent?terminalFor(agent):state.terminals.find(t=>t.address===state.control?.terminal);
 $('title').textContent=agent?.name||state.coordinatorName||'協調總控';
 $('subtitle').textContent=agent?`${agent.group} · ${providers[agent.provider]} · ${agent.level==='manager'?'小組主管':'工作代理'}`:`${state.projects.find(p=>p.id===selection.project)?.name||'專案協作'}`;
 $('recipient').textContent=agent?`交給 ${agent.name}`:'專案協作';
 $('edit-agent').hidden=true;
 $('status').textContent=state.coreError||(!state.appOpen?(state.backendMode==='background'?'背景服務未就緒，請查看主機設定':'請在主機開啟 Herdr，面板才會處理訊息'):agent?`${providers[agent.provider]} · ${status(live)}`:live?`總控 · ${status(live)}`:'隨時可以開始');
 $('counts').hidden=state.terminals.length===0;
 $('counts').textContent=`${state.agents.length+1} 位成員 · ${state.terminals.filter(t=>t.state==='live').length} 個執行中終端`;
 const tasks=state.checklist?.items||[],taskStamp=JSON.stringify([selection,state.checklist]);
 $('task-checklist').hidden=historyVisible||!tasks.length;
 if(taskStamp!==checklistSnapshot){checklistSnapshot=taskStamp;$('task-summary').textContent=`任務清單 · ${tasks.filter(t=>t.status==='done').length}/${tasks.length} 已核對完成`;
  $('task-items').replaceChildren();for(const task of tasks){const row=el('div','task-item'),labels={pending:'待處理',in_progress:'進行中',blocked:'等待處理',done:'已核對完成'};
   row.append(el('strong','',task.title),el('p','',`${task.owner} · ${labels[task.status]||task.status}`),el('p','','驗收：'+task.acceptance));
   if(task.reason)row.append(el('p','','待處理：'+task.reason));if(task.verification)row.append(el('p','','核對：'+task.verification));
   for(const proof of task.evidence||[])row.append(el('code','',`${proof.path||'終端讀取紀錄'} · SHA-256 ${proof.sha256}`));$('task-items').append(row);
  }
 }
 const all=state.messages||[],deliveries={};for(const e of all)if(e.kind==='delivery')deliveries[e.messageId]=e.delivery;
 const messages=all.filter(m=>m.kind!=='delivery'&&(details||m.kind!=='assignment')&&(details||!agent||m.role===agent.name||m.agentId===agent.id||m.target===agent.id||(live&&m.terminal===live.address)));
 $('welcome').hidden=historyVisible||messages.length>0;$('messages').hidden=historyVisible;$('history-panel').hidden=!historyVisible;document.querySelector('.compose-wrap').hidden=historyVisible;
 if(historyVisible){const list=$('history-list');list.replaceChildren();const p=state.projects.find(p=>p.id===selection.project);for(const [i,c]of(p?.chats||[]).entries()){const b=el('button','history-row',c.title==='新對話'?`對話 ${i+1}`:c.title);b.onclick=()=>switchChat(p.id,c.id);list.append(b);}}
 $('welcome-description').textContent=agent?agent.brief:'先和協調總控聊聊目標，其他夥伴需要時再加入。';
 const welcomeHeading=$('welcome').querySelector('h2');welcomeHeading.replaceChildren();welcomeHeading.textContent=agent?`交給${agent.name}的下一件事`:'今天，想和羊群完成什麼？';
 const stamp=JSON.stringify([selection,selectedAgent,details,historyVisible,state.coordinatorName,state.agents.map(a=>[a.id,a.name]),state.messagesRevision??messages]);
 const container=$('messages'),wasBottom=$('feed').scrollHeight-$('feed').scrollTop-$('feed').clientHeight<100;
 if(stamp!==messageSnapshot){messageSnapshot=stamp;container.replaceChildren();
 if(details){container.append(el('div','details-note','這個專案自行設定成員與職責，沒有固定部門或工作順序。代理能提出協作請求，由目前總控統一執行。角色設定不代表已啟動，queued 只代表排入等待。'));}
 for(const m of messages){
  const user=m.role==='你',row=el('article','message'+(user?' user':''));
  if(!user){const a=state.agents.find(a=>a.name===m.role||a.id===m.agentId);row.append(avatar(a?.provider||'claude'));}
  const bubble=el('div','message-bubble'),role=el('div','message-role',m.terminal===state.control?.terminal&&['Claude','Codex','總控'].includes(m.role)?state.coordinatorName||m.role:m.role||'總控');
  if(user&&m.messageId&&(deliveries[m.messageId]||m.delivery)!=='sent')role.append(el('span','message-time','等待總控處理'));
  if(m.time){const time=el('time','message-time',new Date(m.time).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'}));role.append(time);}
  bubble.append(role,formatMessage(document,m.text||''));row.append(bubble);if(user)row.append(avatar(null,true));container.append(row);
 }
 if(wasBottom&&messages.length)$('feed').scrollTop=$('feed').scrollHeight;}updateSend();
}
const suggestions=[['釐清目標','先一起想清楚要做什麼','請先協助我釐清這個專案的目標與限制：'],['開始協作','依任務安排適合的成員','請依這個專案已加入的代理與職責，協助以下目標：'],['核對成果','需要時再安排交叉檢查','請檢查以下成果，依需要安排已加入的代理交叉驗證：'],['整理資訊','把零散內容整理清楚','請協助整理以下內容，保留重點、待辦與需要確認的問題：']];
for(const [title,sub,prompt]of suggestions){const b=el('button','suggestion');b.type='button';b.append(el('strong','',title),el('small','',sub));b.onclick=()=>{$('draft').value=prompt;persistDraft();updateSend();$('draft').focus();};$('suggestions').append(b);}
$('draft').oninput=()=>{persistDraft();updateSend();};
$('draft').onkeydown=e=>{if(compactMode.matches)return;if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('composer').requestSubmit();}};
$('composer').onsubmit=async e=>{
 e.preventDefault();if(posting||!$('draft').value.trim()||!state?.project)return;
 const original=$('draft').value,a=currentAgent(),text=a&&!/^@/.test(original.trim())?`@${a.id} ${original}`:original;
 posting=true;updateSend();
 const pendingKey=draftKey()+':pending';let pending;try{pending=JSON.parse(localStorage.getItem(pendingKey)||'null');}catch{}
 if(!pending||pending.text!==text)pending={text,id:crypto.randomUUID()};try{localStorage.setItem(pendingKey,JSON.stringify(pending));}catch{}
 try{await api('message',{text,id:pending.id});try{localStorage.removeItem(pendingKey);}catch{}$('draft').value='';persistDraft();notice('已排入訊息佇列；等待總控接收，尚未代表任務完成。');await refresh();}catch(error){notice(error.message);}finally{posting=false;updateSend();}
};
$('search').oninput=renderNav;
$('sidebar-toggle').onclick=()=>{if(matchMedia('(max-width:760px)').matches)document.body.classList.toggle('show-sidebar');else document.body.classList.toggle('hide-sidebar');};
$('details-toggle').onclick=()=>{$('team-dialog').close();historyVisible=false;details=!details;$('details-toggle').textContent=details?'一般對話':'詳細紀錄';render();};
function editAgent(agent=null){
 if(!state?.project){notice('請先建立工作專案。');return;}
 editing=agent?.id||null;const coordinator=editing==='__coordinator__';$('agent-dialog').querySelector('h2').textContent=coordinator?'總控名稱':'代理設定';$('agent-dialog').querySelectorAll('label').forEach(label=>label.hidden=coordinator&&!label.contains($('agent-name')));$('agent-dialog').querySelector('.help').hidden=coordinator;$('agent-name').value=agent?.name||'';$('agent-group').value=agent?.group||'';$('agent-brief').value=agent?.brief||'';$('agent-provider').value=agent?.provider||'codex';$('agent-level').value=agent?.level||'worker';
 $('remove-agent').hidden=!agent||coordinator;$('remove-agent').disabled=!!agent&&!!terminalFor(agent);$('agent-dialog').showModal();
}
$('manage-team').onclick=openTeam;$('edit-agent').onclick=()=>editAgent(currentAgent());
$('close-dialog').onclick=$('cancel-dialog').onclick=()=>$('agent-dialog').close();
async function saveAgent(remove=false){
 if(editing==='__coordinator__'){await api('coordinator',{name:$('agent-name').value.trim()});$('agent-dialog').close();notice('名稱已保存。');await refresh();return;}
 const a={id:editing||'agent-'+crypto.randomUUID().slice(0,12),name:$('agent-name').value.trim(),group:$('agent-group').value.trim(),brief:$('agent-brief').value.trim(),provider:$('agent-provider').value,level:$('agent-level').value};
 const agents=state.agents.filter(x=>x.id!==a.id);if(!remove)agents.push(a);
 await api('roster',{agents});selectedAgent=remove?null:a.id;$('agent-dialog').close();notice('角色設定已保存，尚未啟動代理。');await refresh();restoreDraft();
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
function openTeam(){
 const drive=state?.drive;
 $('storage-status').textContent=drive?.status==='configured'?'Google Drive 資料夾已設定；雲端上傳狀態由 Drive 桌面版確認。':drive?.status==='needs_login'?'Google Drive 需要重新登入，原檔已保留。':'Google Drive 未連線：請先在主機完成官方桌面版登入。';
 $('storage-folder').value=drive?.folder||'';
 $('storage-form').hidden=state?.backendMode!=='background';

 const p=state?.projects.find(p=>p.id===selection.project);$('team-project-name').textContent=p?.name||'請先建立專案';
 const list=$('team-member-list');list.replaceChildren();
 const director=el('div','team-row');director.append(avatar('claude'),el('span','',state.coordinatorName||'協調總控'));const rename=el('button','','改名');rename.onclick=()=>{$('team-dialog').close();editAgent({id:'__coordinator__',name:state.coordinatorName||'協調總控'});};director.append(rename);list.append(director);
 for(const a of state?.agents||[]){const row=el('div','team-row');row.append(avatar(a.provider),el('span','',a.name));const b=el('button','','設定');b.onclick=()=>{$('team-dialog').close();editAgent(a);};row.append(b);list.append(row);}
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
function fitDraft(){const input=$('draft');input.style.height='auto';input.style.height=Math.min(input.scrollHeight,128)+'px';}
const oldDraftInput=$('draft').oninput;$('draft').oninput=event=>{oldDraftInput(event);fitDraft();};
function syncViewport(){
 const view=window.visualViewport;
 const height=view&&view.scale===1&&['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)?Math.min(innerHeight,view.height):innerHeight;
 document.documentElement.style.setProperty('--app-height',height+'px');
}
window.addEventListener('pageshow',syncViewport,{passive:true});
window.addEventListener('orientationchange',syncViewport,{passive:true});

$('draft').addEventListener('focus',syncViewport);$('draft').addEventListener('blur',syncViewport);
window.addEventListener('resize',syncViewport,{passive:true});window.visualViewport?.addEventListener('resize',syncViewport,{passive:true});syncViewport();

// Install only the app shell. Conversations, credentials and task requests stay online.
if('serviceWorker' in navigator && location.protocol==='https:') {
 navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'}).catch(()=>notice('暫時無法啟用主畫面 App；你仍可使用網頁。'));
}

fitDraft();

$('title').setAttribute('role','button');$('title').tabIndex=0;$('title').setAttribute('aria-label','變更代理名稱');
const renameCurrent=()=>editAgent(currentAgent()||{id:'__coordinator__',name:state?.coordinatorName||'協調總控'});
$('title').onclick=renameCurrent;$('title').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();renameCurrent();}};

$('storage-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{await api('storage',{folder:$('storage-folder').value.trim()});await refresh();notice('已設定新專案的 Drive 資料夾；雲端同步請查看 Drive 桌面版。');$('storage-status').textContent='Google Drive 資料夾已設定；雲端同步請查看 Drive 桌面版。';}catch(error){notice(error.message);}finally{b.disabled=false;}};
