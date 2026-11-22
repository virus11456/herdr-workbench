import {verifiedLegacyWorker} from '../worker-chat.mjs';
import {workerCandidates,createWorkerObserver} from './legacy-workers.mjs';
import {skillRequests} from '../agent-policy.mjs';
import {conversationUsage} from './usage.mjs';
import {footerModel,mergeModel,terminalProvider,validModel} from './agent-models.mjs';
import {providerUsageRecords} from '../provider-usage.mjs';
import {codexQuotaRefresher,miniMaxQuotaRefresher,readQuotas} from '../provider-quota.mjs';
import {projectMemory,saveProjectMemory} from '../project-memory.mjs';
import {createPushStore} from './push.mjs';
import {artifactReferences,driveArtifactLink,readArtifact} from './artifacts.mjs';
import {messageWithAttachments,uploadAttachment} from './attachments.mjs';
import {checklist} from '../checklist.mjs';
import {sidebarState,updateSidebar,rosterRevision,manageAgent,managementActive} from './agent-management.mjs';
import {enqueueDirect,adoptWorkerChat,pendingRegistrations,decideSkillRequest,retryDirect,chatTaskControls,actOnChatTask,withRosterState} from '../direct.mjs';
import {validateDriveRoot,storageStatus,serviceAlive} from '../storage.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {context,roster,saveRoster,enqueueChat,coordinatorProfile,setCoordinatorName,retryStartup,switchAgentModel,appointAgent,switchModel,selectedModel,missingTerminal} from '../team-runtime.mjs';
const exec=promisify(execFile);
const root=path.dirname(fileURLToPath(import.meta.url));
const validChat=id=>id==='legacy'||/^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
const read=(file,fallback=null)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);};
const release={uiBuild:'20261122-flow53',appVersion:read(new URL('../package.json',import.meta.url))?.version??null};
const projectId=folder=>createHash('sha256').update(folder).digest('hex').slice(0,20);
const failure=(message,status=400)=>Object.assign(new Error(message),{status});
function categoryName(value){
  if(typeof value!=='string'||value.length>40||/[\p{Cc}]/u.test(value))throw failure('分類名稱最多 40 字。');
  const name=value.trim();
  return name==='未分類'?'':name;
}
export function createServer(config) {
  if(!config.allowedLogin||!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(config.origin))throw Error('An explicit Tailnet login and HTTPS origin are required.');
  const home=config.appHome || path.join(os.homedir(),'.config/herdr-app');
  const ctx=(folder,terminal=null,run,chat=null)=>context(folder,terminal,run,chat,config.headless?config:undefined);
  const extraFile=path.join(home,'web','chats.json');
  const projectFile=path.join(home,'web','projects.json');
  const activeFile=path.join(home,'web','selection.json');
  const categoriesFile=path.join(home,'web','project-categories.json');
  const rememberSelection=(p,chat)=>write(activeFile,{project:p.id||projectId(p.folder),chat});
  const csrf=randomBytes(32).toString('hex');let lastMessages=new Map();
  const projects=()=>{
    const categories=read(categoriesFile,{});
    const shared=read(path.join(home,'shared.json'),{}),extra=read(extraFile,[]);
    const all=[...(shared['team-chat.projects']||[])];
    for(const p of read(projectFile,[]))if(!all.some(x=>x.folder===p.folder))all.push(p);
    return all.filter(p=>typeof p.folder==='string'&&Array.isArray(p.chats)).map(p=>{
      const chats=[...p.chats];for(const c of extra.filter(c=>c.folder===p.folder))if(!chats.some(x=>x.id===c.id))chats.push(c);
      const id=projectId(p.folder);
      return {...p,id,category:categories[id]??p.category??'',chats:chats.filter(c=>validChat(c.id))};
    });
  };
  const activityCache=new Map();
  const legacyAgent='__coordinator__';
  const transcriptOwner=row=>row.direct?(row.target||row.agentId):legacyAgent;
  const leadAgent=(p,members,profile)=>profile.agentId||(p.agentWorkspace&&(members.find(a=>a.id==='starter')?.id||members[0]?.id))||legacyAgent;
  function transcript(scope){
    const file=path.join(scope.teamDir,'messages.jsonl');
    try{
      const stat=fs.statSync(file),version=[stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':'),previous=activityCache.get(file);
      if(previous?.version===version)return previous;
      const activity=new Map(),rows=[],deliveries=new Map();
      const lines=fs.readFileSync(file,'utf8').split('\n');
      for(const [index,line] of lines.entries()){
        if(!line)continue;
        let row;
        try{row=JSON.parse(line);}catch{continue;}
        if(typeof row?.kind!=='string')continue;
        if(row.kind==='delivery'){
          if(row.messageId)deliveries.set(row.messageId,row.delivery);
          continue;
        }
        const owner=transcriptOwner(row),time=Date.parse(row.time);
        if(!owner)continue;
        rows.push({row,index,owner,time});
        if(!['user','reply','collaboration'].includes(row.kind)||!Number.isFinite(time))continue;
        const entry=activity.get(owner)||{time,title:''};
        entry.time=Math.max(entry.time,time);
        if(!entry.title&&row.kind==='user'&&typeof row.text==='string'){
          const first=row.text.trim().split('\n',1)[0];
          entry.title=first.startsWith('請先讀取以下專案附件。')?'附件對話':Array.from(first).slice(0,36).join('');
        }
        activity.set(owner,entry);
      }
      const parsed={version,rows,deliveries,activity};
      if(stat.size<=2*1024*1024){
        activityCache.delete(file);
        activityCache.set(file,parsed);
        if(activityCache.size>16)activityCache.delete(activityCache.keys().next().value);
      }
      return parsed;
    }catch(error){if(error.code!=='ENOENT')throw error;return {version:'empty',rows:[],deliveries:new Map(),activity:new Map()};}
  }
  function agentTimeline(p,c,chat,requestedAgent,before,known){
    const members=roster(c),lead=leadAgent(p,members,coordinatorProfile(c));
    if(requestedAgent&&requestedAgent!==legacyAgent&&!members.some(a=>a.id===requestedAgent))throw failure('找不到這位專案代理。',404);
    const agent=requestedAgent||lead;
    const sources=p.chats.map((entry,order)=>{
      const scope=entry.id===chat?c:ctx(p.folder,null,undefined,entry.id==='legacy'?null:entry.id);
      return {entry,order,log:transcript(scope)};
    });
    const revision=createHash('sha256').update(JSON.stringify([agent,sources.map(s=>[s.entry.id,s.log.version])])).digest('hex');
    if(!before&&known===revision)return {agent,revision};
    const records=sources.flatMap(({entry,order,log})=>log.rows.filter(r=>r.owner===agent).map(({row,index,time})=>({
      key:entry.id+':'+index,chat:entry.id,order,index,time:Number.isFinite(time)?time:Number(entry.createdAt)||0,
      row,delivery:log.deliveries.get(row.messageId)||row.delivery
    })));
    records.sort((a,b)=>a.time-b.time||a.order-b.order||a.index-b.index);
    const end=before?records.findIndex(r=>r.key===before):records.length;
    if(end<0)throw failure('訊息清單已更新，請重新整理後再試。',409);
    const start=Math.max(0,end-100),page=records.slice(start,end);
    return {agent,revision,before:start>0?page[0].key:null,messages:page.map(r=>({...r.row,delivery:r.delivery,
      sourceChat:r.chat,timelineId:r.key,timelineAt:r.time,timelineOrder:r.order,timelineIndex:r.index}))};
  }
  function recentConversation(p,requestedAgent){
    const fallback=p.chats.at(-1);
    try{
      const base=ctx(p.folder,null),members=roster(base),profile=coordinatorProfile(base);
      const lead=leadAgent(p,members,profile);
      const agent=members.some(a=>a.id===requestedAgent)?requestedAgent:lead;
      let latestAgent=null,latestLead=null,latestAny=null;
      for(const chat of p.chats){
        const scope=chat.id==='legacy'?base:ctx(p.folder,null,undefined,chat.id);
        for(const [owner,{time}] of transcript(scope).activity){
          const entry={chat,time};
          if(!latestAny||time>=latestAny.time)latestAny=entry;
          if(owner===lead&&(!latestLead||time>=latestLead.time))latestLead=entry;
          if(owner===agent&&(!latestAgent||time>=latestAgent.time))latestAgent=entry;
        }
      }
      return (latestAgent||latestLead||latestAny)?.chat||fallback;
    }catch{
      return fallback;
    }
  }
  const choose=(project,chat,latest=false,agent=null)=>{
    const list=projects(),saved=read(activeFile),handoff=read(path.join(home,'team-chat.json'));
    const fallback=list.find(p=>p.id===saved?.project)||list.find(p=>p.folder===handoff?.folder)||list[0];
    const p=project?list.find(p=>p.id===project):fallback;
    if(!p)throw failure('請先建立工作專案。',404);
    const resumed=!project?(saved?.project===p.id?saved.chat:handoff?.folder===p.folder?handoff.chatId:null):null;
    const selected=chat?p.chats.find(c=>c.id===chat):
      latest?recentConversation(p,agent):p.chats.find(c=>c.id===resumed)||p.chats.at(-1);
    if(!selected)throw failure('找不到已登記的對話。',404);
    return {p,chat:selected.id};
  };
  const selection=(project,requestedChat)=>{
    const {p,chat}=choose(project,requestedChat);
    let folder;try{folder=fs.realpathSync(p.folder);}catch{throw failure('專案儲存位置未就緒，請檢查主機 Drive 登入或資料夾。',503);}
    return {p,chat,c:ctx(folder,null,undefined,chat==='legacy'?null:chat)};
  };
  const core=async args=>{
    if(config.core)return config.core(args);
    const {stdout}=await exec(path.join(os.homedir(),'.local/bin/hc'),args,{timeout:4000,maxBuffer:1024*1024});return JSON.parse(stdout);
  };
  const publicArtifacts=task=>artifactReferences(task).map(({index,name,kind})=>({index,name,kind}));
  const push=createPushStore({home,origin:config.origin,send:config.pushSend});
  const quotaClis=config.headless?{codex:config.codexQuotaCli,minimax:config.miniMaxQuotaCli}:{};
  const refreshCodex=codexQuotaRefresher(home,quotaClis.codex);
  const refreshMiniMax=miniMaxQuotaRefresher(home,quotaClis.minimax);
  const modelFile=p=>path.join(home,'agent-models',p.id+'.json');
  const modelCache=new Map(),historicModels=new Map();
  async function readFooter(t,provider){
    const key=t.address+':'+t.cwd+':'+provider;
    const previous=modelCache.get(key),now=Date.now();
    if(previous?.until>now)return previous.pending;
    const pending=core(['read',t.address,'--json','--lines','0'])
      .then(r=>footerModel(provider,r.text)).catch(()=>null);
    modelCache.set(key,{until:now+20_000,pending});
    if(modelCache.size>128)modelCache.delete(modelCache.keys().next().value);
    return pending;
  }
  function previousModels(p,agents,provider){
    const active=new Map(agents.map(a=>[a.id,a.provider]));
    let saved={};try{saved=read(modelFile(p),{});}catch{}
    active.set('__coordinator__',provider);
    let history=historicModels.get(p.id);
    if(!history){
      history={};
      for(const chat of p.chats){
        try{
          const scope=ctx(p.folder,null,undefined,chat.id==='legacy'?null:chat.id);
          const bindings=read(path.join(scope.teamDir,'direct-bindings.json'),{});
          for(const b of Object.values(bindings)){
            if(b.chat===chat.id&&active.get(b.agentId)===b.provider){
              mergeModel(history,b.agentId,b.provider,b.model,b.lastSentAt||b.createdAt);
            }
          }
        }catch{}
      }
      historicModels.set(p.id,history);
    }
    return Object.fromEntries([...active].flatMap(([id,engine])=>{
      const candidate=[history[id],saved[id]].filter(x=>x?.provider===engine&&validModel(x.model)).sort((a,b)=>b.at-a.at)[0];
      return candidate?[[id,candidate]]:[];
    }));
  }
  const observeWorkers=createWorkerObserver(core,scope=>transcript(scope).rows.map(r=>r.row));
  const state=async url=>{
    const accountQuotas=config.headless?readQuotas(home).filter(q=>!Object.hasOwn(quotaClis,q.provider)||quotaClis[q.provider]):[];
    const list=projects();const summary=list.map(p=>{
      let profile={name:'領頭羊'},agents=[],available=true,sidebar=null,lastModels={},preferredModel=null;
      try{
        const lastChat=p.chats.at(-1)?.id;
        const c=ctx(p.folder,null),last=lastChat&&lastChat!=='legacy'?ctx(p.folder,null,undefined,lastChat):c;
        profile=coordinatorProfile(c);agents=roster(c);sidebar=sidebarState(c,!!p.agentWorkspace);
        lastModels=previousModels(p,agents,profile.provider||'claude');
        preferredModel=selectedModel(last);
      }catch{available=false;}
      return {id:p.id,name:p.name,category:p.category,coordinatorName:profile.name,coordinatorProvider:profile.provider||'claude',
        coordinatorPreferredModel:preferredModel,coordinatorAgentId:profile.agentId||null,
        agentWorkspace:!!p.agentWorkspace||!!profile.agentId,agents,sidebar,lastModels,available,
        chats:p.chats.map(c=>({id:c.id,title:c.title,createdAt:c.createdAt,topicFor:c.topicFor}))};
    });
    const plans=list.flatMap(p=>{try{return[{id:p.id,candidates:workerCandidates(p,(folder,chat=null)=>ctx(folder,null,undefined,chat))}];}catch{return[];}});
    if(plans.some(p=>p.candidates.length))for(const observed of await observeWorkers(plans)){const project=summary.find(p=>p.id===observed.id);if(project)project.temporaryWorkers=observed.workers;}
    if(!list.length)return {...release,accountQuotas,projects:summary,agents:[],messages:[],terminals:[],csrfToken:csrf,host:os.hostname(),appOpen:config.headless?serviceAlive(home):false,backendMode:config.headless?'background':'desktop',drive:storageStatus(config)};
    const choice=choose(url.searchParams.get('project'),url.searchParams.get('chat'),
      url.searchParams.get('latest')==='1',url.searchParams.get('agent'));
    const picked=summary.find(p=>p.id===choice.p.id);
    if(picked&&!picked.available)return{...release,accountQuotas,projects:summary,project:picked.id,chat:choice.chat,agents:[],messages:[],terminals:[],projectAvailable:false,coreError:'專案儲存位置未就緒，請檢查主機 Drive 登入或資料夾。',appOpen:config.headless?serviceAlive(home):false,backendMode:config.headless?'background':'desktop',drive:storageStatus(config),csrfToken:csrf,host:os.hostname()};
    const {p,chat,c}=selection(choice.p.id,choice.chat);
    const timeline=url.searchParams.get('timeline')==='1'?agentTimeline(p,c,chat,url.searchParams.get('agent'),null,url.searchParams.get('timelineRevision')):null;
    if(!timeline)for(const entry of picked.chats){
      const scope=entry.id===chat?c:ctx(p.folder,null,undefined,entry.id==='legacy'?null:entry.id);
      entry.topics=Object.fromEntries(transcript(scope).activity);
    }
    const control=read(path.join(c.teamDir,'control.json'));
    let messages=[],messagesRevision='empty';try{const st=fs.statSync(path.join(c.teamDir,'messages.jsonl'));messagesRevision=st.size+':'+st.mtimeMs;messages=fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').slice(-300).flatMap(x=>{try{return[JSON.parse(x)];}catch{return[];}});}catch(e){if(e.code!=='ENOENT')throw e;}
    let terminals=[],coreError=null,coordinatorMissing=false;
    if(control?.terminal && /^t[a-z0-9]+$/.test(control.terminal)){
      try{
        const own=await core(['get',control.terminal]);terminals.push(own);
        const result=await core(['ls','--json','--label',`team.owner=${control.terminal}`,'--label',`team.chat=${chat}`]);
        const workers=await Promise.all((result.terminals||[]).slice(0,24).map(t=>core(['get',t.address])));
        terminals.push(...workers.filter(t=>t.parent===control.terminal));
      }catch(error){if(missingTerminal(error))coordinatorMissing=!terminals.some(t=>t.address===control.terminal);else coreError='目前無法取得代理終端狀態。';}
    }
    const direct=read(path.join(c.teamDir,'direct-bindings.json'),{});
    for(const [id,binding]of Object.entries(direct))try{const t=await core(['get',id]);if(binding.chat===chat&&(binding.legacyOwner?verifiedLegacyWorker(c,id,t,binding.agentId):t.cwd===c.cwd&&!t.parent&&t.labels?.['team.direct']==='true'&&t.labels?.['team.agent']===binding.agentId&&t.labels?.['team.chat']===chat)&&!terminals.some(row=>row.address===id))terminals.push(t);}catch{}
    let appOpen=false;const service=read(path.join(home,'service-status.json'));if(config.headless){appOpen=serviceAlive(home);}else{try{await fs.promises.stat(path.join(home,'herdr-app.sock'));appOpen=true;}catch{}}
    const directQueue=path.join(c.teamDir,'direct-queue'),pendingAgents=fs.existsSync(directQueue)?[...new Set(fs.readdirSync(directQueue).filter(n=>/^[a-f0-9-]+\.json$/.test(n)).map(n=>read(path.join(directQueue,n))?.agentId).filter(Boolean))]:[];
    const owner=terminals.find(t=>t.address===control?.terminal),stoppedAgents=roster(c).filter(a=>{const t=terminals.filter(t=>t.labels?.['team.direct']==='true'&&t.labels?.['team.agent']===a.id).at(-1),b=t&&direct[t.address];return t?.state==='finished'&&b&&!b.retired&&!b.retryRequested&&!b.delivered&&!b.captureHash;}).map(a=>a.id);
    for(const r of pendingRegistrations(c))if(!stoppedAgents.includes(r.agentId))stoppedAgents.push(r.agentId);
    const taskList=checklist(c);taskList.items=taskList.items.map(item=>({...item,artifacts:publicArtifacts(item)}));
    const jobs=Object.values(read(path.join(c.teamDir,'collaborations.json'),{})),members=roster(c),profile=coordinatorProfile(c);
    const name=id=>members.find(a=>a.id===id)?.name||id||profile.name;
    taskList.items.push(...jobs.map(j=>({id:j.id,title:name(j.sourceAgent)+' → '+(j.newAgent?.name||name(j.targetAgent)),owner:name(j.sourceAgent),acceptance:j.acceptance,status:({done:'done',queued:'pending',provisioning:'pending',failed:'blocked'})[j.status]||'in_progress',verification:j.verification,evidence:j.evidence||[]})));
    const publicJob=(j,bindings,sourceChat)=>({id:j.id,sourceChat,createdAt:j.createdAt,sourceAgent:j.sourceAgent,targetAgent:j.targetAgent,targetName:j.newAgent?.name,targetTerminal:j.targetTerminal,deliveryConfirmed:!!(bindings[j.targetTerminal]?.activeJob===j.id&&bindings[j.targetTerminal]?.delivered),task:j.task,acceptance:j.acceptance,status:j.status,verification:j.verification,feedback:j.feedback,parentId:j.parentId,artifacts:publicArtifacts(j)});
    const projectJobs=p.chats.flatMap(entry=>{
      const scope=entry.id===chat?c:ctx(p.folder,null,undefined,entry.id==='legacy'?null:entry.id);
      const bindings=entry.id===chat?direct:read(path.join(scope.teamDir,'direct-bindings.json'),{});
      const scopedJobs=entry.id===chat?jobs:Object.values(read(path.join(scope.teamDir,'collaborations.json'),{}));
      return scopedJobs.map(j=>publicJob(j,bindings,entry.id));
    }).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
    const recentDone=new Set(projectJobs.filter(j=>j.status==='done').slice(-20));
    const projectCollaborations=projectJobs.filter(j=>j.status!=='done'||recentDone.has(j));
    const ownerModel=read(path.join(c.teamDir,'model.json'));
    const ownerArgs=owner?.foreground?.argv||owner?.argv||[];
    const coordinatorParked=owner?.state==='live'&&!owner.status?.app&&control?.phase==='active'&&/(?:^|\/)(?:zsh|bash|sh|fish|nu)$/.test(ownerArgs[0]||'')&&!ownerArgs.includes('-c');
    const confirmedModels=read(path.join(c.teamDir,'agent-models.json'),{});
    const workerBindings=read(path.join(c.teamDir,'worker-bindings.json'),{});
    const memberProviders=new Map(members.map(a=>[a.id,a.provider]));
    const terminalViews=await Promise.all(terminals.map(async t=>{
      const binding=direct[t.address],adopted=!!binding?.legacyOwner&&!!verifiedLegacyWorker(c,t.address,t,binding.agentId),agentId=t.labels?.['team.agent']||(adopted?binding.agentId:null);
      const provider=terminalProvider(t)||binding?.provider||null;
      const observed=(t===owner?ownerModel:confirmedModels[agentId]);
      const args=t.foreground?.argv||t.argv||[],at=args.indexOf('--model');
      const directTerm=t.labels?.['team.direct']==='true'||adopted;
      const worker=workerBindings[t.address];
      const own=t===owner&&!t.parent&&!directTerm&&control.role===provider;
      const directAgent=directTerm&&(!t.parent||adopted)&&binding?.provider===provider;
      const scopedWorker=!directTerm&&t.parent&&t.parent===owner?.address&&worker?.owner===t.parent&&worker.chat===chat&&
        t.labels?.['team.owner']===t.parent&&t.labels?.['team.chat']===chat&&memberProviders.get(agentId)===provider;
      const verified=t.state==='live'&&t.cwd===c.cwd&&terminalProvider(t)&&(own||directAgent||scopedWorker);
      const ready=verified&&['idle','done'].includes(t.status?.state);
      const configured=at>=0?args[at+1]:null;
      const stored=observed?.terminal===t.address&&observed.confirmedAt?observed.model:binding?.model||configured;
      const footer=ready&&provider!=='claude'?await readFooter(t,provider):null;
      const model=validModel(footer)?footer:validModel(stored)?stored:null;
      return {address:t.address,parent:t.parent,name:t.name,state:t.state,status:t.status,observedAt:t.status_ms||null,parked:t.address===owner?.address&&coordinatorParked,
        agentId,waitingCollaboration:jobs.some(j=>j.sourceTerminal===t.address&&!['done','failed'].includes(j.status)),
        direct:directTerm,provider,model,modelObserved:!!(verified&&model)};
    }));
    const known=picked.lastModels;
    let changed=false;
    for(const t of terminalViews){
      if(!t.modelObserved||!['idle','done','working'].includes(t.status?.state))continue;
      const id=t.address===owner?.address?'__coordinator__':t.agentId;
      if(id&&(known[id]?.provider!==t.provider||known[id]?.model!==t.model)){
        changed=mergeModel(known,id,t.provider,t.model,Date.now())||changed;
      }
    }
    if(changed)try{
      const current=read(modelFile(p),{});
      for(const [id,v] of Object.entries(known))mergeModel(current,id,v.provider,v.model,v.at);
      write(modelFile(p),current);
    }catch{}
    const coordinatorView=terminalViews.find(t=>t.address===owner?.address);
    return {...release,skillRequests:p.chats.flatMap(entry=>{const scope=entry.id===chat?c:ctx(p.folder,null,undefined,entry.id==='legacy'?null:entry.id);return skillRequests(scope).map(r=>({...r,chat:entry.id}));}),accountQuotas,projects:summary,project:p.id,chat,agents:roster(c),sidebar:sidebarState(c,!!p.agentWorkspace),rosterRevision:rosterRevision(c),agentWorkspace:!!p.agentWorkspace||!!profile.agentId,coordinatorAgentId:profile.agentId||null,coordinatorName:profile.name,coordinatorProvider:profile.provider||(control?.role==='codex'?'codex':'claude'),agentCreationEnabled:c.privateState,registrationPendingAgents:pendingRegistrations(c).map(r=>r.agentId),coordinatorPreferredModel:selectedModel(c),coordinatorModel:coordinatorView?.model||null,pendingAgents,stoppedAgents,coordinatorReady:!!owner?.status?.app,coordinatorParked,startupStopped:coordinatorMissing||(owner?.state==='finished'&&!owner?.status?.app),checklist:taskList,collaborations:jobs.map(j=>publicJob(j,direct,chat)),projectCollaborations,messages,messagesRevision,usage:conversationUsage(messages,providerUsageRecords(c)),projectMemory:projectMemory(c),taskControls:chatTaskControls(c,messages,terminals,direct),control:control?{terminal:control.terminal,role:control.role,phase:control.phase}:null,
      terminals:terminalViews,coreError,appOpen,backendMode:config.headless?'background':'desktop',drive:storageStatus(config),csrfToken:csrf,host:os.hostname(),...(timeline?{timeline}:{})};
  };
  const contentTypes={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
  const streams=new Set();
  // Share bounded metadata scans between SSE clients of the same project.
  // Native filesystem notifications can omit rapid directory/file creation on macOS.
  const updateStamps=new Map();
  function updateStamp(c,p){
    const dirs=p.chats.map(entry=>entry.id==='legacy'?c.teamBase:path.join(c.teamBase,'conversations',entry.id));
    const files=[path.join(home,'web/projects.json'),path.join(home,'service-status.json'),c.teamBase,path.join(c.teamBase,'conversations'),
      ...['roster.json','coordinator.json','sidebar.json','checklist.json','project-memory.json'].map(n=>path.join(c.teamBase,n)),
      ...dirs.flatMap(dir=>[dir,...['messages.jsonl','collaborations.json','agent-registrations.json','direct-bindings.json','control.json','model.json','skill-requests.json','direct-queue'].map(n=>path.join(dir,n))])];
    const key=JSON.stringify(files),now=Date.now(),cached=updateStamps.get(key);
    if(cached&&now-cached.at<800)return cached.value;
    const value=files.map(file=>{try{const st=fs.statSync(file,{bigint:true});return [st.ino,st.size,st.mtimeNs,st.ctimeNs].join(':');}catch(error){return error.code;}}).join('|');
    updateStamps.delete(key);updateStamps.set(key,{at:now,value});
    if(updateStamps.size>64)updateStamps.delete(updateStamps.keys().next().value);
    return value;
  }
  function watchUpdates(res,c,p){
    if(streams.size>=64)throw failure('連線數量已達上限，請稍後再試。',429);
    const watchers=[];let pending,heartbeat,poller,closed=false,lastService='';
    const send=event=>{if(!closed&&!res.writableNeedDrain)res.write('event: '+event+'\ndata: {}\n\n');};
    const changed=()=>{if(!pending)pending=setTimeout(()=>{pending=null;send('change');},100);};
    const stop=()=>{if(closed)return;closed=true;clearTimeout(pending);clearInterval(heartbeat);clearInterval(poller);for(const watcher of watchers)watcher.close();streams.delete(stop);res.end();};
    stop.changed=changed;
    const watch=(folder,options,callback)=>{
      try{const watcher=(typeof config.watchFile==='function'?config.watchFile:fs.watch)(folder,options,callback);watcher.on('error',stop);watchers.push(watcher);}catch(error){if(error.code!=='ENOENT'){for(const watcher of watchers)watcher.close();throw error;}}
    };
    let watchRoot=c.teamBase;
    while(!fs.existsSync(watchRoot))watchRoot=path.dirname(watchRoot);
    watch(watchRoot,{recursive:true},(_event,name)=>{
      if(!name)return;
      const file=path.resolve(watchRoot,String(name));
      // A newly created state directory can arrive before its recursive file events.
      if(file===c.teamBase||c.teamBase.startsWith(file+path.sep)||file.startsWith(c.teamBase+path.sep)&&/\.(jsonl?|sent|cancelled|stopped)$/.test(String(name)))changed();
    });
    watch(path.join(home,'web'),{},(_event,name)=>{if(name&&String(name).endsWith('.json'))changed();});
    watch(home,{},(_event,name)=>{
      if(String(name)!=='service-status.json')return;
      try{const service=read(path.join(home,'service-status.json'),{}),key=JSON.stringify([service.pid,service.stopped,service.results]);if(key!==lastService){lastService=key;changed();}}catch{}
    });
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});
    res.flushHeaders();res.setTimeout(0);streams.add(stop);res.on('close',stop);
    let lastStamp=updateStamp(c,p);
    poller=setInterval(()=>{const stamp=updateStamp(c,p);if(stamp!==lastStamp){lastStamp=stamp;changed();}},1000);poller.unref();
    send('ready');heartbeat=setInterval(()=>{if(!closed)res.write(': heartbeat\n\n');},15000);heartbeat.unref();
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));if(req.method==='POST'&&status<300)for(const stop of streams)stop.changed();};
    try {
      const url=new URL(req.url,'http://localhost'),route=url.pathname.replace(/^\/herdr(?=\/|$)/,'')||'/';
      if(route==='/health'&&req.method==='GET'){json(200,{ok:true});return;}
      // Only a localhost Tailscale Serve proxy can reach this listener. Serve strips client-supplied identity headers.
      if(req.headers['tailscale-user-login']!==config.allowedLogin)throw failure('請從你本人已登入 Tailscale 的裝置開啟此連結。',403);
      if(req.headers.origin && req.headers.origin!==config.origin)throw failure('不允許的來源。',403);
      if(req.method==='GET'&&route==='/api/events'){
        const {project,chat}=Object.fromEntries(url.searchParams);
        if(!project||!chat)throw failure('缺少即時更新的專案或對話。');
        const {c,p}=selection(project,chat);watchUpdates(res,c,p);return;
      }
      if(req.method==='GET'&&route==='/api/notifications-key'){json(200,{publicKey:push.publicKey()});return;}
      if(req.method==='GET'&&route==='/api/state'){
        refreshCodex();refreshMiniMax();
        const current=await state(url);
        const known=url.searchParams.get('messagesRevision');
        if(known&&current.messagesRevision===known&&current.project===url.searchParams.get('project')&&
          current.chat===url.searchParams.get('chat'))delete current.messages;
        json(200,current);return;
      }
      if(req.method==='GET'&&route==='/api/history'){
        const {project,chat,agent,before}=Object.fromEntries(url.searchParams);
        if(!project||!chat||!/^([a-z0-9][a-z0-9-]{0,63}):\d{1,12}$/.test(before||''))throw failure('缺少較早訊息的位置。');
        const {p,c}=selection(project,chat);
        json(200,agentTimeline(p,c,chat,agent,before));return;
      }
      if(req.method==='GET'&&route==='/api/artifact'){
        const {project,chat,kind,id,index,mode}=Object.fromEntries(url.searchParams);
        if(!project||!chat||!['checklist','collaboration'].includes(kind)||!/^[a-z0-9-]{1,64}$/.test(id||'')||!/^\d{1,3}$/.test(index||'')||!['preview','image','download','drive'].includes(mode))throw failure('成果檔案識別碼無效。');
        const {c}=selection(project,chat);
        const task=kind==='checklist'?checklist(c).items.find(item=>item.id===id):Object.values(read(path.join(c.teamDir,'collaborations.json'),{})).find(job=>job.id===id);
        const item=await readArtifact(c,task,Number(index));
        if(mode==='preview'||mode==='drive'){
          const driveLink=await driveArtifactLink(c,item,config.driveRoot);
          if(mode==='preview'){json(200,{kind:item.kind,name:item.name,text:item.text,truncated:item.truncated,canOpenInDrive:!!driveLink});return;}
          if(!driveLink)throw failure('尚未取得這份成果的 Google Drive 連結。',404);
          res.writeHead(302,{Location:driveLink});res.end();return;
        }
        if(mode==='image'&&item.kind!=='image')throw failure('這個檔案沒有圖片預覽。',404);
        res.setHeader('Cross-Origin-Resource-Policy','same-origin');
        if(mode==='download')res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(item.name).replace(/['()*]/g,ch=>'%'+ch.charCodeAt(0).toString(16))}`);
        res.writeHead(200,{'Content-Type':mode==='image'?item.mime:'application/octet-stream','Content-Length':item.data.length});
        res.end(item.data);return;
      }
      if(req.method==='POST'&&route==='/api/attachment'){
        if(req.headers.origin!==config.origin||req.headers['x-herdr-csrf']!==csrf||
          req.headers['content-type']!=='application/octet-stream')throw failure('請重新整理頁面後再試。',403);
        const {project,chat,id,slot}=Object.fromEntries(url.searchParams);
        if(!project||!chat)throw failure('缺少附件的專案或對話。');
        const {c}=selection(project,chat);
        const name=decodeURIComponent(req.headers['x-herdr-filename']||'');
        if(!name)throw failure('缺少附件名稱。');
        json(201,await uploadAttachment(req,c,id,slot,name));return;
      }
      if(req.method==='POST'&&route.startsWith('/api/')) {
        if(req.headers.origin!==config.origin || req.headers['x-herdr-csrf']!==csrf || !String(req.headers['content-type']).startsWith('application/json'))throw failure('請重新整理頁面後再試。',403);
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>32768)throw failure('內容過長。',413);}
        const data=JSON.parse(body);
        if(route==='/api/storage'){
          if(!config.headless)throw failure('請先完成背景版安裝，再設定主機儲存位置。');
          let folder;try{folder=validateDriveRoot(data.folder);}catch(e){throw failure(e.message);}
          const next={...config,driveRoot:folder,projectRoot:folder};
          write(path.join(home,'service.json'),next);write(path.join(home,'web/config.json'),next);Object.assign(config,next);
          json(200,{...storageStatus(config),verifiedCloudUpload:false});return;
        }
        if(route==='/api/project'){
          if(typeof data.name!=='string'||!data.name.trim()||data.name.length>80)throw failure('請填寫專案名稱（最多 80 字）。');
          const category=categoryName(data.category??'');
          if(!config.projectRoot)throw failure('主機尚未設定新專案工作資料夾。');
          const records=read(projectFile,[]);if(records.length>=100)throw failure('已達專案數量上限。');
          const parent=path.resolve(config.projectRoot);fs.mkdirSync(parent,{recursive:true,mode:0o700});
          const slug=data.name.trim().replace(/[^\p{L}\p{N}_ -]/gu,'').slice(0,45)||'project';
          const folder=path.join(fs.realpathSync(parent),slug+'-'+randomBytes(4).toString('hex'));
          fs.mkdirSync(folder,{mode:0o700});
          const chat='web-'+Date.now().toString(36)+'-'+randomBytes(4).toString('hex');
          const project={folder,name:data.name.trim(),category,agentWorkspace:true,chats:[{id:chat,title:'新對話',createdAt:Date.now()}]};
          saveRoster(ctx(folder,null),[{id:'starter',name:'領頭羊',provider:'claude',level:'worker',model:'claude-opus-5-5'}]);records.push(project);write(projectFile,records);
          write(path.join(home,'team-chat.json'),{folder,name:project.name,chatId:chat,requestId:randomUUID()});
          rememberSelection(project,chat);json(200,{project:projectId(folder),chat});return;
        }
        const {p,chat,c}=selection(data.project,data.chat);
        if(route==='/api/adopt-worker'){
          if(!data.project||!data.chat||!/^t[a-z0-9]+$/.test(data.terminal||''))throw failure('請指定工作代理的原專案與對話。');
          const t=await core(['get',data.terminal]);json(200,adoptWorkerChat(c,t));return;
        }
        if(route==='/api/skill-decision'){if(!data.project||!data.chat)throw failure('請指定 Skill 請求所在對話。');json(200,decideSkillRequest(c,data));return;}
        if(route==='/api/project-memory'){json(200,saveProjectMemory(c,data));return;}
        if(route==='/api/task-action'){
          if(!data.project||!data.chat)throw failure('請指定任務所在的專案與對話。');
          const run=(_command,args)=>config.core?config.core(args):JSON.parse(execFileSync(path.join(os.homedir(),'.local/bin/hc'),args,{encoding:'utf8',timeout:4000,maxBuffer:1024*1024}));
          const result=actOnChatTask({...c,run},data);
          lastMessages.delete(p.id+':'+chat+':'+data.id);
          json(200,result);return;
        }
        if(route==='/api/project-category'){
          const category=categoryName(data.category);
          const categories=read(categoriesFile,{});
          if(data.action==='remove'){
            if(!category||category!==p.category)throw failure('分類已變更，請重新整理。',409);
            for(const project of projects())if(project.category===category)categories[project.id]='';
          }else if(data.action==='set'){
            categories[p.id]=category;
          }else throw failure('分類操作無效。');
          write(categoriesFile,categories);
          json(200,{category:data.action==='remove'?'':category});return;
        }
        if(route==='/api/notifications'){
          if(data.action==='subscribe'){json(200,push.add(data.subscription,p.id,chat));return;}
          if(data.action==='unsubscribe'){json(200,push.remove(data.endpoint));return;}
          if(data.action==='status'){json(200,push.status(data.endpoint,p.id,chat));return;}
          if(data.action==='test'){json(200,await push.test(data.endpoint,p.id,chat));return;}
          throw failure('不支援的通知操作。');
        }
        if(route==='/api/sidebar'){json(200,updateSidebar(c,!!p.agentWorkspace,data));return;}
        if(route==='/api/agent-manage'){
          if(!['delete','move'].includes(data.action))throw failure('不支援的代理操作。');
          const destination=data.action==='move'?selection(data.targetProject,null):null;
          const result=await manageAgent({source:c,target:destination?.c,sourceWorkspace:!!p.agentWorkspace,targetWorkspace:!!destination?.p.agentWorkspace,agentId:data.agentId,expectedRevision:data.rosterRevision,core});json(200,{...result,targetProject:destination?.p.id});return;
        }
        if(route==='/api/model'){json(200,await switchModel(c,data.model));return;}
        if(route==='/api/agent-model'){json(200,await switchAgentModel({...c,run:(_cmd,args)=>JSON.parse(execFileSync(path.join(os.homedir(),'.local/bin/hc'),args,{encoding:'utf8',cwd:c.cwd,timeout:15000}))},data.agentId,data.model));return;}
        if(route==='/api/project-name'){
          if(typeof data.name!=='string'||!data.name.trim()||data.name.length>80||/[\x00-\x1f]/.test(data.name))throw failure('請填寫有效的專案名稱（最多 80 字）。');
          const records=read(projectFile,[]),index=records.findIndex(item=>item.folder===p.folder);if(index<0)throw failure('請先匯入此專案後再改名。');
          records[index]={...records[index],name:data.name.trim()};write(projectFile,records);json(200,{project:p.id,name:data.name.trim()});return;
        }
        if(route==='/api/retry-agent'){json(200,retryDirect(c,data.agentId));return;}
        if(route==='/api/retry-start'){json(200,await retryStartup({...c,run:(_cmd,args)=>core(args)}));return;}
        if(route==='/api/select'){rememberSelection(p,chat);json(200,{project:p.id,chat});return;}
        if(route==='/api/appoint'){json(200,appointAgent(c,data.agentId));return;}
        if(route==='/api/coordinator'){json(200,setCoordinatorName(c,data.name,data.provider));return;}
        if(route==='/api/message'){if(managementActive(c))throw failure('Agent routing is being updated; retry shortly.',409);
          if(typeof data.text!=='string'||(!data.text.trim()&&data.attachments===undefined)||data.text.length>12000)throw failure('請填寫任務（最多 12000 字），或加入附件。');
          if(typeof data.id!=='string'||!/^[a-f0-9-]{36}$/.test(data.id))throw failure('缺少訊息識別碼。');
          if(data.allowAgentCreation!==undefined&&typeof data.allowAgentCreation!=='boolean')throw failure('新增代理授權無效。');
          const allowAgentCreation=data.allowAgentCreation??'when-alone';
          const key=p.id+':'+chat+':'+data.id;
          if(lastMessages.has(key)){json(200,lastMessages.get(key));return;}
          // Queue through the existing runtime. This endpoint cannot invoke arbitrary CLI commands.
          const mentioned=roster(c).flatMap(a=>[a.id,a.name].map(alias=>({a,prefix:'@'+alias}))).sort((a,b)=>b.prefix.length-a.prefix.length).find(x=>data.text.startsWith(x.prefix)&&/^[\s：:，,]/.test(data.text.slice(x.prefix.length,x.prefix.length+1)));
          const recipient=mentioned?.a.id||data.agentId;
          const body=mentioned?data.text.slice(mentioned.prefix.length).replace(/^[\s：:，,]+/,''):data.text;
          const text=await messageWithAttachments(c,data.id,body,data.attachments);
          const result=recipient?enqueueDirect(c,recipient,text,data.id,allowAgentCreation):enqueueChat(c,text,data.id,allowAgentCreation);rememberSelection(p,chat);lastMessages.set(key,result);
          if(lastMessages.size>1000)lastMessages.delete(lastMessages.keys().next().value);
          json(200,result);return;
        }
        if(route==='/api/roster'){
          const result=withRosterState(c,()=>{
            if(data.rosterRevision!==undefined&&data.rosterRevision!==rosterRevision(c))throw failure('代理設定已在其他畫面更新，請重新開啟設定後再保存。',409);
            if(roster(c).some(a=>!data.agents?.some(b=>b.id===a.id)))throw failure('請由代理的 ⋯ 選單移除設定，以核對執行中工作。');
            return saveRoster(c,data.agents);
          });
          json(200,result);return;
        }
        if(route==='/api/chat'){
          if(data.agentId!=null&&!roster(c).some(agent=>agent.id===data.agentId))throw failure('找不到本專案的代理。',404);
          const next={folder:p.folder,id:'web-'+Date.now().toString(36)+'-'+randomBytes(4).toString('hex'),
            title:'新對話',createdAt:Date.now(),topicFor:data.agentId||legacyAgent};
          const extra=read(extraFile,[]);if(extra.length>=1000)throw failure('對話數量已達上限。');extra.push(next);write(extraFile,extra);
          // The native mod consumes this documented handoff file and registers the new conversation itself.
          write(path.join(home,'team-chat.json'),{folder:p.folder,chatId:next.id,requestId:randomUUID()});
          rememberSelection(p,next.id);json(200,{chat:next.id,project:p.id});return;
        }
        throw failure('找不到操作。',404);
      }
      if(req.method==='GET'&&['/','/index.html','/style.css','/app.js','/format.mjs','/viewport.mjs','/activity.mjs','/message-list.mjs','/tasks.mjs','/sheep.svg','/shepherd.svg','/manifest.webmanifest','/sw.js','/app-icon.svg','/icon-192.png','/icon-512.png','/apple-touch-icon.png'].includes(route)){
        if(url.pathname==='/herdr'){res.writeHead(302,{Location:'/herdr/'});res.end();return;}
        const name=route==='/'?'index.html':route.slice(1);res.writeHead(200,{'Content-Type':contentTypes[path.extname(name)]});res.end(fs.readFileSync(path.join(root,name)));return;
      }
      throw failure('找不到頁面。',404);
    }catch(e){json(e.status||400,{error:e.status?e.message:'操作失敗，請重新整理或查看主機紀錄。'});}
  });
  const timer=setInterval(()=>push.tick(async({project,chat})=>state(new URL('http://localhost/api/state?'+new URLSearchParams({project,chat})))).catch(()=>{}),15000);timer.unref();server.on('close',()=>clearInterval(timer));
  const close=server.close.bind(server);
  server.close=(...args)=>{for(const stop of [...streams])stop();return close(...args);};
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=read(path.join(root,'config.json'));
  if(!config)throw Error('Missing local web/config.json');
  const server=createServer(config);
  server.listen(config.port||48723,'127.0.0.1',()=>console.log('Herdr web listening on loopback; Tailnet identity required.'));
}
