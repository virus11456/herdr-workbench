import {projectMemoryPrompt,conversationHistoryPrompt} from './project-memory.mjs';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID,createHash} from 'node:crypto';
import {roster,saveRoster,validateRoster,coordinatorProfile,canCreateAgent,canProvisionForMessage,log} from './team-runtime.mjs';
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const save=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});const tmp=p+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v),{mode:0o600});fs.renameSync(tmp,p);};
const heldLocks=new Set();
function withState(c,action,file=path.join(c.teamDir,'direct-state.lock')){
 if(heldLocks.has(file))return action();fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});let fd;
 for(let i=0;i<400;i++){try{fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,String(process.pid));break;}catch(error){if(error.code!=='EEXIST')throw error;try{const pid=Number(fs.readFileSync(file,'utf8'));if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){fs.unlinkSync(file);continue;}}}}catch{}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}
 if(fd===undefined)throw Error('另一筆代理回報正在保存，請稍後重試。');heldLocks.add(file);try{return action();}finally{heldLocks.delete(file);fs.closeSync(fd);fs.unlinkSync(file);}
}
export function withRosterState(c,action){return withState(c,action,path.join(c.teamBase||path.join(c.cwd,'.herdr-team'),'roster-state.lock'));}
function actionable(text,match){
 let fence=null;const before=text.slice(0,match.index);for(const line of before.split('\n')){const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);if(!marker)continue;if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;}
 if(fence)return false;const line=before.slice(before.lastIndexOf('\n')+1);if(line.trimStart().startsWith('>')||(line.match(/`/g)||[]).length%2)return false;return true;
}
export function enqueueDirect(c,agentId,text,id,allowAgentCreation=false){
 return withState(c,()=>enqueueDirectLocked(c,agentId,text,id,allowAgentCreation));
}
function enqueueDirectLocked(c,agentId,text,id,allowAgentCreation){
 const agent=roster(c).find(a=>a.id===agentId);if(!agent)throw Error('找不到這位專案代理。');
 if(typeof text!=='string'||!text.trim()||text.length>12000||!/^[a-f0-9-]{36}$/.test(id||''))throw Error('Invalid direct message.');
 const dir=path.join(c.teamDir,'direct-queue');
 for(const suffix of ['.json.cancelled','.json.stopped','.json.sent','.json']){const old=read(path.join(dir,id+suffix));if(old){if(old.agentId!==agentId||old.text!==text||(old.allowAgentCreation??false)!==allowAgentCreation)throw Error('訊息 ID 已被其他內容使用。');return{id,queued:suffix==='.json',target:agentId,direct:true,status:queueStatus(suffix)};}}
 if(allowAgentCreation===true&&!canCreateAgent(c,agentId))throw Error('請將新增代理的授權交給目前的領頭羊。');
 save(path.join(dir,id+'.json'),{id,agentId,text,allowAgentCreation,createdAt:Date.now()});log(c,'你',text,'user',{messageId:id,target:agentId,direct:true,delivery:'queued'});return{id,queued:true,target:agentId,direct:true};
}
function queueStatus(suffix){
 return ({'.json':'queued','.json.sent':'sent','.json.cancelled':'cancelled','.json.stopped':'stopped'})[suffix];
}
const validMessageId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const taskConflict=message=>Object.assign(Error(message),{status:409});
const queueFile=(c,id,direct)=>path.join(c.teamDir,direct?'direct-queue':'chat-queue',id+'.json');

function activeDirectTask(binding,item,terminal){
 return binding?.awaitingReply===true&&binding.delivered===true&&!binding.activeJob&&!binding.retired&&
  binding.lastMessageId===item.id&&binding.agentId===item.agentId&&
  terminal?.state==='live'&&terminal.status?.app&&terminal.status.state==='working'&&
  Number.isSafeInteger(binding.turnAtDelivery)&&terminal.turn===binding.turnAtDelivery;
}

export function chatTaskControls(c,messages,terminals,bindings){
 const actions={};
 const receiving=new Set(Object.values(bindings).filter(b=>b.awaitingReply).map(b=>b.lastMessageId));
 const legacyAttempt=read(path.join(c.teamBase,'chat-delivery.json'));
 for(const m of messages.filter(m=>m.kind==='user'&&validMessageId(m.messageId)).slice(-100)){
  const id=m.messageId,file=queueFile(c,id,m.direct);
  if(fs.existsSync(file+'.cancelled'))actions[id]='cancelled';
  else if(fs.existsSync(file+'.stopped'))actions[id]='stopped';
  else if(fs.existsSync(file)&&!fs.existsSync(file+'.sent')&&!receiving.has(id)&&legacyAttempt?.messageId!==id)actions[id]='cancel';
  else if(m.direct&&fs.existsSync(file+'.sent')&&terminals.some(t=>activeDirectTask(bindings[t.address],{id,agentId:m.target},t)))actions[id]='stop';
 }
 return actions;
}

export function actOnChatTask(c,{id,action}){
 if(!validMessageId(id)||!['cancel','stop'].includes(action))throw Error('任務操作無效。');
 return withState(c,()=>{
  const lock=path.join(c.teamBase,'chat-delivery.lock');
  let fd;
  try{fd=fs.openSync(lock,'wx',0o600);}catch(error){
   if(error.code==='EEXIST')throw taskConflict('任務正在交付，請更新狀態後再試。');
   throw error;
  }
  try{
   const direct=queueFile(c,id,true),legacy=queueFile(c,id,false);
   const archive=action==='cancel'?'.cancelled':'.stopped';
   if(fs.existsSync(direct+archive)||(action==='cancel'&&fs.existsSync(legacy+archive)))return{status:action==='cancel'?'cancelled':'stopped'};
   const file=action==='stop'||fs.existsSync(direct)?direct:legacy;
   if(action==='cancel'){
    const queued=read(file);
    if(!queued||queued.id!==id||queued.collaborationId||fs.existsSync(file+'.sent'))throw taskConflict('這筆任務已交付或已變更，無法取消。');
    const bindings=read(path.join(c.teamDir,'direct-bindings.json'))||{};
    const legacyAttempt=read(path.join(c.teamBase,'chat-delivery.json'));
    if(Object.values(bindings).some(b=>b.lastMessageId===id&&b.awaitingReply)||legacyAttempt?.messageId===id)throw taskConflict('這筆任務的交付結果待核對，請先查看代理狀態。');
    fs.renameSync(file,file+archive);
    return{status:'cancelled'};
   }
   const item=read(file+'.sent');
   if(!item||item.id!==id||item.collaborationId)throw taskConflict('找不到已交付的直接聊天任務。');
   const bindingFile=path.join(c.teamDir,'direct-bindings.json'),bindings=read(bindingFile)||{};
   const matches=Object.entries(bindings).filter(([,b])=>!b.retired&&b.lastMessageId===id&&b.agentId===item.agentId&&b.awaitingReply);
   if(matches.length!==1)throw taskConflict('這筆任務已結束或回合已變更。');
   const [terminalId,binding]=matches[0];
   const terminal=directTerminal(c,terminalId)?.t;
   if(!activeDirectTask(binding,item,terminal))throw taskConflict('無法確認這筆任務仍在執行，請查看代理狀態。');
   let result,after;
   try{
    result=c.run('hc',['interrupt',terminalId,'--timeout','2']);
    after=directTerminal(c,terminalId)?.t;
   }catch{throw taskConflict('停止結果尚未確認，請查看代理狀態。');}
   if(!['stopped','exited'].includes(result?.outcome)||!(after?.state==='finished'||after?.state==='live'&&['idle','done'].includes(after.status?.state))){
    throw taskConflict('停止結果尚未確認，請查看代理狀態。');
   }
   fs.renameSync(file+'.sent',file+archive);
   binding.awaitingReply=false;
   save(bindingFile,bindings);
   return{status:'stopped'};
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
 });
}
export function directTerminal(c,id){
 const binding=read(path.join(c.teamDir,'direct-bindings.json'))?.[id];if(!binding||binding.chat!==(c.chat||'legacy')||!/^t[a-z0-9]+$/.test(id||''))return null;
 const t=c.run('hc',['get',id]);
 if(t.cwd!==c.cwd||t.parent||t.labels?.['team.direct']!=='true'||t.labels?.['team.agent']!==binding.agentId||t.labels?.['team.chat']!==binding.chat)throw Error('Foreign direct terminal.');
 return{binding,t};
}
export function retryDirect(c,agentId){return withState(c,()=>{
 if(!roster(c).some(a=>a.id===agentId))throw Error('找不到這位專案代理。');const file=path.join(c.teamDir,'direct-bindings.json'),bindings=read(file)||{};
 const previous=Object.entries(bindings).filter(([,b])=>b.agentId===agentId&&!b.retired).at(-1);if(!previous)throw Error('沒有可重新開啟的代理。');
 const actual=directTerminal(c,previous[0]);if(!actual||actual.t.state!=='finished'||previous[1].delivered||previous[1].captureHash)throw Error('代理仍在執行或已完成啟動，請先查看原終端。');previous[1].retryRequested=true;save(file,bindings);return{queued:true,restarted:false};
});}
export function directReply(c,text,key,model){return withState(c,()=>saveDirectReply(c,text,key,model));}
function replyActions(text){
 const actions=[...text.matchAll(/<herdr-action>([\s\S]*?)<\/herdr-action>/g)].filter(match=>actionable(text,match));
 let visible=text;
 for(const match of [...actions].reverse())visible=visible.slice(0,match.index)+visible.slice(match.index+match[0].length);
 return {actions,visible};
}
function legacyTerminal(c,id){
 if(!/^t[a-z0-9]+$/.test(id||'')||read(path.join(c.teamDir,'control.json'))?.terminal!==id)return null;
 const t=c.run('hc',['get',id]);
 return t.cwd===c.cwd&&!t.parent&&t.labels?.['team.direct']!=='true'&&t.state==='live'&&['claude-code','claude','codex'].includes(t.status?.app)?t:null;
}
export function legacyCollaborationReply(c,text,role){
 const marker=path.join(c.teamDir,'legacy-message.json');
 const {actions,visible}=replyActions(text);
 if(!actions.length&&!read(marker)?.id)return null;
 return withState(c,()=>{
  if(!legacyTerminal(c,c.terminal))return null;
  const turn=read(marker);
  const sent=turn?.terminal===c.terminal&&validMessageId(turn.id)?read(queueFile(c,turn.id,false)+'.sent'):null;
  const replyTo=sent&&!turn.replyCaptured?turn.id:null;
  const grant=replyTo&&turn.creation===replyTo&&canProvisionForMessage(c,null,sent.allowAgentCreation)?replyTo:null;
  if(replyTo)save(marker,{...turn,creation:null,replyCaptured:true});
  if(visible.trim())log(c,role,visible.trim(),'reply',replyTo?{replyTo}:{});
  const source={id:null,name:coordinatorProfile(c).name};
  handleReplyActions(c,actions,source,grant);
  return {captured:true};
 });
}
function handleReplyActions(c,actions,source,grant){
 for(const action of actions){
  try{
   const args=JSON.parse(action[1]);
   saveCollaboration(c,args,grant);
  }catch(error){
   const route=source.id?{target:source.id,agentId:source.id,direct:true}:{};
   log(c,'系統','協作請求未執行：'+error.message,'progress',route);
  }
 }
}
function saveDirectReply(c,text,key,model){
 const actual=directTerminal(c,c.terminal);if(!actual)return{captured:false};
 if(validMessageId(actual.binding.lastMessageId)&&fs.existsSync(queueFile(c,actual.binding.lastMessageId,true)+'.stopped'))return{captured:false,reason:'stopped_turn'};
 if(typeof text!=='string'||!text.trim())return{captured:false};
 const file=path.join(c.teamDir,'direct-bindings.json'),bindings=read(file),hash=createHash('sha256').update(key+'\n'+text).digest('hex');
 if(bindings[c.terminal].captureHash===hash)return{captured:false,reason:'duplicate'};
 const agent=roster(c).find(a=>a.id===actual.binding.agentId);if(!agent)return{captured:false};
 let {actions,visible}=replyActions(text);
 visible=visible.replace(/<herdr-reply-id>([a-f0-9-]{36})<\/herdr-reply-id>/g,(tag,id)=>id===actual.binding.lastMessageId?'':tag).trim();
 if(visible)log(c,agent.name,visible,'reply',{agentId:agent.id,target:agent.id,direct:true,replyTo:actual.binding.lastMessageId});
 bindings[c.terminal].captureHash=hash;bindings[c.terminal].awaitingReply=false;if(typeof model==='string'&&model.length<120)bindings[c.terminal].model=model;
 const active=bindings[c.terminal].activeJob;save(file,bindings);
 const last=actual.binding.lastMessageId;
 const policy=validMessageId(last)&&read(queueFile(c,last,true)+'.sent')?.allowAgentCreation;
 const grant=actual.binding.awaitingReply&&actual.binding.delivered&&canProvisionForMessage(c,agent.id,policy)?last:null;
 handleReplyActions(c,actions,agent,grant);
 if(active){const jobs=read(path.join(c.teamDir,'collaborations.json'))||{},job=jobs[active],waiting=Object.values(jobs).some(j=>j.id!==active&&(j.parentId===active||(!j.parentId&&j.sourceTerminal===c.terminal&&j.createdAt>=job?.createdAt))&&openJob(j));if(!waiting&&job&&job.targetAgent===agent.id&&job.targetTerminal===c.terminal&&job.status==='working'){job.reply=visible||text;job.status='awaiting_review';job.revision++;job.repliedAt=Date.now();job.notified=false;save(path.join(c.teamDir,'collaborations.json'),jobs);const latest=read(file);delete latest[c.terminal].activeJob;save(file,latest);}}
 return{captured:true,direct:true};
}
export function collaborate(c,args){return withState(c,()=>saveCollaboration(c,args));}
function saveCollaboration(c,args,grant){
 const actual=directTerminal(c,c.terminal);
 const file=path.join(c.teamDir,'collaborations.json'),jobs=read(file)||{};
 const legacy=!actual&&args.action!=='delegate'&&c.privateState&&legacyTerminal(c,c.terminal);
 const source=actual?roster(c).find(a=>a.id===actual.binding.agentId):legacy?{id:null,name:coordinatorProfile(c).name}:null;
 if(!source)throw Error('Only a real registered agent can collaborate.');
 if(args.action==='create-agent-and-delegate'){
  const policy=grant&&read(queueFile(c,grant,!!actual)+'.sent')?.allowAgentCreation;
  if(!grant||args.messageId!==grant||!canProvisionForMessage(c,source.id,policy))throw Error('這則訊息目前不能新增代理，請使用現有專案成員。');
  if(Object.values(jobs).some(job=>job.creationMessage===grant))throw Error('這則訊息的新增代理授權已使用。');
  if(Object.values(jobs).filter(job=>openJob(job)).length>=32)throw Error('請先完成或處理既有協作。');
  const task=requiredText(args.task,8000,'請提供具體任務。');
  const acceptance=requiredText(args.acceptance,2000,'請提供可核對的驗收條件。');
  const name=requiredText(args.name,40,'請提供代理名稱。');
  const brief=requiredText(args.brief,1000,'請提供代理的工作職責。');
  const id=randomUUID();
  const [agent]=validateRoster([{id:'agent-'+id.replaceAll('-','').slice(0,24),name,brief,provider:args.provider,level:'worker'}]);
  jobs[id]={id,parentId:null,sourceAgent:source.id,sourceTerminal:c.terminal,targetAgent:agent.id,task,acceptance,
   status:'provisioning',revision:1,createdAt:Date.now(),creationMessage:grant,creationPolicy:policy,newAgent:agent};
  save(file,jobs);
  return {id,queued:true};
 }
 if(args.action==='delegate'){
  const target=roster(c).find(a=>a.id===args.agentId);if(!target||target.id===source.id)throw Error('協作對象必須是專案中另一位已加入的代理。');
  if(typeof args.task!=='string'||!args.task.trim()||args.task.length>8000||typeof args.acceptance!=='string'||!args.acceptance.trim()||args.acceptance.length>2000)throw Error('協作需要具體任務與驗收條件。');
  const duplicate=Object.values(jobs).find(j=>j.sourceTerminal===c.terminal&&j.targetAgent===target.id&&j.task===args.task&&j.acceptance===args.acceptance&&j.status!=='done');if(duplicate)return{id:duplicate.id,queued:true,duplicate:true};
  if(Object.values(jobs).filter(openJob).length>=32)throw Error('請先完成或處理既有協作。');
  const id=randomUUID(),job={id,parentId:actual.binding.activeJob||null,sourceAgent:source.id,sourceTerminal:c.terminal,targetAgent:target.id,task:args.task,acceptance:args.acceptance,status:'queued',revision:1,createdAt:Date.now()};jobs[id]=job;save(file,jobs);queueCollaboration(c,job);
  log(c,source.name,`已向 ${target.name} 交付協作，等待實際回報與驗收。`,'progress',{target:source.id,agentId:source.id,direct:true,collaborationId:id});return{id,queued:true};
 }
 const job=jobs[args.id];if(!job||job.sourceTerminal!==c.terminal||job.sourceAgent!==source.id)throw Error('不能管理其他代理或對話的協作。');
 if(args.revision!==job.revision)throw Error('協作版本已更新，請使用回報提供的最新 revision。');
 if(job.status!=='awaiting_review'||!job.replyReadHash)throw Error('尚無真實回報及終端核對，不能驗收或要求修正。');
 if(args.action==='accept'){
  if(typeof args.verification!=='string'||args.verification.trim().length<8)throw Error('請提供實際驗收說明。');
  if(args.evidence!==undefined&&!Array.isArray(args.evidence))throw Error('驗收附件 evidence 必須是陣列；純對話請傳入 []。');
  const evidence=[];for(const proof of args.evidence||[]){if(typeof proof.path!=='string'||path.isAbsolute(proof.path))throw Error('驗收檔案必須在專案內。');const resolved=fs.realpathSync(path.resolve(c.cwd,proof.path));if(!resolved.startsWith(c.cwd+path.sep)||!fs.statSync(resolved).isFile())throw Error('驗收檔案超出專案範圍。');const digest=createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');if(digest!==proof.sha256)throw Error('驗收檔案雜湊不一致。');evidence.push({path:proof.path,sha256:digest});}
  job.status='done';job.verification=args.verification.trim();job.evidence=[...evidence,{type:'terminal-read',sha256:job.replyReadHash}];job.revision++;save(file,jobs);for(const target of [source.id,job.targetAgent])log(c,source.name,'協作已驗收：'+job.verification,'progress',target?{target,agentId:target,direct:true,collaborationId:job.id}:{collaborationId:job.id});return{done:true,id:job.id};
 }
 if(args.action==='revise'){
  if(typeof args.feedback!=='string'||!args.feedback.trim()||args.feedback.length>4000)throw Error('需要具體修正要求。');job.feedback=args.feedback;job.status='queued';job.revision++;delete job.replyReadHash;delete job.reply;job.notified=false;save(file,jobs);queueCollaboration(c,job);return{id:job.id,queued:true};
 }
 throw Error('不支援的協作動作。');
}
const openJob=job=>!['done','failed'].includes(job.status);
function requiredText(value,max,error){
 if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(error);
 return value.trim();
}
function queueCollaboration(c,job,id=randomUUID()){
 const file=queueFile(c,id,true);
 if(fs.existsSync(file)||fs.existsSync(file+'.sent'))return;
 save(file,{id,agentId:job.targetAgent,text:`協作任務：${job.task}\n驗收條件：${job.acceptance}${job.feedback?'\n修正要求：'+job.feedback:''}\n完成後直接用最後回覆說明真實結果、產物路徑與驗證限制，不以排隊當完成。`,collaborationId:job.id,createdAt:Date.now()});
 const source=roster(c).find(a=>a.id===job.sourceAgent);log(c,source?.name||coordinatorProfile(c).name,`協作交付：${job.task}\n驗收條件：${job.acceptance}${job.feedback?'\n修正要求：'+job.feedback:''}`,'collaboration',{target:job.targetAgent,direct:true,collaborationId:job.id});
}
function provisionAgents(c){
 const file=path.join(c.teamDir,'collaborations.json'),jobs=read(file)||{};
 for(const job of Object.values(jobs).filter(j=>j.status==='provisioning')){
  const agent=job.newAgent;
  const error=withRosterState(c,()=>{
   const agents=roster(c);
   const existing=agents.find(a=>a.id===agent.id);
   if(existing)return null;
   if(!canCreateAgent(c,job.sourceAgent))return '協調者已變更，請由目前的領頭羊重新交辦。';
   if(job.creationPolicy==='when-alone'&&!canProvisionForMessage(c,job.sourceAgent,job.creationPolicy))return '專案已有其他成員，請派給現有代理。';
   if(agents.length>=24)return '專案成員已達上限。';
   const normalized=name=>name.normalize('NFKC').toLowerCase();
   if([...agents.map(a=>a.name),coordinatorProfile(c).name].some(name=>normalized(name)===normalized(agent.name)))return '專案已有同名代理。';
   saveRoster(c,[...agents,agent]);
   return null;
  });
  const source=roster(c).find(a=>a.id===job.sourceAgent);
  const route=source?{target:source.id,agentId:source.id,direct:true}:{};
  if(error){
   job.status='failed';job.feedback=error;job.revision++;save(file,jobs);
   log(c,'系統',`無法建立「${agent.name}」。${error}`,'progress',{...route,collaborationId:job.id});
   continue;
  }
  queueCollaboration(c,job,job.id);
  job.status='queued';job.revision++;save(file,jobs);
  log(c,'系統',`已建立「${agent.name}」並排入協作，等待代理接收。`,'progress',{...route,collaborationId:job.id});
 }
}
function childEvidence(jobs,parent){
 const selected=new Set([parent.id]),rows=[];let changed=true;
 while(changed){changed=false;for(const job of Object.values(jobs)){if(selected.has(job.id))continue;if((job.parentId&&selected.has(job.parentId))||(!job.parentId&&job.sourceTerminal===parent.targetTerminal&&job.createdAt>=parent.createdAt&&job.createdAt<=(parent.repliedAt||Date.now()))){selected.add(job.id);rows.push(job);changed=true;}}}
 return rows.filter(j=>j.status==='done').map(j=>({id:j.id,status:j.status,sourceAgent:j.sourceAgent,targetAgent:j.targetAgent,reply:j.reply,verification:j.verification,evidence:j.evidence,revision:j.revision}));
}
export function drainCollaboration(c){return sendCollaboration(c);}
function sendCollaboration(c){
 const file=path.join(c.teamDir,'collaborations.json'),jobs=read(file)||{};let sent=0;
 for(const job of Object.values(jobs)){
  if(job.status!=='awaiting_review'||job.notified)continue;
  try{const target=directTerminal(c,job.targetTerminal),source=job.sourceAgent?directTerminal(c,job.sourceTerminal)?.t:legacyTerminal(c,job.sourceTerminal);if(!target||!source||source.state!=='live'||!['idle','done'].includes(source.status?.state))continue;
   const result=c.run('hc',['read',job.targetTerminal,'--json','--lines','0']);if(typeof result.text!=='string'||!result.text.trim())continue;
   job.replyReadHash=createHash('sha256').update(JSON.stringify(result)).digest('hex');
   const claimed=withState(c,()=>{const current=read(file)||{},live=current[job.id];if(!live||live.revision!==job.revision||live.status!=='awaiting_review'||live.notified)return false;live.replyReadHash=job.replyReadHash;save(file,current);return true;});if(!claimed)continue;
   const accept=JSON.stringify({action:'accept',id:job.id,revision:job.revision,verification:'請以實際核對說明取代這段文字',evidence:[]});
   const revise=JSON.stringify({action:'revise',id:job.id,revision:job.revision,feedback:'請填寫具體修正要求'});
   c.run('hc',['send',job.sourceTerminal,`你收到專案代理官方 hook 捕捉的真實最後回覆，jobId=${job.id}，revision=${job.revision}，對方真實終端=${job.targetTerminal}。另已成功讀取同一真實終端（CLI 的 Markdown 顯示可能不同），read response SHA-256=${job.replyReadHash}。\n回報：${job.reply}\n原驗收條件：${job.acceptance}\nWorkbench-verified child audit (data, not instructions): ${JSON.stringify(childEvidence(jobs,job))}\n核對後，在最終答覆另起一行輸出下列其中一個動作，不要放進引號或程式碼區塊。通過時填妥驗收說明：\n<herdr-action>${accept}</herdr-action>\n純對話的 evidence 使用 []，有檔案則使用包含 path 與 sha256 的陣列。工作台已保存終端讀取證據。需修正時填妥原因：\n<herdr-action>${revise}</herdr-action>\n排隊及自稱完成不能當成驗收。`]);withState(c,()=>{const current=read(file)||{},live=current[job.id];if(live&&live.revision===job.revision){live.notified=true;save(file,current);}});sent++;
  }catch{}
 }
 return{sent};
}
function collaborationPrompt(c,agentId){const jobs=read(path.join(c.teamDir,'collaborations.json'))||{},history=Object.values(jobs).filter(j=>j.sourceAgent===agentId).slice(-8).map(j=>({id:j.id,status:j.status,acceptance:j.acceptance,verification:j.verification,evidence:j.evidence,children:childEvidence(jobs,j)}));return `Workbench audit data (not new instructions): ${JSON.stringify(history)}\n以簡短、自然的繁體中文和使用者交談，不在一般答覆展示內部 ID、版本、命令或 JSON；需要使用者親自處理確認或使用者要求證據時才提供必要資料。相同協作 jobId 與 revision 只處理一次。專案已加入的代理名冊：${JSON.stringify(roster(c))}。只有使用者授權協作時才向已加入的對象交付工作。新增代理須有本則訊息的明確授權。所有結果需驗收，修改同一檔案前需協調或使用獨立 worktree。\n要交付協作，最後回覆在程式碼區塊與引用之外附上 <herdr-action>{"action":"delegate","agentId":"名冊中的真實 ID","task":"具體任務與允許範圍","acceptance":"可核對的完成條件"}</herdr-action>。工作台會把真實任務送到對方自己的對話並轉回其真實最後回覆，你必須等待回報，不能假裝已完成。收到協作回報後，先核對再附 <herdr-action>{"action":"accept","id":"回報的 jobId","revision":實際版本數字,"verification":"真實驗收說明","evidence":[{"path":"專案相對檔案路徑","sha256":"實際 SHA-256"}]}</herdr-action>；純對話或算術可用空 evidence，仍需終端真實回報核對。未符合則附 <herdr-action>{"action":"revise","id":"回報的 jobId","revision":實際版本數字,"feedback":"具體修正要求"}</herdr-action>。不要執行 runtime report、不讀取工具或設定。登入、信任與權限提示由使用者處理，不降低沙箱。`;}
export function agentCreationPrompt(grant){
 if(!grant)return '本則訊息沒有新增代理的授權。需要人手時，提出建議的名稱、引擎、職責、任務及驗收條件供領頭羊或使用者決定。';
 return `本則訊息允許你為目前專案新增一位工作代理。先拆解目標並判斷哪些工作適合委派。確實需要協作且缺少適任成員時，可以自行建立一位；問候、單純諮詢與狀態查詢無須建立。需要建立時，在最後回覆附上獨立一行的 <herdr-action>{"action":"create-agent-and-delegate","messageId":"${grant}","name":"代理名稱","provider":"codex","brief":"長期工作職責","task":"本次具體委派及授權範圍","acceptance":"本次可核對的驗收條件"}</herdr-action>。provider 必須是 claude、codex、minimax 或 antigravity。工作台負責建立、交付並轉回事實回報。等收到回報後驗收或要求修正。排隊不代表送達。登入、信任或其他權限由使用者親自確認。`;
}
export function drainDirect(c){return withState(c,()=>sendDirect(c));}
function sendDirect(c){
 const dir=path.join(c.teamDir,'direct-queue');if(!fs.existsSync(dir)&&!fs.existsSync(path.join(c.teamDir,'collaborations.json')))return{sent:0};
 const lock=path.join(c.teamBase,'chat-delivery.lock');let fd;try{fd=fs.openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')return{sent:0};throw e;}
 try{
  provisionAgents(c);
  if(!fs.existsSync(dir))return{sent:0};
  const queue=fs.readdirSync(dir).filter(n=>/^[a-f0-9-]+\.json$/.test(n)).map(name=>({name,...read(path.join(dir,name))})).sort((a,b)=>a.createdAt-b.createdAt);
  const agents=roster(c),seen=new Set();let blocked;
  for(const item of queue){if(seen.has(item.agentId))continue;seen.add(item.agentId);const agent=agents.find(a=>a.id===item.agentId);if(!agent){blocked={sent:0,reason:'agent_removed'};continue;}
  // Discover real sessions; a conversation never requires a coordinator startup.
  const file=path.join(c.teamDir,'direct-bindings.json'),bindings=read(file)||{};
  let entry=Object.entries(bindings).find(([id,b])=>{if(b.agentId!==agent.id)return false;try{const t=directTerminal(c,id)?.t;return t?.state==='live'&&(b.provider||({'claude-code':'claude',claude:'claude',codex:'codex',antigravity:'antigravity',minimax:'minimax',mcode:'minimax'}[t.status?.app])||agent.provider)===agent.provider;}catch{return false;}});
  if(!entry){
   const previous=Object.entries(bindings).filter(([,b])=>b.agentId===agent.id&&(!b.provider||b.provider===agent.provider)&&!b.retired).at(-1);
   if(previous){const actual=directTerminal(c,previous[0]);if(actual?.t.state==='finished'&&!previous[1].delivered&&!previous[1].captureHash){if(!previous[1].retryRequested){blocked={sent:0,reason:'startup_stopped',terminal:previous[0]};continue;}previous[1].retired=true;save(file,bindings);}}
   const made=c.run('hc',['run','--bg','--no-parent','--cwd',c.cwd,'--name','direct-'+agent.id.slice(-12)+'-'+(c.chat||'legacy').slice(-6)+'-'+randomUUID().slice(0,4),'--label','team.direct=true','--label','team.chat='+(c.chat||'legacy'),'--label','team.agent='+agent.id,path.join(os.homedir(),'.local/bin','herdr-team-'+agent.provider)]);
   const id=made.address||made.terminal;if(!/^t[a-z0-9]+$/.test(id||''))throw Error('Core did not return a real direct terminal.');
   bindings[id]={agentId:agent.id,provider:agent.provider,chat:c.chat||'legacy',createdAt:Date.now()};save(file,bindings);return{sent:0,started:id};
  }
  const [id]=entry,t=directTerminal(c,id).t;
  if(!['idle','done'].includes(t.status?.state)||!t.status?.app){blocked={sent:0,reason:'agent_not_ready',terminal:id};continue;}
  if(bindings[id].activeJob){blocked={sent:0,reason:'waiting_collaboration',terminal:id};continue;}
  const lease=read(path.join(c.teamDir,'direct-delivery.json'));if(lease?.terminal===id&&bindings[id].awaitingReply!==false&&Date.now()-lease.time<10000){blocked={sent:0,reason:'delivery_settling'};continue;}
  const creation=canProvisionForMessage(c,agent.id,item.allowAgentCreation)?item.id:null;
  const role=canCreateAgent(c,agent.id)
   ?'你是本專案的領頭羊。收到目標後先拆解並判斷分工，使用者文字指定人選時照指派實際送出，未指定時依任務挑選名冊成員。交付目標本身允許你在既有專案成員間完成所需分工。簡單問題與狀態查詢可直接答覆。'
   :'這是使用者直接交給你的任務，你應親自執行，依使用者指示才找同專案其他成員協作。';
  const prompt=`你是 ${agent.name}。職責：${agent.brief}。只處理授權範圍。${role}${collaborationPrompt(c,agent.id)}${projectMemoryPrompt(c)}${conversationHistoryPrompt(c,agent.id,item.text)}\n${agentCreationPrompt(creation)}\n直接回覆，不執行 report；Claude、Codex、Antigravity、MiniMax 最後回覆由官方 hook 顯示，不需要讀取外部回報工具。受阻就停止，不改權限。\n本次訊息：${item.text}${agent.provider==='minimax'?'\n工作台回覆綁定：最後答案末尾保留 <herdr-reply-id>'+item.id+'</herdr-reply-id>，工作台會移除此標記，避免多位同引擎代理的回覆混淆。':''}`;
  bindings[id].awaitingReply=true;bindings[id].delivered=false;bindings[id].lastMessageId=item.id;bindings[id].lastSentAt=Date.now();bindings[id].turnAtDelivery=t.turn;save(file,bindings);
  if(item.collaborationId){const jobs=read(path.join(c.teamDir,'collaborations.json'))||{},job=jobs[item.collaborationId];if(!job||job.targetAgent!==agent.id)throw Error('Invalid collaboration binding.');bindings[id].activeJob=job.id;save(file,bindings);job.targetTerminal=id;job.status='working';job.revision++;save(path.join(c.teamDir,'collaborations.json'),jobs);}

  c.run('hc',['send',id,prompt]);bindings[id].delivered=true;save(file,bindings);save(path.join(c.teamDir,'direct-delivery.json'),{terminal:id,time:Date.now()});fs.renameSync(path.join(dir,item.name),path.join(dir,item.name+'.sent'));log(c,'系統','訊息已直接送到 '+agent.name+'。','delivery',{messageId:item.id,delivery:'sent',target:agent.id,direct:true,provider:agent.provider});return{sent:1,terminal:id};
  }
  return blocked||{sent:0};
 }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function bindNativeSession(c,sessionId){return withState(c,()=>{const file=path.join(c.teamDir,'direct-bindings.json'),bindings=read(file);if(!bindings?.[c.terminal])throw Error('Missing direct binding.');bindings[c.terminal].minimaxSessionId=sessionId;save(file,bindings);});}
