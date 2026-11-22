import {bindViewport,layoutDiagnostics} from './viewport.mjs';
import {formatMessage} from './format.mjs';
import {attentionItems,taskCards,taskSummary,taskLabels} from './tasks.mjs';
import {agentConnected,agentActivity,replyProgress} from './activity.mjs';
'use strict';
const $=id=>document.getElementById(id);
const UI_BUILD='20261122-scroll44';
const legacyAgent='__coordinator__';
const providers={claude:'Claude',codex:'Codex',minimax:'MiniMax',antigravity:'Google / Antigravity'};
const providerName=value=>providers[value]||value||'代理';
const modelNames={'claude-opus-5-5':'Opus 5.5','claude-fable-5-2':'Fable 5.2'};
const modelName=model=>modelNames[model]||model;
function modelLabel(agent,terminal,last){
 if(terminal?.modelObserved&&terminal.model)return modelName(terminal.model);
 const preferred=agent.provider==='claude'?(agent.model||'claude-opus-5-5'):null;
 if(preferred&&preferred!==last?.model)return '下次：'+modelName(preferred);
 if(last?.provider===agent.provider&&last.model)return '上次：'+modelName(last.model);
 return providerName(agent.provider);
}
const activeProject=()=>state?.projects.find(p=>p.id===selection.project);
const sidebarStatus=(agent,terminal)=>{
 if(!terminal)return '收到訊息後啟動';
 if(terminal.state==='live'&&terminal.status?.state==='done'&&!terminal.waitingCollaboration)return '待命';
 return agentStatus(agent,terminal);
};
function appendModelLabel(copy,label,currentStatus){
 const model=el('span','member-model',label);model.title=label;
 copy.append(model,el('span','member-sub',currentStatus));
}
const compactMode=matchMedia('(max-width:767px), (max-width:1023px) and (max-height:520px)');
const initialQuery=new URLSearchParams(location.search);
let state=null,selection={project:initialQuery.get('project'),chat:initialQuery.get('chat')},selectedAgent=initialQuery.get('agent'),details=false,editing=null,posting=false,navigating=false,revision=0;
const el=(tag,className,text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;};
let sheepSource=null,navSnapshot='',messageSnapshot='',checklistSnapshot='',attentionSnapshot='';
let olderMessages=[],historyBefore=null,historyLoading=false;
let updates=null,updatesKey='',updatesReady=false,updateTimer=null,pendingUpdate=false;
function requestUpdate(){
 pendingUpdate=true;clearTimeout(updateTimer);
 updateTimer=setTimeout(()=>{
  if(posting||navigating||document.hidden)return;
  pendingUpdate=false;refresh().finally(scheduleRefresh);
 },120);
}
function connectUpdates(){
 if(!('EventSource' in window)||!selection.project||!selection.chat||document.hidden)return;
 const key=selection.project+':'+selection.chat;
 if(updates&&updatesKey===key)return;
 updates?.close();updatesReady=false;updatesKey=key;
 const stream=new EventSource('./api/events?'+new URLSearchParams(selection));updates=stream;
 stream.addEventListener('ready',()=>{if(updates!==stream)return;updatesReady=true;requestUpdate();});
 stream.addEventListener('change',()=>{if(updates===stream)requestUpdate();});
 stream.onerror=()=>{if(updates===stream){updatesReady=false;scheduleRefresh();}};
}
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
 const progress=replyProgress({messages:state?.messages,agentId:agent?.id||null,terminal,name,posting,taskControls:state?.taskControls,stopped:agent?state?.stoppedAgents?.includes(agent.id):state?.startupStopped});
 const seconds=progress?.elapsedSeconds||0,elapsed=seconds>=60?Math.floor(seconds/60)+' 分 '+seconds%60+' 秒':seconds+' 秒';
 const time=progress?.lastProgressAt?new Date(progress.lastProgressAt).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):null;
 const waitingText=progress?.reason?progress.reason+' · 已等待 '+elapsed+(time?' · 最後進度 '+time:''):'';
 const box=$('reply-progress'),key=JSON.stringify([progress&&{...progress,elapsedSeconds:undefined},selectedAgent]);
 if(key===progressSnapshot){const clock=box.querySelector('.reply-wait');if(clock)clock.textContent=waitingText;return;}
 progressSnapshot=key;box.hidden=!progress;box.replaceChildren();if(!progress)return;
 box.dataset.phase=progress.phase;const sheep=avatar(agent?.provider||'claude');animateSheep(sheep,progress.phase==='working'?'working':progress.phase==='sending'||progress.phase==='queued'?'starting':'');
 const copy=el('div','reply-copy');copy.append(el('span','',progress.text));
 if(progress.reason){
  const clock=el('small','reply-wait',waitingText);clock.setAttribute('aria-hidden','true');copy.append(clock);
  if(progress.stalled){copy.append(el('small','reply-stalled','一段時間沒有新進度，可查看任務狀態。'));const task=el('button','','查看任務');task.type='button';task.onclick=()=>openTasks();copy.append(task);}
 }
 box.append(sheep,copy);
 if(progress.animate){const dots=el('span','reply-dots');dots.setAttribute('aria-hidden','true');for(let i=0;i<3;i++)dots.append(el('i'));box.append(dots);}
}
setInterval(()=>{if(!document.hidden&&state)renderReplyProgress();},1000);
const draftKey=(chat=selection.chat)=>`herdr-draft:${selection.project}:${chat}:${selectedAgent||'team'}`;
const attachmentsByDraft=new Map();
const attachmentUploads=new WeakMap(),previewUrls=new Map();
function releaseAttachment(file){const url=previewUrls.get(file);if(url)URL.revokeObjectURL(url);previewUrls.delete(file);attachmentUploads.delete(file);}
const currentAttachments=()=>attachmentsByDraft.get(draftKey())||[];
const fileSizeLimit=15*1024*1024;
const fileCountLimit=4;
let attachmentSnapshot='';
function renderAttachments(){
 const files=currentAttachments(),key=JSON.stringify([draftKey(),posting,files.map(f=>[f.name,f.size,f.lastModified,attachmentUploads.get(f)])]);
 if(key===attachmentSnapshot)return;
 attachmentSnapshot=key;
 const list=$('attachment-list');
 list.replaceChildren();
 list.hidden=!files.length;
 files.forEach((file,index)=>{
  const row=el('div','attachment-chip'),name=el('span','',file.name),remove=el('button','','×');
  if(/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)){
   if(!previewUrls.has(file))previewUrls.set(file,URL.createObjectURL(file));
   const preview=el('button','attachment-preview');preview.type='button';preview.setAttribute('aria-label','預覽附件 '+file.name);
   const image=el('img');image.src=previewUrls.get(file);image.alt='';preview.append(image);
   preview.onclick=()=>{$('attachment-preview-title').textContent=file.name;$('attachment-preview-image').src=previewUrls.get(file);$('attachment-preview-dialog').showModal();};
   row.append(preview);
  }
  name.title=file.name;remove.type='button';remove.disabled=posting;
  remove.setAttribute('aria-label','移除附件 '+file.name);
  remove.onclick=()=>{
   const key=draftKey(),next=files.filter((_,i)=>i!==index);
   releaseAttachment(file);
   if(next.length)attachmentsByDraft.set(key,next);else attachmentsByDraft.delete(key);
   try{localStorage.removeItem(key+':pending');}catch{}
   updateSend();$('add-attachment').focus();
  };
  const copy=el('div','attachment-copy');copy.append(name);
  const upload=attachmentUploads.get(file);
  if(upload){
   const label=upload.state==='failed'?upload.error:upload.state==='complete'?'已上傳，等待傳送訊息':'上傳中 '+upload.percent+'%';
   copy.append(el('small','attachment-state'+(upload.state==='failed'?' failed':''),label));
   if(upload.state==='uploading'){const bar=el('progress');bar.max=100;bar.value=upload.percent;bar.setAttribute('aria-label',file.name+' 上傳進度');copy.append(bar);}
  }
  row.append(copy,remove);list.append(row);
 });
}
$('add-attachment').onclick=()=>$('attachment-input').click();
$('attachment-input').onchange=event=>{
 const input=event.currentTarget,files=[...input.files],current=currentAttachments();
 input.value='';
 if(posting||!state?.project||!files.length)return;
 if(current.length+files.length>fileCountLimit){notice('每則訊息最多附 4 個檔案。');return;}
 if(files.some(file=>file.size<1||file.size>fileSizeLimit)){notice('請選擇 15 MB 以內的非空檔案。');return;}
 attachmentsByDraft.set(draftKey(),[...current,...files]);
 notice('附件已加入草稿，送出時才會上傳。');updateSend();
};
async function uploadFiles(scope,id,files,csrf){
 const names=[];
 for(const [slot,file] of files.entries()){
  notice(`正在上傳附件 ${slot+1}/${files.length}`);
  const query=new URLSearchParams({...scope,id,slot});
  attachmentUploads.set(file,{state:'uploading',percent:0});renderAttachments();
  try{
   const result=await new Promise((resolve,reject)=>{
    const request=new XMLHttpRequest();request.open('POST','./api/attachment?'+query);request.responseType='json';request.timeout=120000;
    request.setRequestHeader('Content-Type','application/octet-stream');request.setRequestHeader('X-Herdr-CSRF',csrf);request.setRequestHeader('X-Herdr-Filename',encodeURIComponent(file.name));
    request.upload.onprogress=event=>{attachmentUploads.set(file,{state:'uploading',percent:Math.min(100,Math.round(event.loaded/(event.lengthComputable?event.total:file.size)*100))});renderAttachments();};
    request.onload=()=>request.status>=200&&request.status<300&&request.response?.name?resolve(request.response):reject(Error(request.response?.error||'附件上傳失敗，請重試。'));
    request.onerror=()=>reject(Error('上傳連線中斷，請確認網路後重試。'));request.ontimeout=()=>reject(Error('上傳逾時，請確認網路後重試。'));request.onabort=()=>reject(Error('上傳已中止，可重新傳送。'));
    request.send(file);
   });
   attachmentUploads.set(file,{state:'complete',percent:100});renderAttachments();names.push(result.name);
  }catch(error){attachmentUploads.set(file,{state:'failed',error:error.message});renderAttachments();throw error;}
 }
 return names;
}
$('attachment-preview-close').onclick=()=>$('attachment-preview-dialog').close();
$('attachment-preview-dialog').addEventListener('close',()=>$('attachment-preview-image').removeAttribute('src'));
$('retry-upload').onclick=()=>$('composer').requestSubmit();
window.addEventListener('beforeunload',()=>{for(const file of previewUrls.keys())releaseAttachment(file);});
const coordinatorRecipient=()=>state.coordinatorAgentId||state.agents.find(a=>a.id==='starter')?.id||null;
function persistDraft(){try{localStorage.setItem(draftKey(),$('draft').value);}catch{}}
function restoreDraft(){
 try{$('draft').value=localStorage.getItem(draftKey())||'';}
 catch{$('draft').value='';}
 updateSend();
}
function renderOtherDrafts(){
 const list=$('other-drafts-list');list.replaceChildren();
 for(const chat of activeProject()?.chats||[]){
  if(chat.id===selection.chat)continue;
  const key=draftKey(chat.id);
  let draft;
  try{draft=localStorage.getItem(key)?.trim();}catch{}
  const count=attachmentsByDraft.get(key)?.length||0;
  if(!draft&&!count)continue;
  const button=el('button','',draft?Array.from(draft.split('\n',1)[0]).slice(0,45).join(''):`${count} 個附件`);
  button.type='button';button.onclick=()=>{$('team-dialog').close();switchChat(selection.project,chat.id,selectedAgent);};
  list.append(button);
 }
 $('other-drafts').hidden=!list.childElementCount;
}
function updateSend(){
 const unavailable=posting||navigating||!state?.project||state?.projectAvailable===false;
 $('send').disabled=unavailable||(!$('draft').value.trim()&&!currentAttachments().length);
 $('add-attachment').disabled=unavailable;
 $('draft').readOnly=posting||navigating;
 renderAttachments();
 fitDraft();
}
function notice(text){$('notice').textContent=text;}
async function api(route,data,scope=selection){
 const response=await fetch('./api/'+route,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json','X-Herdr-CSRF':state?.csrfToken}:{},body:data?JSON.stringify({...scope,...data}):undefined});
 const result=await response.json();if(!response.ok)throw Error(result.error||'連線失敗');return result;
}
async function refresh(scope=selection,agent=selectedAgent,recordHistory=false){
 const switching=scope!==selection,n=++revision,q=new URLSearchParams();
 q.set('timeline','1');
 if(agent)q.set('agent',agent);
 if(scope.project)q.set('project',scope.project);
 if(scope.chat)q.set('chat',scope.chat);
 else q.set('latest','1');
 const previous=state;
 if(previous?.project===scope.project&&previous.chat===scope.chat&&previous.messagesRevision&&Array.isArray(previous.messages)){
  q.set('messagesRevision',previous.messagesRevision);
  if(!switching&&previous.timeline?.agent===(agent||legacyAgent))q.set('timelineRevision',previous.timeline.revision);
 }
 try{
  const result=await api('state?'+q);if(n!==revision)return;
  if(previous&&!Object.hasOwn(result,'messages')&&result.project===previous.project&&result.chat===previous.chat&&result.messagesRevision===previous.messagesRevision){
   result.messages=previous.messages;
  }
  const sameTimeline=previous?.project===result.project&&previous.timeline?.agent===result.timeline?.agent;
  if(sameTimeline&&result.timeline&&!Object.hasOwn(result.timeline,'messages')&&result.timeline.revision===previous.timeline.revision){
   result.timeline=previous.timeline;
  }
  if(!sameTimeline){olderMessages=[];historyBefore=null;}
  else if(olderMessages.length&&result.timeline?.messages!==previous.timeline?.messages){
   olderMessages=mergeTimeline(olderMessages,previous.timeline?.messages||[],result.timeline?.messages||[]);
  }
  const first=!state||switching;
  if(switching){selectedAgent=agent;details=false;notice('');}
  state=result;selection={project:result.project||null,chat:result.chat||null};
  if(selectedAgent&&!currentAgent())selectedAgent=null;
  if(state.agentWorkspace&&!selectedAgent)selectedAgent=coordinatorRecipient()||state.agents[0]?.id||null;
  const link=new URL(location.href);
  if(selection.project)link.searchParams.set('project',selection.project);
  if(selection.chat)link.searchParams.set('chat',selection.chat);
  if(selectedAgent)link.searchParams.set('agent',selectedAgent);else link.searchParams.delete('agent');
  if(recordHistory&&link.href!==location.href)history.pushState(null,'',link);
  else history.replaceState(null,'',link);
  render();
  connectUpdates();
  if(first){restoreDraft();$('feed').scrollTop=$('feed').scrollHeight;}
  return true;
 }catch(e){if(n===revision){notice(e.message);$('status').textContent='主機離線，請檢查 Tailscale';if(!state)$('members').replaceChildren(el('p','project-summary','暫時無法載入專案；請恢復主機連線，不必重建代理。'));}}
}
function switchAgent(id,focusDraft=true){persistDraft();selectedAgent=id;const link=new URL(location.href);if(id)link.searchParams.set('agent',id);else link.searchParams.delete('agent');history.replaceState(null,'',link);restoreDraft();render();document.body.classList.remove('show-sidebar');refresh();if(focusDraft)$('draft').focus();}
async function switchChat(project,chat=null,agent=null,recordHistory=true){
 if(posting||navigating||!project)return;
 const previous=selection;
 persistDraft();
 navigating=true;updateSend();
 try{
  if(!await refresh({project,chat},agent,recordHistory))return;
  document.body.classList.remove('show-sidebar');
  if(previous.project!==selection.project||previous.chat!==selection.chat){
   await api('select',{...selection}).catch(()=>{});
  }
 }finally{navigating=false;updateSend();scheduleRefresh();}
}
function mergeTimeline(...pages){
 const byId=new Map(pages.flat().map(message=>[message.timelineId,message]));
 return [...byId.values()].sort((a,b)=>a.timelineAt-b.timelineAt||a.timelineOrder-b.timelineOrder||a.timelineIndex-b.timelineIndex);
}
$('earlier-messages').onclick=async()=>{
 const timeline=state?.timeline,agent=selectedAgent||legacyAgent,before=olderMessages.length?historyBefore:timeline?.before;
 if(historyLoading||navigating||!before||timeline?.agent!==agent)return;
 const scope={...selection},button=$('earlier-messages');
 historyLoading=button.disabled=true;
 try{
  const page=await api('history?'+new URLSearchParams({...scope,agent,before}));
  if(scope.project!==selection.project||page.agent!==(selectedAgent||legacyAgent))return;
  const feed=$('feed'),height=feed.scrollHeight,top=feed.scrollTop;
  olderMessages=mergeTimeline(page.messages,olderMessages,state.timeline.messages);
  historyBefore=page.before;
  render();feed.scrollTop=top+feed.scrollHeight-height;
 }catch(error){notice(error.message);}
 finally{historyLoading=button.disabled=false;}
};
window.addEventListener('popstate',()=>{
 const params=new URLSearchParams(location.search);
 switchChat(params.get('project')||selection.project,params.get('chat'),params.get('agent'),false);
});
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
 const snapshot=JSON.stringify([selection,selectedAgent,$('search').value,state?.projects,state?.agents,state?.terminals,state?.control,state?.coordinatorPreferredModel,state?.pendingAgents,state?.sidebar]);if(snapshot===navSnapshot)return;navSnapshot=snapshot;closeAgentMenu(false);
 const nav=$('members');nav.replaceChildren();const query=$('search').value.toLocaleLowerCase().trim();
 for(const project of state?.projects||[]){const group=el('div','project-group'),members=project.id===selection.project?state.agents:(project.agents||[]);if(query&&!`${project.name} ${members.map(a=>a.name+' '+providerName(a.provider)).join(' ')}`.toLocaleLowerCase().includes(query))continue;
  const total=members.length+(project.agentWorkspace?0:1),caption=el('button','project-caption');caption.append(el('span','project-name',project.name),el('span','project-agent-count',total+' 隻羊'));caption.setAttribute('aria-label',project.name+'，'+total+' 位代理');caption.dataset.project=project.id;caption.setAttribute('aria-pressed',String(project.id===selection.project));caption.onclick=()=>switchChat(project.id);
  caption.ondragover=e=>{if(dragAgent&&project.id!==selection.project&&!protectedAgent(dragAgent)){e.preventDefault();caption.classList.add('drag-over');}};caption.ondragleave=()=>caption.classList.remove('drag-over');caption.ondrop=e=>{e.preventDefault();caption.classList.remove('drag-over');if(dragAgent&&project.id!==selection.project)openAgentAction(dragAgent,'move',project.id);};
  const titleRow=el('div','project-title-row');
  const edit=el('button','project-edit','✎');edit.type='button';edit.dataset.editProject=project.id;edit.disabled=project.available===false;
  edit.setAttribute('aria-label','編輯專案：'+project.name);edit.setAttribute('aria-haspopup','dialog');edit.title='編輯專案';
  edit.onclick=()=>openProjectEditor(project.id);
  titleRow.append(caption,edit);group.append(titleRow);if(project.id!==selection.project){
   const preview=[...(!project.agentWorkspace?[{id:null,name:project.coordinatorName||'領頭羊',provider:project.coordinatorProvider||'claude',model:project.coordinatorPreferredModel}]:[]),...members];
   const prefs=project.sidebar,ids=prefs?[...prefs.order.filter(id=>prefs.pinned.includes(id)),...prefs.order.filter(id=>!prefs.pinned.includes(id))]:preview.map(a=>a.id||'__coordinator__');for(const id of ids){const a=preview.find(a=>(a.id||'__coordinator__')===id);if(!a)continue;const b=el('button','project-member-preview');b.type='button';b.dataset.project=project.id;b.dataset.agent=a.id||'__coordinator__';b.append(avatar(a.provider||'claude'));const copy=el('span','member-copy');copy.append(el('strong','member-name',(prefs?.pinned.includes(id)?'Pin · ':'')+a.name));appendModelLabel(copy,modelLabel(a,null,project.lastModels?.[id]),'切換查看狀態');b.append(copy);b.setAttribute('aria-label',project.name+'的'+a.name+'，切換查看狀態');b.onclick=()=>switchChat(project.id,null,a.id);group.append(b);}nav.append(group);continue;
  }
  for(const id of visibleAgentIds()){const a=id==='__coordinator__'?null:members.find(a=>a.id===id);if(id!=='__coordinator__'&&!a)continue;const lead=!a,name=a?.name||state.coordinatorName||'領頭羊',t=a?terminalFor(a):state.terminals.find(t=>t.address===state.control?.terminal),activity=activityFor(a,t),active=lead?!selectedAgent:selectedAgent===id;
   const profile=a||{provider:t?.provider||state.coordinatorProvider||'claude',model:state.coordinatorPreferredModel};
   const label=modelLabel(profile,t,project.lastModels?.[id]),currentStatus=!t&&a&&state.pendingAgents?.includes(a.id)?'啟動中':sidebarStatus(profile,t);
   const row=el('div','member'+(active?' active':'')+(sidebarPrefs().pinned.includes(id)?' pinned':''));row.dataset.agent=id;row.draggable=true;
   const handle=el('span','drag-handle');handle.setAttribute('aria-hidden','true');row.append(handle);
   const b=el('button','member-main');b.type='button';b.setAttribute('aria-pressed',String(active));b.setAttribute('aria-label',name+(sidebarPrefs().pinned.includes(id)?'，已置頂':''));b.setAttribute('aria-description',label+'，'+currentStatus);const sheep=avatar(profile.provider);animateSheep(sheep,activity);b.append(sheep);const copy=el('span','member-copy'),title=el('span','member-name',name+(state.coordinatorAgentId===id?' · 協調者':''));if(sidebarPrefs().pinned.includes(id)){const pin=document.createElementNS('http://www.w3.org/2000/svg','svg');pin.setAttribute('viewBox','0 0 24 24');pin.setAttribute('class','pin-mark');pin.setAttribute('aria-hidden','true');const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('d','M8 3h8l-1 7 4 4v2H5v-2l4-4-1-7ZM12 16v6');line.setAttribute('fill','none');line.setAttribute('stroke','currentColor');line.setAttribute('stroke-width','1.7');pin.append(line);title.prepend(pin);}copy.append(title);appendModelLabel(copy,label,currentStatus);b.append(copy);
   const connected=agentConnected(t),dot=el('span','live-dot'+(connected?' is-connected':'')+(connected&&activity?' is-busy':''));dot.setAttribute('aria-hidden','true');dot.title=connected?'已連線':'未連線';b.append(dot);b.onclick=()=>switchChat(project.id,null,lead?null:id);b.onkeydown=e=>{if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();stepAgent(id,e.key==='ArrowUp'?-1:1);}};row.append(b);
   const more=el('button','member-more','⋯');more.type='button';more.setAttribute('aria-label',name+'的操作選單');more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');more.onclick=()=>menuContext?.id===id?closeAgentMenu():openAgentMenu(id,more);row.append(more);
   row.ondragstart=e=>{if(e.target.closest('.member-more')){e.preventDefault();return;}dragAgent=id;row.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('application/x-herdr-agent',id);closeAgentMenu(false);};row.ondragend=()=>{dragAgent=null;row.classList.remove('dragging');document.querySelectorAll('.drag-over').forEach(n=>n.classList.remove('drag-over'));};row.ondragover=e=>{if(dragAgent&&dragAgent!==id){e.preventDefault();row.classList.add('drag-over');row.dataset.drop=e.clientY>row.getBoundingClientRect().top+row.offsetHeight/2?'after':'before';}};row.ondragleave=()=>row.classList.remove('drag-over');row.ondrop=e=>{e.preventDefault();row.classList.remove('drag-over');if(dragAgent&&dragAgent!==id)reorderAgent(dragAgent,id,row.dataset.drop==='after');};group.append(row);
  }
  nav.append(group);
 }
 if(!state?.projects.length)nav.append(el('div','project-summary','按右上角 ＋ 建立第一個專案。'));
}
function renderAttention(){
 const items=attentionItems(state),key=JSON.stringify([selection,items]);$('attention-panel').hidden=!items.length;
 if(key===attentionSnapshot)return;attentionSnapshot=key;$('attention-items').replaceChildren();
 for(const a of items){const row=el('div','attention-item');row.append(el('strong','',a.name),el('p','',a.detail));const action=el('button','','查看處理方式');action.type='button';action.onclick=()=>{switchAgent(a.agentId,false);$('permission-agent').textContent=a.name;$('permission-terminal').textContent=a.id;$('permission-command').textContent='~/.local/bin/hc attach '+a.id;$('permission-dialog').showModal();};row.append(action);$('attention-items').append(row);}
}
function prepareTaskDraft(task){
 if(posting)return;
 const checklistTask=task.kind==='checklist';
 const recipient=checklistTask?coordinatorRecipient():task.agentId;
 if(recipient&&!state.agents.some(agent=>agent.id===recipient)){
  notice('原代理已不在此專案，請先選擇接手的代理。');
  return;
 }
 if(selectedAgent!==recipient)switchAgent(recipient,false);
 const input=$('draft');
 if(input.value.trim()){
  notice('這段對話已有草稿，請先處理草稿再載入任務。');
  input.focus();
  return;
 }
 const key=draftKey()+':pending';
 try{
  const pending=JSON.parse(localStorage.getItem(key)||'null');
  if(!checklistTask&&pending?.id===task.id.slice('message:'.length))localStorage.removeItem(key);
  else if(pending){
   notice('上一筆送出結果尚未確認，請先查看對話狀態。');
   return;
  }
 }catch{}
 const resume='請接續以下中斷的任務。先檢查目前已完成的內容和檔案，再繼續未完成的部分。\n\n';
 const decision=`關於「${task.title}」，我的回覆如下。請先核對我確認的範圍，再依已確認的內容安排下一步。\n\n`;
 input.value=checklistTask?decision:task.phase==='stopped'?resume+task.title:task.title;
 persistDraft();updateSend();input.focus();
 notice(input.value.length>12000?'已載入草稿。送出前請把內容縮短到 12000 字。':'已載入草稿，編輯好再送出。');
}
let artifactRequest=0;
async function openArtifact(task,artifact){
 const token=++artifactRequest;
 const query=new URLSearchParams({...selection,kind:task.kind,id:task.id.slice(task.id.indexOf(':')+1),index:artifact.index});
 const url=mode=>'./api/artifact?'+query+'&mode='+mode;
 const dialog=$('artifact-dialog'),image=$('artifact-image'),text=$('artifact-text'),download=$('artifact-download'),drive=$('artifact-drive');
 $('artifact-title').textContent=artifact.name;
 $('artifact-status').textContent='正在核對驗收檔案…';
 image.hidden=text.hidden=download.hidden=drive.hidden=true;
 drive.removeAttribute('href');
 image.removeAttribute('src');text.textContent='';
 dialog.showModal();
 try{
  const result=await api(url('preview').slice('./api/'.length));
  if(token!==artifactRequest||!dialog.open)return;
  if(result.kind==='image'){
   image.onerror=()=>{if(token===artifactRequest){image.hidden=true;$('artifact-status').textContent='無法顯示圖片，檔案可能已變更。';}};
   image.alt=result.name;image.src=url('image');image.hidden=false;
  }else if(result.kind==='text'){
   text.textContent=result.text;text.hidden=false;
  }
  download.href=url('download');download.hidden=false;
  if(result.canOpenInDrive){drive.href=url('drive');drive.hidden=false;}
  $('artifact-status').textContent=result.truncated?'顯示前 256 KB，完整內容請下載。':result.kind==='download'?'這個格式可下載查看。':'';
 }catch(error){if(token===artifactRequest&&dialog.open)$('artifact-status').textContent=error.message;}
}
$('artifact-close').onclick=()=>$('artifact-dialog').close();
$('artifact-dialog').addEventListener('close',()=>{artifactRequest++;$('artifact-image').removeAttribute('src');});
function openTasks(id){
 const panel=$('task-checklist');
 if(panel.hidden)return;
 panel.open=true;
 const card=id&&[...$('task-items').children].find(node=>node.dataset.id===id);
 if(card)card.open=true;
 (card?.querySelector('summary')||$('task-summary')).focus({preventScroll:true});
 (card||panel).scrollIntoView({block:'start'});
}
$('show-tasks').onclick=()=>{$('team-dialog').close();openTasks();};
function renderTasks(){
 const tasks=taskCards(state,selectedAgent),totals=taskSummary(tasks),key=JSON.stringify([selection,selectedAgent,tasks]);
 $('task-checklist').hidden=!tasks.length;
 $('show-tasks').hidden=$('task-checklist').hidden;
 const segments=[[totals.attention,'待處理'],[totals.review,'待驗收'],[totals.active,'執行或排隊'],[totals.verified,'已驗收'],[totals.replied,'已回覆'],[totals.unconfirmed,'回覆未核對']];
 $('task-summary').textContent=['任務進度',...segments.filter(([n])=>n).map(([n,label])=>n+' '+label)].join(' · ');
 if(key===checklistSnapshot)return;checklistSnapshot=key;const open=new Set([...$('task-items').querySelectorAll('details[open]')].map(n=>n.dataset.id));$('task-items').replaceChildren();
 const rank={blocked:0,pending:1,review:2,working:3,queued:4,stopped:5,unconfirmed:6,replied:7,done:8,cancelled:9};
 for(const task of tasks.sort((a,b)=>rank[a.phase]-rank[b.phase])){const row=el('details','progress-card');row.dataset.id=task.id;row.dataset.phase=task.phase;row.open=open.has(task.id);const summary=el('summary'),title=el('span','task-title',task.title.slice(0,140)),badge=el('span','task-badge',taskLabels[task.phase]);summary.append(title,badge);row.append(summary,el('p','task-owner',(task.source?task.source+' → ':'')+task.owner));
  if(task.acceptance)row.append(el('p','','驗收條件：'+task.acceptance));if(task.verification)row.append(el('p','','驗收結果：'+task.verification));if(task.detail)row.append(el('p','',task.detail));
  if(task.phase==='review')row.append(el('p','','代理已回報，等待交付者核對；尚未驗收完成。'));
  for(const artifact of task.artifacts||[]){
   const button=el('button','artifact-button',artifact.name);
   button.type='button';button.setAttribute('aria-label','查看成果 '+artifact.name);
   button.onclick=()=>openArtifact(task,artifact);row.append(button);
  }
  const canReply=task.kind==='checklist'&&['pending','blocked'].includes(task.phase);
  if(canReply||task.canPrepareDraft){
   const button=el('button','',canReply?'準備回覆給領頭羊':task.phase==='cancelled'?'重新編輯':'準備接續');
   button.type='button';button.onclick=()=>prepareTaskDraft(task);row.append(button);
  }else if(task.kind!=='checklist'){
   const button=el('button','','前往代理對話');
   button.type='button';button.onclick=()=>switchAgent(task.agentId||null,false);row.append(button);
  }
  if(task.action){
   const button=el('button','task-action',task.action==='cancel'?'取消排隊':'停止執行');
   button.type='button';button.onclick=async()=>{
    if(task.action==='stop'&&!confirm('停止「'+task.owner+'」正在執行的這一回合？已寫入的檔案會保留。'))return;
    button.disabled=true;
    try{const result=await api('task-action',{id:task.id.slice('message:'.length),action:task.action});notice(result.status==='cancelled'?'已取消排隊。':'代理已停止這一回合。');}
    catch(error){notice(error.message);}
    finally{await refresh();button.disabled=false;}
   };row.append(button);
  }$('task-items').append(row);
 }
}
function render(){
 if($('team-dialog').open&&$('conversation-usage-section').open)renderUsage();
 $('workbench-version').textContent=state.appVersion?`版本 ${state.appVersion} · v44`:'版本待確認';
 renderNav();const agent=currentAgent(),live=agent?terminalFor(agent):state.terminals.find(t=>t.address===state.control?.terminal);
 $('title').textContent=agent?.name||state.coordinatorName||'領頭羊';
 $('draft').placeholder=agent?`告訴 ${agent.name}，你想完成什麼…`:'告訴總控，你想完成什麼…';
 const project=activeProject(),profile=agent||{provider:live?.provider||state.coordinatorProvider||'claude',model:state.coordinatorPreferredModel};
 const label=modelLabel(profile,live,project?.lastModels?.[agent?.id||'__coordinator__']);
 $('subtitle').textContent=[...new Set([project?.name,providerName(profile.provider),label].filter(Boolean))].join(' · ');
 $('recipient').textContent=agent?`交給 ${agent.name}`:'專案協作';
 $('edit-agent').hidden=true;
 $('status').textContent=state.coreError||(!state.appOpen?(state.backendMode==='background'?'背景服務未就緒，請查看主機設定':'請在主機開啟 Herdr，面板才會處理訊息'):state.startupStopped?'總控啟動已停止，等待你重新開啟':agent?`${providerName(agent.provider)} · ${agentStatus(agent,live)}`:live&&state.coordinatorReady===false?'總控尚未就緒，請在主機查看登入或資料夾信任提示':live?`總控 · ${status(live)}`:'隨時可以開始');
 $('retry-start').hidden=agent?!(state.stoppedAgents||[]).includes(agent.id):!state.startupStopped;$('retry-start').textContent=agent?'重新開啟代理':'重新開啟總控';
 if(!agent&&state.coordinatorParked&&!state.coreError&&state.appOpen)$('status').textContent='領頭羊待命，收到訊息後續接會話';
 $('counts').hidden=state.terminals.length===0;
 $('counts').textContent=`${state.agents.length+(state.agentWorkspace?0:1)} 位成員 · ${state.terminals.filter(t=>t.state==='live').length} 個執行中終端`;
 renderAttention();renderTasks();
 const all=state.messages||[],deliveries={};for(const e of all)if(e.kind==='delivery')deliveries[e.messageId]=e.delivery;
 const timeline=state.timeline?.agent===(selectedAgent||legacyAgent)?state.timeline:null;
 const visible=timeline?mergeTimeline(olderMessages,timeline.messages):all.filter(m=>agent?m.direct&&(m.target||m.agentId)===agent.id:!m.direct);
 const messages=visible.filter(m=>m.kind!=='delivery'&&(details||m.kind!=='assignment'));
 $('earlier-messages').hidden=!(olderMessages.length?historyBefore:timeline?.before);
 $('welcome').hidden=messages.length>0;
 $('welcome-description').textContent=agent?agent.brief:'先和協調總控聊聊目標，其他夥伴需要時再加入。';
 const welcomeHeading=$('welcome').querySelector('h2');welcomeHeading.replaceChildren();welcomeHeading.textContent=agent?`交給${agent.name}的下一件事`:'今天，想和羊群完成什麼？';
 const stamp=JSON.stringify([selection,selectedAgent,details,state.coordinatorName,state.agents.map(a=>[a.id,a.name]),timeline?.revision||state.messagesRevision,olderMessages[0]?.timelineId,state.taskControls]);
 const container=$('messages'),wasBottom=$('feed').scrollHeight-$('feed').scrollTop-$('feed').clientHeight<100;
 if(stamp!==messageSnapshot){messageSnapshot=stamp;container.replaceChildren();
 if(details){container.append(el('div','details-note','這個專案自行設定成員與職責，沒有固定部門或工作順序。每位代理都能直接對話，並在你授權後交付協作與驗收。角色設定不代表已啟動，queued 只代表排入等待。'));}
 let day;
 for(const m of messages){
  if(m.time&&Number.isFinite(Date.parse(m.time))){
   const date=new Date(m.time).toLocaleDateString('zh-TW');
   if(date!==day){container.append(el('p','conversation-date',date));day=date;}
  }
  const user=m.role==='你',row=el('article','message'+(user?' user':''));
  if(!user){const a=state.agents.find(a=>a.name===m.role||a.id===m.agentId);row.append(avatar(a?.provider||'claude'));}
  const bubble=el('div','message-bubble'),role=el('div','message-role',m.terminal===state.control?.terminal&&['Claude','Codex','總控'].includes(m.role)?state.coordinatorName||m.role:m.role||'總控');
  const archive=m.sourceChat&&m.sourceChat!==selection.chat;
  if(user&&m.messageId&&!archive){
   const control=state.taskControls?.[m.messageId],delivery=deliveries[m.messageId]||m.delivery;
   const label=control==='cancelled'?'已取消':control==='stopped'?'已停止':delivery!=='sent'?(m.direct?'等待代理接收':'等待總控處理'):null;
   if(label)role.append(el('span','message-time',label));
  }
  if(m.time){const time=el('time','message-time',new Date(m.time).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'}));role.append(time);}
  if(archive&&(user&&m.messageId||m.kind==='collaboration'||m.collaborationId)){
   const task=el('button','original-task','查看原任務');task.type='button';
   task.onclick=async()=>{
    const id=m.collaborationId?'job:'+m.collaborationId:user?'message:'+m.messageId:null;
    await switchChat(selection.project,m.sourceChat,selectedAgent);
    if(selection.chat===m.sourceChat)openTasks(id);
   };
   role.append(task);
  }
  bubble.append(role,formatMessage(document,m.text||''));row.append(bubble);if(user)row.append(avatar(null,true));container.append(row);
 }
 if(wasBottom&&messages.length)$('feed').scrollTop=$('feed').scrollHeight;}renderReplyProgress();if(wasBottom&&messages.length)$('feed').scrollTop=$('feed').scrollHeight;updateSend();
}
const suggestions=[['釐清目標','先一起想清楚要做什麼','請先協助我釐清這個專案的目標與限制：'],['開始協作','依任務安排適合的成員','請依這個專案已加入的代理與職責，協助以下目標：'],['核對成果','需要時再安排交叉檢查','請檢查以下成果，依需要安排已加入的代理交叉驗證：'],['整理資訊','把零散內容整理清楚','請協助整理以下內容，保留重點、待辦與需要確認的問題：']];
for(const [title,sub,prompt]of suggestions){const b=el('button','suggestion');b.type='button';b.append(el('strong','',title),el('small','',sub));b.onclick=()=>{$('draft').value=prompt;persistDraft();updateSend();$('draft').focus();};$('suggestions').append(b);}
const mentionBox=$('mention-suggestions');
function renderMentionSuggestions(){
 mentionBox.replaceChildren();mentionBox.hidden=true;
 const query=$('draft').value.match(/^@([^\n\s：:，,]*)$/)?.[1]?.toLocaleLowerCase();
 if(query===undefined||posting)return;
 for(const agent of (state?.agents||[]).filter(a=>[a.name,a.id].some(value=>value.toLocaleLowerCase().includes(query))).slice(0,8)){
  const button=el('button','',agent.name+' · '+providerName(agent.provider));
  button.type='button';button.onclick=()=>{
   if(!state.agents.some(a=>a.id===agent.id)){notice('代理名單已更新，請重新選擇。');return;}
   $('draft').value='@'+agent.id+' ';
   mentionBox.hidden=true;persistDraft();updateSend();$('draft').focus();
  };mentionBox.append(button);
 }
 mentionBox.hidden=!mentionBox.childElementCount;
}
$('draft').oninput=()=>{persistDraft();updateSend();renderMentionSuggestions();};
$('draft').onkeydown=e=>{
 if(e.key==='Escape'){mentionBox.hidden=true;return;}
 if(!mentionBox.hidden&&e.key==='ArrowDown'){e.preventDefault();mentionBox.querySelector('button')?.focus();return;}
 if(compactMode.matches)return;
 if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){
  e.preventDefault();
  if(!mentionBox.hidden)mentionBox.querySelector('button')?.focus();
  else $('composer').requestSubmit();
 }
};
mentionBox.onkeydown=event=>{
 if(event.key==='Escape'){mentionBox.hidden=true;$('draft').focus();}
};
document.addEventListener('focusin',event=>{if(event.target!==$('draft')&&!mentionBox.contains(event.target))mentionBox.hidden=true;});
$('composer').onsubmit=async e=>{
 e.preventDefault();
 const files=currentAttachments(),text=$('draft').value;
 if(posting||navigating||!state?.project||(!text.trim()&&!files.length))return;
 const key=draftKey(),scope={...selection},agent=currentAgent(),csrf=state.csrfToken;
 const pendingKey=key+':pending';
 const fileKey=files.length?JSON.stringify(files.map(f=>[f.name,f.size,f.lastModified])):'';
 let pending;
 try{pending=JSON.parse(localStorage.getItem(pendingKey)||'null');}catch{}
 if(!files.length&&pending?.text===text&&pending.fileKey){
  notice('這則草稿原本有附件，請重新加入檔案後送出。');return;
 }
 if(!pending||pending.text!==text||(pending.fileKey||'')!==fileKey){
  pending={text,id:crypto.randomUUID(),fileKey};
 }
 try{localStorage.setItem(pendingKey,JSON.stringify(pending));}catch{}
 posting=true;$('retry-upload').hidden=true;updateSend();renderReplyProgress();
 try{
  const attachments=files.length?await uploadFiles(scope,pending.id,files,csrf):undefined;
  const delivered=await api('message',{text,id:pending.id,attachments,
   allowAgentCreation:pending.allowAgentCreation,...(agent?{agentId:agent.id}:{})},scope);
  try{localStorage.removeItem(pendingKey);localStorage.removeItem(key);}catch{}
  attachmentsByDraft.delete(key);for(const file of files)releaseAttachment(file);
  if(draftKey()===key){
   $('draft').value='';
   if(delivered.direct&&delivered.target!==selectedAgent){selectedAgent=delivered.target;restoreDraft();}
   const to=delivered.direct?(state.agents.find(x=>x.id===delivered.target)?.name||'選定代理'):(state.coordinatorName||'領頭羊');
   notice(delivered.status==='cancelled'?'這則訊息已取消。':delivered.status==='stopped'?'這則訊息已停止。':
    delivered.status==='sent'?'訊息已送達。':`訊息已排隊，等待 ${to} 接收。`);
  }
  await refresh();
 }catch(error){notice(error.message);$('retry-upload').hidden=!files.length;}
 finally{posting=false;updateSend();renderReplyProgress();scheduleRefresh();}
};
$('search').oninput=renderNav;
$('sidebar-toggle').onclick=()=>{if(matchMedia('(max-width:760px)').matches)document.body.classList.toggle('show-sidebar');else document.body.classList.toggle('hide-sidebar');};
$('details-toggle').onclick=()=>{$('team-dialog').close();details=!details;$('details-toggle').textContent=details?'一般對話':'詳細紀錄';render();};
function editAgent(agent=null){
 if(!state?.project){notice('請先建立工作專案。');return;}
 editing=agent?.id||null;
 const coordinator=editing==='__coordinator__';
 $('agent-dialog').querySelector('h2').textContent=coordinator?'領頭羊設定':agent?'代理設定':'新增代理';
 for(const label of $('agent-dialog').querySelectorAll('label')){
  label.hidden=coordinator&&!label.contains($('agent-name'))&&!label.contains($('agent-provider'))||!agent&&label.hasAttribute('data-agent-advanced');
 }
 $('agent-name').value=agent?.name||'';
 $('agent-group').value=agent?.group||'';
 $('agent-brief').value=agent?.brief||'';
 const provider=$('agent-provider');
 for(const option of provider.options)option.hidden=option.disabled=coordinator&&!['claude','codex'].includes(option.value);
 provider.value=coordinator?(state.coordinatorProvider||'claude'):agent?.provider||'codex';
 $('agent-model').value=(coordinator?state.coordinatorPreferredModel:agent?.model)||'claude-opus-5-5';
 $('agent-model-label').hidden=!agent||$('agent-provider').value!=='claude';
 $('agent-model-observed').hidden=!agent;
 $('agent-settings-help').hidden=!agent;
 $('agent-save').textContent=agent?'保存設定':'建立代理';
 const observed=coordinator?state.coordinatorModel:terminalFor(agent||{})?.model;
 $('agent-model-observed').textContent=provider.value==='codex'?'Codex 使用主機 CLI 設定的模型。':observed?'最近確認模型：'+(modelNames[observed]||observed):'最近使用的模型會在引擎回覆後顯示。';
 $('agent-save-error').textContent='';
 $('appoint-agent').hidden=!agent||coordinator;$('appoint-agent').disabled=state.coordinatorAgentId===agent?.id;$('remove-agent').hidden=true;$('remove-agent').disabled=!!agent&&!!terminalFor(agent);$('agent-dialog').showModal();
}
$('manage-team').onclick=openTeam;$('edit-agent').onclick=()=>editAgent(currentAgent()||{id:'__coordinator__',name:state?.coordinatorName||'領頭羊'});
$('close-dialog').onclick=$('cancel-dialog').onclick=()=>$('agent-dialog').close();
async function saveAgent(remove=false){
 if(editing==='__coordinator__'){
  const provider=$('agent-provider').value,model=$('agent-model').value;
  let message='領頭羊設定已保存。';
  if(provider==='claude'&&model!==(state.coordinatorPreferredModel||'claude-opus-5-5'))message=(await api('model',{model})).message;
  const changed=provider!==(state.coordinatorProvider||'claude');
  if(changed)message='引擎已保存。領頭羊會在目前工作結束後使用 '+providerName(provider)+' 接收下一則訊息。';
  await api('coordinator',{name:$('agent-name').value.trim(),...(changed?{provider}:{})});
  $('agent-dialog').close();notice(message);await refresh();return;
 }
 const a={id:editing||'agent-'+crypto.randomUUID().slice(0,12),name:$('agent-name').value.trim(),group:$('agent-group').value.trim(),brief:$('agent-brief').value.trim(),provider:$('agent-provider').value,level:state.agents.find(a=>a.id===editing)?.level||'worker'};
 let modelMessage='';if(!remove&&a.provider==='claude'){a.model=editing?$('agent-model').value:'claude-opus-5-5';const old=state.agents.find(x=>x.id===a.id);if(old?.provider==='claude'&&a.model!==(old.model||'claude-opus-5-5')){const result=await api('agent-model',{agentId:a.id,model:a.model});modelMessage=result.message;await refresh();}}
 const agents=state.agents.filter(x=>x.id!==a.id);if(!remove)agents.push(a);
 await api('roster',{agents,rosterRevision:state.rosterRevision});selectedAgent=remove?null:a.id;$('agent-dialog').close();notice(modelMessage||'代理設定已保存。');await refresh();restoreDraft();
}
$('agent-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;$('agent-save-error').textContent='';try{await saveAgent();}catch(error){$('agent-save-error').textContent=error.message;}finally{b.disabled=false;}};
$('remove-agent').onclick=async()=>{try{await saveAgent(true);}catch(e){notice(e.message);}};
window.addEventListener('beforeunload',persistDraft);
let refreshTimer;
function scheduleRefresh(){
 clearTimeout(refreshTimer);
 if(document.hidden)return;
 const active=state?.appOpen&&['sending','queued','working','collaboration'].includes($('reply-progress').dataset.phase)&&
  !$('reply-progress').hidden;
 refreshTimer=setTimeout(async()=>{if(!posting&&!navigating){pendingUpdate=false;await refresh();}scheduleRefresh();},pendingUpdate?200:updatesReady?15000:active?1250:4000);
}
function refreshForeground(){
 clearTimeout(refreshTimer);
 if(document.hidden){updates?.close();updates=null;updatesKey='';updatesReady=false;return;}
 if(!document.hidden&&!posting&&!navigating)refresh().finally(scheduleRefresh);
}
document.addEventListener('visibilitychange',refreshForeground);
window.addEventListener('online',refreshForeground);
window.addEventListener('pageshow',refreshForeground);
window.addEventListener('pagehide',()=>{updates?.close();updates=null;updatesKey='';updatesReady=false;});
refresh().finally(scheduleRefresh);

$('new-project').onclick=()=>{$('project-name').value='';$('project-dialog').showModal();};
$('project-cancel').onclick=()=>$('project-dialog').close();
$('project-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const result=await api('project',{name:$('project-name').value.trim()});$('project-dialog').close();await switchChat(result.project,result.chat);notice('專案已建立。加入需要的代理，自行設定職責。');}catch(error){notice(error.message);}finally{button.disabled=false;}};

$('hero-sheep').append(avatar('claude'));
$('search-toggle').onclick=()=>{const show=$('search-wrap').hidden;$('search-wrap').hidden=!show;if(show)$('search').focus();else{$('search').value='';renderNav();}};
const projectEditor=$('project-edit-dialog');
function openProjectEditor(projectId){
 const project=state?.projects.find(p=>p.id===projectId);
 if(!project||project.available===false)return;
 projectEditor.dataset.project=projectId;
 $('project-rename').value=project.name;
 $('project-rename-result').textContent='';
 projectEditor.showModal();
}
$('project-edit-close').onclick=()=>projectEditor.close();
projectEditor.addEventListener('close',()=>{
 const project=$('members').querySelector('[data-edit-project="'+CSS.escape(projectEditor.dataset.project)+'"]');
 if(project?.getClientRects().length)project.focus();
});
async function saveProjectEdit(route,data,resultId){
 if(projectEditor.dataset.saving)return;
 const project=projectEditor.dataset.project;
 projectEditor.dataset.saving='true';
 const actions=projectEditor.querySelectorAll('form button');
 actions.forEach(button=>{button.disabled=true;});
 const result=$(resultId);
 result.textContent='';
 try{
  await api(route,{project,chat:null,...data});
  await refresh();
  if(!projectEditor.open||projectEditor.dataset.project!==project)return;
  result.textContent='專案名稱已保存。';
 }catch(error){
  if(projectEditor.open&&projectEditor.dataset.project===project)result.textContent=error.message;
 }finally{
  delete projectEditor.dataset.saving;
  actions.forEach(button=>{button.disabled=false;});
 }
}
$('project-rename-form').onsubmit=e=>{
 e.preventDefault();saveProjectEdit('project-name',{name:$('project-rename').value.trim()},'project-rename-result');
};
let memoryRevision=0;
const usageNumber=new Intl.NumberFormat('zh-TW',{maximumFractionDigits:2});
let usageSnapshot='';
const quotaDate=seconds=>new Date(seconds*1000).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const quotaPeriod=minutes=>minutes%1440===0?minutes/1440+' 天':minutes%60===0?minutes/60+' 小時':minutes+' 分鐘';
const quotaBucket={'gemini-weekly':'Gemini 每週','3p-weekly':'第三方模型每週'};
const miniMaxBucket={general:'通用',video:'影片'};
function renderUsage(){
 const list=$('conversation-usage'),quotaList=$('account-quotas'),usage=state?.usage||[];
 const codex=usage.find(row=>row.provider==='codex')?.quota;
 const quotas=[...(state?.accountQuotas||[]),...(codex?[{provider:'codex',...codex}]:[])];
 const snapshot=JSON.stringify([usage,quotas]);
 if(snapshot===usageSnapshot)return;
 usageSnapshot=snapshot;list.replaceChildren();quotaList.replaceChildren();
 if(!quotas.length)quotaList.append(el('p','','尚未收到可顯示的額度。'));
 for(const {provider,observedAt,windows} of quotas){
  const group=el('dl');
  group.append(el('dt','',providers[provider]));
  for(const w of windows){
   const labels=provider==='minimax'?miniMaxBucket:quotaBucket;
   const bucket=w.bucket&&(Object.hasOwn(labels,w.bucket)?labels[w.bucket]:w.bucket);
   const period=[bucket,w.windowMinutes&&quotaPeriod(w.windowMinutes)].filter(Boolean).join(' · ');
   group.append(el('dd','',period+' · 剩餘 '+usageNumber.format(w.remainingPercent)+'% · '+quotaDate(w.resetsAt)+' 重設'));
  }
  group.append(el('dd','','回報於 '+quotaDate(Date.parse(observedAt)/1000)));
  quotaList.append(group);
 }
 if(!usage.length){
  list.append(el('dt','','這段對話還沒有可統計的送達紀錄。'));return;
 }
 for(const {provider,delivered,replies,measuredTurns,tokens} of usage){
  list.append(el('dt','',providers[provider]||'未標記引擎'),el('dd','',delivered+' 次送達 · '+replies+' 次回覆'));
  if(tokens){
   const inputLabel=provider==='codex'?'輸入（含快取）':'輸入';
   const labels={input:inputLabel,output:'輸出',cacheRead:'讀取快取',cacheWrite:'寫入快取'};
   const fields=Object.entries(labels).flatMap(([key,label])=>typeof tokens[key]==='number'?[label+' '+usageNumber.format(tokens[key])]:[]);
   list.append(el('dd','usage-tokens',measuredTurns+' 個已記錄回合 · '+fields.join(' · ')+' tokens'));
  }
 }
}
$('conversation-usage-section').addEventListener('toggle',event=>{if(event.currentTarget.open)renderUsage();});
$('maintenance-draft').onclick=()=>{
 if(posting)return;
 const issue=$('maintenance-issue').value.trim();
 if(!issue){$('maintenance-result').textContent='請先填寫要修正的問題。';$('maintenance-issue').focus();return;}
 if($('draft').value.trim()){$('maintenance-result').textContent='這段對話已有草稿，請先處理草稿。';return;}
 $('draft').value='維護工作：'+issue+'\n\n請先說明重現方式和修改範圍。若此專案有可寫的 Git 工作區，請在獨立 worktree 做最小修正，並附上變更摘要、測試結果以及可供審閱的檔案或 diff。請停在等待我核准的階段，等我確認後才合併、部署或發布。';
 persistDraft();updateSend();$('team-dialog').close();$('draft').focus();
};
$('project-memory-form').onsubmit=async event=>{
 event.preventDefault();const button=event.submitter;button.disabled=true;
 try{
  const result=await api('project-memory',{revision:memoryRevision,text:$('project-memory').value});
  memoryRevision=result.revision;
  $('project-memory-result').textContent=result.text?'已保存，後續任務會讀取此記憶。':'已清空專案記憶。';
  await refresh();
 }catch(error){$('project-memory-result').textContent=error.message;}
 finally{button.disabled=false;}
};
function openTeam(){
 renderUsage();
 $('maintenance-section').hidden=!state?.project;
 $('maintenance-issue').value='';$('maintenance-result').textContent='';
 $('project-memory-section').hidden=!state?.project;
 const memory=state?.projectMemory;
 memoryRevision=memory?.revision||0;
 $('project-memory').value=memory?.text||'';
 $('project-memory-result').textContent='';
 const drive=state?.drive;
 $('storage-status').textContent=drive?.status==='configured'?'Google Drive 資料夾已設定；雲端上傳狀態由 Drive 桌面版確認。':drive?.status==='needs_login'?'Google Drive 需要重新登入，原檔已保留。':'Google Drive 未連線：請先在主機完成官方桌面版登入。';
 $('storage-folder').value=drive?.folder||'';
 $('storage-form').hidden=state?.backendMode!=='background';

 renderOtherDrafts();$('other-drafts').open=false;$('team-dialog').showModal();
}
$('team-close').onclick=()=>$('team-dialog').close();

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

$('agent-provider').onchange=()=>{
 const provider=$('agent-provider').value;
 $('agent-model-label').hidden=!editing||provider!=='claude';
 $('agent-model-observed').textContent=provider==='codex'?'Codex 使用主機 CLI 設定的模型。':'最近使用的模型會在引擎回覆後顯示。';
};

$('appoint-agent').onclick=async()=>{try{const result=await api('appoint',{agentId:editing});$('agent-dialog').close();selectedAgent=editing;notice('已任命協調者，使用 '+providerName(result.provider)+'。');await refresh();}catch(error){$('agent-save-error').textContent=error.message;}};

$('rename-cancel').onclick=()=>$('rename-dialog').close();
$('rename-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{const id=e.currentTarget.dataset.agent,name=$('rename-name').value.trim();if(id==='__coordinator__')await api('coordinator',{name});else await api('roster',{rosterRevision:state.rosterRevision,agents:state.agents.map(a=>a.id===id?{...a,name}:a)});$('rename-dialog').close();await refresh();notice('名稱已保存。');}catch(error){$('rename-error').textContent=error.message;}finally{b.disabled=false;}};
$('agent-action-cancel').onclick=()=>$('agent-action-dialog').close();
$('agent-action-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{const {agent:agentId,action}=e.currentTarget.dataset;await api('agent-manage',{agentId,action,targetProject:action==='move'?$('move-target').value:undefined,rosterRevision:state.rosterRevision});$('agent-action-dialog').close();if(selectedAgent===agentId){persistDraft();selectedAgent=null;restoreDraft();}await refresh();notice(action==='move'?'代理已轉移；原對話與檔案保留。':'代理設定已刪除；原對話與檔案保留。');}catch(error){$('agent-action-error').textContent=error.message;}finally{b.disabled=false;}};
document.addEventListener('pointerdown',e=>{if(menuContext&&!e.target.closest('#agent-menu')&&!e.target.closest('.member-more'))closeAgentMenu(false);});
document.addEventListener('keydown',e=>{if(!menuContext)return;if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeAgentMenu();return;}if(e.key==='Tab'){closeAgentMenu();return;}const buttons=[...$('agent-menu').querySelectorAll('button:not(:disabled)')],at=buttons.indexOf(document.activeElement);if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(at+(e.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();}},true);
$('members').addEventListener('scroll',()=>closeAgentMenu(false),{passive:true});window.addEventListener('resize',()=>closeAgentMenu(false),{passive:true});

$('permission-close').onclick=()=>$('permission-dialog').close();
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
$('manage-team').addEventListener('click',()=>notificationStatus());

