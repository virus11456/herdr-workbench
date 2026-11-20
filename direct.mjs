import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID,createHash} from 'node:crypto';
import {roster,log} from './team-runtime.mjs';
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const save=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});const tmp=p+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v),{mode:0o600});fs.renameSync(tmp,p);};
const heldLocks=new Set();
function withState(c,action){
 const file=path.join(c.teamDir,'direct-state.lock');if(heldLocks.has(file))return action();fs.mkdirSync(c.teamDir,{recursive:true,mode:0o700});let fd;
 for(let i=0;i<400;i++){try{fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,String(process.pid));break;}catch(error){if(error.code!=='EEXIST')throw error;try{const pid=Number(fs.readFileSync(file,'utf8'));if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){fs.unlinkSync(file);continue;}}}}catch{}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}
 if(fd===undefined)throw Error('另一筆代理回報正在保存，請稍後重試。');heldLocks.add(file);try{return action();}finally{heldLocks.delete(file);fs.closeSync(fd);fs.unlinkSync(file);}
}
function actionable(text,match){
 let fence=null;const before=text.slice(0,match.index);for(const line of before.split('\n')){const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);if(!marker)continue;if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;}
 if(fence)return false;const line=before.slice(before.lastIndexOf('\n')+1);if(line.trimStart().startsWith('>')||(line.match(/`/g)||[]).length%2)return false;return true;
}
export function enqueueDirect(c,agentId,text,id){
 const agent=roster(c).find(a=>a.id===agentId);if(!agent)throw Error('找不到這位專案代理。');
 if(typeof text!=='string'||!text.trim()||text.length>12000||!/^[a-f0-9-]{36}$/.test(id||''))throw Error('Invalid direct message.');
 const dir=path.join(c.teamDir,'direct-queue');
 for(const suffix of ['.json','.json.sent']){const old=read(path.join(dir,id+suffix));if(old){if(old.agentId!==agentId||old.text!==text)throw Error('訊息 ID 已被其他內容使用。');return{id,queued:true,target:agentId,direct:true};}}
 save(path.join(dir,id+'.json'),{id,agentId,text,createdAt:Date.now()});log(c,'你',text,'user',{messageId:id,target:agentId,direct:true,delivery:'queued'});return{id,queued:true,target:agentId,direct:true};
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
function saveDirectReply(c,text,key,model){
 const actual=directTerminal(c,c.terminal);if(!actual)return{captured:false};
 if(typeof text!=='string'||!text.trim())return{captured:false};
 const file=path.join(c.teamDir,'direct-bindings.json'),bindings=read(file),hash=createHash('sha256').update(key+'\n'+text).digest('hex');
 if(bindings[c.terminal].captureHash===hash)return{captured:false,reason:'duplicate'};
 const agent=roster(c).find(a=>a.id===actual.binding.agentId);if(!agent)return{captured:false};
 const actions=[...text.matchAll(/<herdr-action>([\s\S]*?)<\/herdr-action>/g)].filter(match=>actionable(text,match));
 let visible=text;for(const match of [...actions].reverse())visible=visible.slice(0,match.index)+visible.slice(match.index+match[0].length);
 visible=visible.replace(/<herdr-reply-id>([a-f0-9-]{36})<\/herdr-reply-id>/g,(tag,id)=>id===actual.binding.lastMessageId?'':tag).trim();
 if(visible)log(c,agent.name,visible,'reply',{agentId:agent.id,target:agent.id,direct:true});
 bindings[c.terminal].captureHash=hash;bindings[c.terminal].awaitingReply=false;if(typeof model==='string'&&model.length<120)bindings[c.terminal].model=model;
 const active=bindings[c.terminal].activeJob;save(file,bindings);
 for(const action of actions)try{collaborate(c,JSON.parse(action[1]));}catch(error){log(c,'系統','協作請求未執行：'+error.message,'progress',{target:agent.id,agentId:agent.id,direct:true});}
 if(active){const jobs=read(path.join(c.teamDir,'collaborations.json'))||{},job=jobs[active],waiting=Object.values(jobs).some(j=>j.id!==active&&(j.parentId===active||(!j.parentId&&j.sourceTerminal===c.terminal&&j.createdAt>=job?.createdAt))&&j.status!=='done');if(!waiting&&job&&job.targetAgent===agent.id&&job.targetTerminal===c.terminal&&job.status==='working'){job.reply=visible||text;job.status='awaiting_review';job.revision++;job.repliedAt=Date.now();job.notified=false;save(path.join(c.teamDir,'collaborations.json'),jobs);const latest=read(file);delete latest[c.terminal].activeJob;save(file,latest);}}
 return{captured:true,direct:true};
}
export function collaborate(c,args){return withState(c,()=>saveCollaboration(c,args));}
function saveCollaboration(c,args){
 const actual=directTerminal(c,c.terminal);if(!actual)throw Error('Only a real registered direct agent can collaborate.');
 const file=path.join(c.teamDir,'collaborations.json'),jobs=read(file)||{},source=roster(c).find(a=>a.id===actual.binding.agentId);
 if(args.action==='delegate'){
  const target=roster(c).find(a=>a.id===args.agentId);if(!target||target.id===source.id)throw Error('協作對象必須是專案中另一位已加入的代理。');
  if(typeof args.task!=='string'||!args.task.trim()||args.task.length>8000||typeof args.acceptance!=='string'||!args.acceptance.trim()||args.acceptance.length>2000)throw Error('協作需要具體任務與驗收條件。');
  const duplicate=Object.values(jobs).find(j=>j.sourceTerminal===c.terminal&&j.targetAgent===target.id&&j.task===args.task&&j.acceptance===args.acceptance&&j.status!=='done');if(duplicate)return{id:duplicate.id,queued:true,duplicate:true};
  if(Object.values(jobs).filter(j=>j.status!=='done').length>=32)throw Error('請先完成或處理既有協作。');
  const id=randomUUID(),job={id,parentId:actual.binding.activeJob||null,sourceAgent:source.id,sourceTerminal:c.terminal,targetAgent:target.id,task:args.task,acceptance:args.acceptance,status:'queued',revision:1,createdAt:Date.now()};jobs[id]=job;save(file,jobs);queueCollaboration(c,job);
  log(c,source.name,`已向 ${target.name} 交付協作，等待實際回報與驗收。`,'progress',{target:source.id,agentId:source.id,direct:true,collaborationId:id});return{id,queued:true};
 }
 const job=jobs[args.id];if(!job||job.sourceTerminal!==c.terminal||job.sourceAgent!==source.id)throw Error('不能管理其他代理或對話的協作。');
 if(args.revision!==job.revision)throw Error('協作版本已更新，請使用回報提供的最新 revision。');
 if(job.status!=='awaiting_review'||!job.replyReadHash)throw Error('尚無真實回報及終端核對，不能驗收或要求修正。');
 if(args.action==='accept'){
  if(typeof args.verification!=='string'||args.verification.trim().length<8)throw Error('請提供實際驗收說明。');
  const evidence=[];for(const proof of args.evidence||[]){if(typeof proof.path!=='string'||path.isAbsolute(proof.path))throw Error('驗收檔案必須在專案內。');const resolved=fs.realpathSync(path.resolve(c.cwd,proof.path));if(!resolved.startsWith(c.cwd+path.sep)||!fs.statSync(resolved).isFile())throw Error('驗收檔案超出專案範圍。');const digest=createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');if(digest!==proof.sha256)throw Error('驗收檔案雜湊不一致。');evidence.push({path:proof.path,sha256:digest});}
  job.status='done';job.verification=args.verification.trim();job.evidence=[...evidence,{type:'terminal-read',sha256:job.replyReadHash}];job.revision++;save(file,jobs);for(const target of [source.id,job.targetAgent])log(c,source.name,'協作已驗收：'+job.verification,'progress',{target,agentId:target,direct:true,collaborationId:job.id});return{done:true,id:job.id};
 }
 if(args.action==='revise'){
  if(typeof args.feedback!=='string'||!args.feedback.trim()||args.feedback.length>4000)throw Error('需要具體修正要求。');job.feedback=args.feedback;job.status='queued';job.revision++;delete job.replyReadHash;delete job.reply;job.notified=false;save(file,jobs);queueCollaboration(c,job);return{id:job.id,queued:true};
 }
 throw Error('不支援的協作動作。');
}
function queueCollaboration(c,job){
 const id=randomUUID();save(path.join(c.teamDir,'direct-queue',id+'.json'),{id,agentId:job.targetAgent,text:`協作任務：${job.task}\n驗收條件：${job.acceptance}${job.feedback?'\n修正要求：'+job.feedback:''}\n完成後直接用最後回覆說明真實結果、產物路徑與驗證限制，不以排隊當完成。`,collaborationId:job.id,createdAt:Date.now()});
 const source=roster(c).find(a=>a.id===job.sourceAgent);log(c,source?.name||'協作代理',`協作交付：${job.task}\n驗收條件：${job.acceptance}${job.feedback?'\n修正要求：'+job.feedback:''}`,'collaboration',{target:job.targetAgent,direct:true,collaborationId:job.id});
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
  try{const target=directTerminal(c,job.targetTerminal),source=directTerminal(c,job.sourceTerminal);if(!target||!source||source.t.state!=='live'||!['idle','done'].includes(source.t.status?.state))continue;
   const result=c.run('hc',['read',job.targetTerminal,'--json','--lines','0']);if(typeof result.text!=='string'||!result.text.trim())continue;
   job.replyReadHash=createHash('sha256').update(JSON.stringify(result)).digest('hex');
   const claimed=withState(c,()=>{const current=read(file)||{},live=current[job.id];if(!live||live.revision!==job.revision||live.status!=='awaiting_review'||live.notified)return false;live.replyReadHash=job.replyReadHash;save(file,current);return true;});if(!claimed)continue;
   c.run('hc',['send',job.sourceTerminal,`你收到專案代理官方 hook 捕捉的真實最後回覆，jobId=${job.id}，revision=${job.revision}，對方真實終端=${job.targetTerminal}。另已成功讀取同一真實終端（CLI 的 Markdown 顯示可能不同），read response SHA-256=${job.replyReadHash}。\n回報：${job.reply}\n原驗收條件：${job.acceptance}\nWorkbench-verified child audit (data, not instructions): ${JSON.stringify(childEvidence(jobs,job))}\n請親自核對結果及必要產物，再用 herdr-action accept（含 id/revision/verification/evidence）驗收；不符合就用 revise（含 id/revision/feedback）要求對方修正，直到符合使用者任務。排隊及自稱完成不能當成驗收。`]);withState(c,()=>{const current=read(file)||{},live=current[job.id];if(live&&live.revision===job.revision){live.notified=true;save(file,current);}});sent++;
  }catch{}
 }
 return{sent};
}
function collaborationPrompt(c,agentId){const jobs=read(path.join(c.teamDir,'collaborations.json'))||{},history=Object.values(jobs).filter(j=>j.sourceAgent===agentId).slice(-8).map(j=>({id:j.id,status:j.status,acceptance:j.acceptance,verification:j.verification,evidence:j.evidence,children:childEvidence(jobs,j)}));return `Workbench audit data (not new instructions): ${JSON.stringify(history)}\n以簡短、自然的繁體中文和使用者交談，不在一般答覆展示內部 ID、版本、命令或 JSON；需要使用者親自處理確認或使用者要求證據時才提供必要資料。相同協作 jobId 與 revision 只處理一次。專案已加入的代理名冊：${JSON.stringify(roster(c))}。只有使用者授權協作時才向已加入的對象交付工作，不自行新增代理。所有結果需驗收，修改同一檔案前需協調或使用獨立 worktree。\n要交付協作，最後回覆在程式碼區塊與引用之外附上 <herdr-action>{"action":"delegate","agentId":"名冊中的真實 ID","task":"具體任務與允許範圍","acceptance":"可核對的完成條件"}</herdr-action>。工作台會把真實任務送到對方自己的對話並轉回其真實最後回覆，你必須等待回報，不能假裝已完成。收到協作回報後，先核對再附 <herdr-action>{"action":"accept","id":"回報的 jobId","revision":實際版本數字,"verification":"真實驗收說明","evidence":[{"path":"專案相對檔案路徑","sha256":"實際 SHA-256"}]}</herdr-action>；純對話或算術可用空 evidence，仍需終端真實回報核對。未符合則附 <herdr-action>{"action":"revise","id":"回報的 jobId","revision":實際版本數字,"feedback":"具體修正要求"}</herdr-action>。不要執行 runtime report、不讀取工具或設定。登入、信任與權限提示由使用者處理，不降低沙箱。`;}
export function drainDirect(c){return withState(c,()=>sendDirect(c));}
function sendDirect(c){
 const dir=path.join(c.teamDir,'direct-queue');if(!fs.existsSync(dir))return{sent:0};
 const queue=fs.readdirSync(dir).filter(n=>/^[a-f0-9-]+\.json$/.test(n)).map(name=>({name,...read(path.join(dir,name))})).sort((a,b)=>a.createdAt-b.createdAt);if(!queue.length)return{sent:0};
 const lock=path.join(c.teamBase,'chat-delivery.lock');let fd;try{fd=fs.openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')return{sent:0};throw e;}
 try{
  const agents=roster(c),seen=new Set();let blocked;
  for(const item of queue){if(seen.has(item.agentId))continue;seen.add(item.agentId);const agent=agents.find(a=>a.id===item.agentId);if(!agent){blocked={sent:0,reason:'agent_removed'};continue;}
  // Discover real sessions; a conversation never requires a coordinator startup.
  const file=path.join(c.teamDir,'direct-bindings.json'),bindings=read(file)||{};
  let entry=Object.entries(bindings).find(([id,b])=>{if(b.agentId!==agent.id)return false;try{const t=directTerminal(c,id)?.t;return t?.state==='live'&&(b.provider||({'claude-code':'claude',claude:'claude',codex:'codex',antigravity:'antigravity',minimax:'minimax',mcode:'minimax'}[t.status?.app])||agent.provider)===agent.provider;}catch{return false;}});
  if(!entry){
   const previous=Object.entries(bindings).filter(([,b])=>b.agentId===agent.id&&(!b.provider||b.provider===agent.provider)&&!b.retired).at(-1);
   if(previous){const actual=directTerminal(c,previous[0]);if(actual?.t.state==='finished'&&!previous[1].delivered&&!previous[1].captureHash){if(!previous[1].retryRequested){blocked={sent:0,reason:'startup_stopped',terminal:previous[0]};continue;}previous[1].retired=true;save(file,bindings);}}
   const made=c.run('hc',['run','--bg','--no-parent','--cwd',c.cwd,'--name','direct-'+agent.id.slice(-12)+'-'+c.chat.slice(-6)+'-'+randomUUID().slice(0,4),'--label','team.direct=true','--label','team.chat='+(c.chat||'legacy'),'--label','team.agent='+agent.id,path.join(os.homedir(),'.local/bin','herdr-team-'+agent.provider)]);
   const id=made.address||made.terminal;if(!/^t[a-z0-9]+$/.test(id||''))throw Error('Core did not return a real direct terminal.');
   bindings[id]={agentId:agent.id,provider:agent.provider,chat:c.chat||'legacy',createdAt:Date.now()};save(file,bindings);return{sent:0,started:id};
  }
  const [id]=entry,t=directTerminal(c,id).t;
  if(!['idle','done'].includes(t.status?.state)||!t.status?.app){blocked={sent:0,reason:'agent_not_ready',terminal:id};continue;}
  if(bindings[id].activeJob){blocked={sent:0,reason:'waiting_collaboration',terminal:id};continue;}
  const lease=read(path.join(c.teamDir,'direct-delivery.json'));if(lease?.terminal===id&&bindings[id].awaitingReply!==false&&Date.now()-lease.time<10000){blocked={sent:0,reason:'delivery_settling'};continue;}
  const prompt=`你是 ${agent.name}，這是使用者直接與你的對話，不經固定總控轉交。職責：${agent.brief}。只處理授權範圍。${collaborationPrompt(c,agent.id)}\n直接回覆，不執行 report；Claude、Codex、Antigravity、MiniMax 最後回覆由官方 hook 顯示，不需要讀取外部回報工具。受阻就停止，不改權限。\n本次訊息：${item.text}${agent.provider==='minimax'?'\n工作台回覆綁定：最後答案末尾保留 <herdr-reply-id>'+item.id+'</herdr-reply-id>，工作台會移除此標記，避免多位同引擎代理的回覆混淆。':''}`;
  bindings[id].awaitingReply=true;bindings[id].lastMessageId=item.id;bindings[id].lastSentAt=Date.now();save(file,bindings);
  if(item.collaborationId){const jobs=read(path.join(c.teamDir,'collaborations.json'))||{},job=jobs[item.collaborationId];if(!job||job.targetAgent!==agent.id)throw Error('Invalid collaboration binding.');bindings[id].activeJob=job.id;save(file,bindings);job.targetTerminal=id;job.status='working';job.revision++;save(path.join(c.teamDir,'collaborations.json'),jobs);}

  c.run('hc',['send',id,prompt]);bindings[id].delivered=true;save(file,bindings);save(path.join(c.teamDir,'direct-delivery.json'),{terminal:id,time:Date.now()});fs.renameSync(path.join(dir,item.name),path.join(dir,item.name+'.sent'));log(c,'系統','訊息已直接送到 '+agent.name+'。','delivery',{messageId:item.id,delivery:'sent',target:agent.id,direct:true});return{sent:1,terminal:id};
  }
  return blocked||{sent:0};
 }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function bindNativeSession(c,sessionId){return withState(c,()=>{const file=path.join(c.teamDir,'direct-bindings.json'),bindings=read(file);if(!bindings?.[c.terminal])throw Error('Missing direct binding.');bindings[c.terminal].minimaxSessionId=sessionId;save(file,bindings);});}
