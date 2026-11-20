import {createPushStore} from './push.mjs';
import {checklist} from '../checklist.mjs';
import {sidebarState,updateSidebar,rosterRevision,manageAgent,managementActive} from './agent-management.mjs';
import {enqueueDirect,retryDirect,chatTaskControls,actOnChatTask} from '../direct.mjs';
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
  const choose=(project,chat)=>{
    const list=projects(),saved=read(activeFile),handoff=read(path.join(home,'team-chat.json'));
    const fallback=list.find(p=>p.id===saved?.project)||list.find(p=>p.folder===handoff?.folder)||list[0];
    const p=project?list.find(p=>p.id===project):fallback;
    if(!p)throw failure('請先建立工作專案。',404);
    const resumed=!project?(saved?.project===p.id?saved.chat:handoff?.folder===p.folder?handoff.chatId:null):null;
    const selected=chat?p.chats.find(c=>c.id===chat):p.chats.find(c=>c.id===resumed)||p.chats.at(-1);
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
  const push=createPushStore({home,origin:config.origin,send:config.pushSend});
  const state=async url=>{
    const list=projects();const summary=list.map(p=>{let profile={name:'領頭羊'},agents=[],available=true,sidebar=null;try{const c=ctx(p.folder,null);profile=coordinatorProfile(c);agents=roster(c);sidebar=sidebarState(c,!!p.agentWorkspace);}catch{available=false;}return{id:p.id,name:p.name,category:p.category,coordinatorName:profile.name,coordinatorAgentId:profile.agentId||null,agentWorkspace:!!p.agentWorkspace||!!profile.agentId,agents,sidebar,available,chats:p.chats.map(c=>({id:c.id,title:c.title,createdAt:c.createdAt}))};});
    if(!list.length)return {uiBuild:'20261120-tasks26',appVersion:'0.6.0-dev',projects:summary,agents:[],messages:[],terminals:[],csrfToken:csrf,host:os.hostname(),appOpen:config.headless?serviceAlive(home):false,backendMode:config.headless?'background':'desktop',drive:storageStatus(config)};
    const choice=choose(url.searchParams.get('project'),url.searchParams.get('chat'));
    const picked=summary.find(p=>p.id===choice.p.id);
    if(picked&&!picked.available)return{uiBuild:'20261120-tasks26',appVersion:'0.6.0-dev',projects:summary,project:picked.id,chat:choice.chat,agents:[],messages:[],terminals:[],projectAvailable:false,coreError:'專案儲存位置未就緒，請檢查主機 Drive 登入或資料夾。',appOpen:config.headless?serviceAlive(home):false,backendMode:config.headless?'background':'desktop',drive:storageStatus(config),csrfToken:csrf,host:os.hostname()};
    const {p,chat,c}=selection(choice.p.id,choice.chat);
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
    for(const [id,binding]of Object.entries(direct))try{const t=await core(['get',id]);if(binding.chat===chat&&t.cwd===c.cwd&&!t.parent&&t.labels?.['team.direct']==='true'&&t.labels?.['team.agent']===binding.agentId&&t.labels?.['team.chat']===chat)terminals.push(t);}catch{}
    let appOpen=false;const service=read(path.join(home,'service-status.json'));if(config.headless){appOpen=serviceAlive(home);}else{try{await fs.promises.stat(path.join(home,'herdr-app.sock'));appOpen=true;}catch{}}
    const directQueue=path.join(c.teamDir,'direct-queue'),pendingAgents=fs.existsSync(directQueue)?[...new Set(fs.readdirSync(directQueue).filter(n=>/^[a-f0-9-]+\.json$/.test(n)).map(n=>read(path.join(directQueue,n))?.agentId).filter(Boolean))]:[];
    const owner=terminals.find(t=>t.address===control?.terminal),stoppedAgents=roster(c).filter(a=>{const t=terminals.filter(t=>t.labels?.['team.direct']==='true'&&t.labels?.['team.agent']===a.id).at(-1),b=t&&direct[t.address];return t?.state==='finished'&&b&&!b.retired&&!b.retryRequested&&!b.delivered&&!b.captureHash;}).map(a=>a.id);
    const taskList=checklist(c),jobs=Object.values(read(path.join(c.teamDir,'collaborations.json'),{})),members=roster(c);taskList.items.push(...jobs.map(j=>({id:j.id,title:(members.find(a=>a.id===j.sourceAgent)?.name||j.sourceAgent)+' → '+(members.find(a=>a.id===j.targetAgent)?.name||j.targetAgent),owner:members.find(a=>a.id===j.sourceAgent)?.name||j.sourceAgent,acceptance:j.acceptance,status:j.status==='done'?'done':j.status==='queued'?'pending':'in_progress',verification:j.verification,evidence:j.evidence||[]})));
    const ownerModel=read(path.join(c.teamDir,'model.json')),ownerArgs=owner?.foreground?.argv||owner?.argv||[],modelAt=ownerArgs.indexOf('--model');
    const coordinatorParked=owner?.state==='live'&&!owner.status?.app&&control?.phase==='active'&&/(?:^|\/)(?:zsh|bash|sh|fish|nu)$/.test(ownerArgs[0]||'')&&!ownerArgs.includes('-c');
    return {uiBuild:'20261120-tasks26',appVersion:'0.6.0-dev',projects:summary,project:p.id,chat,agents:roster(c),sidebar:sidebarState(c,!!p.agentWorkspace),rosterRevision:rosterRevision(c),agentWorkspace:!!p.agentWorkspace||!!coordinatorProfile(c).agentId,coordinatorAgentId:coordinatorProfile(c).agentId||null,coordinatorName:coordinatorProfile(c).name,coordinatorPreferredModel:selectedModel(c),coordinatorModel:ownerModel?.terminal===owner?.address&&ownerModel?.confirmedAt?ownerModel.model:modelAt>=0?ownerArgs[modelAt+1]:null,pendingAgents,stoppedAgents,coordinatorReady:!!owner?.status?.app,coordinatorParked,startupStopped:coordinatorMissing||(owner?.state==='finished'&&!owner?.status?.app),checklist:taskList,collaborations:jobs.map(j=>({id:j.id,sourceAgent:j.sourceAgent,targetAgent:j.targetAgent,task:j.task,acceptance:j.acceptance,status:j.status,verification:j.verification,feedback:j.feedback,parentId:j.parentId})),messages,messagesRevision,taskControls:chatTaskControls(c,messages,terminals,direct),control:control?{terminal:control.terminal,role:control.role,phase:control.phase}:null,
      terminals:terminals.map(t=>{const agentId=t.labels?.['team.agent']||null,confirmed=read(path.join(c.teamDir,'agent-models.json'),{})[agentId],argv=t.foreground?.argv||t.argv||[],at=argv.indexOf('--model');return{address:t.address,parent:t.parent,name:t.name,state:t.state,status:t.status,parked:t.address===owner?.address&&coordinatorParked,agentId,waitingCollaboration:jobs.some(j=>j.sourceTerminal===t.address&&j.status!=='done'),direct:t.labels?.['team.direct']==='true',provider:direct[t.address]?.provider||({'claude-code':'claude',codex:'codex',antigravity:'antigravity',minimax:'minimax',mcode:'minimax'}[t.status?.app])||null,model:confirmed?.terminal===t.address?confirmed.model:direct[t.address]?.model||(at>=0?argv[at+1]:null)};}),coreError,appOpen,backendMode:config.headless?'background':'desktop',drive:storageStatus(config),csrfToken:csrf,host:os.hostname()};
  };
  const contentTypes={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try {
      const url=new URL(req.url,'http://localhost'),route=url.pathname.replace(/^\/herdr(?=\/|$)/,'')||'/';
      if(route==='/health'&&req.method==='GET'){json(200,{ok:true});return;}
      // Only a localhost Tailscale Serve proxy can reach this listener. Serve strips client-supplied identity headers.
      if(req.headers['tailscale-user-login']!==config.allowedLogin)throw failure('請從你本人已登入 Tailscale 的裝置開啟此連結。',403);
      if(req.headers.origin && req.headers.origin!==config.origin)throw failure('不允許的來源。',403);
      if(req.method==='GET'&&route==='/api/notifications-key'){json(200,{publicKey:push.publicKey()});return;}
      if(req.method==='GET'&&route==='/api/state'){json(200,await state(url));return;}
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
        if(route==='/api/appoint'){const selected=roster(c).find(a=>a.id===data.agentId);let modelResult;if(selected?.provider==='claude')modelResult=await switchAgentModel(c,data.agentId,'claude-opus-5-5');json(200,{...appointAgent(c,data.agentId),modelApplied:modelResult?.applied||false});return;}
        if(route==='/api/coordinator'){json(200,setCoordinatorName(c,data.name));return;}
        if(route==='/api/message'){if(managementActive(c))throw failure('Agent routing is being updated; retry shortly.',409);
          if(typeof data.text!=='string'||!data.text.trim()||data.text.length>12000)throw failure('請填寫任務（最多 12000 字）。');
          if(typeof data.id!=='string'||!/^[a-f0-9-]{36}$/.test(data.id))throw failure('缺少訊息識別碼。');
          const key=p.id+':'+chat+':'+data.id;
          if(lastMessages.has(key)){json(200,lastMessages.get(key));return;}
          // Queue through the existing runtime. This endpoint cannot invoke arbitrary CLI commands.
          const mentioned=roster(c).flatMap(a=>[a.id,a.name].map(alias=>({a,prefix:'@'+alias}))).sort((a,b)=>b.prefix.length-a.prefix.length).find(x=>data.text.startsWith(x.prefix)&&/^[\s：:，,]/.test(data.text.slice(x.prefix.length,x.prefix.length+1)));
          const recipient=mentioned?.a.id||data.agentId,text=mentioned?data.text.slice(mentioned.prefix.length).replace(/^[\s：:，,]+/,''):data.text;
          const result=recipient?enqueueDirect(c,recipient,text,data.id):enqueueChat(c,text,data.id);rememberSelection(p,chat);lastMessages.set(key,result);
          if(lastMessages.size>1000)lastMessages.delete(lastMessages.keys().next().value);
          json(200,result);return;
        }
        if(route==='/api/roster'){if(data.rosterRevision!==undefined&&data.rosterRevision!==rosterRevision(c))throw failure('Agent settings changed; reload before saving.',409);if(roster(c).some(a=>!data.agents?.some(b=>b.id===a.id)))throw failure('請由代理的 ⋯ 選單移除設定，以核對執行中工作。');json(200,saveRoster(c,data.agents));return;}
        if(route==='/api/chat'){
          const next={folder:p.folder,id:'web-'+Date.now().toString(36)+'-'+randomBytes(4).toString('hex'),title:'新對話',createdAt:Date.now()};
          const extra=read(extraFile,[]);if(extra.length>=1000)throw failure('對話數量已達上限。');extra.push(next);write(extraFile,extra);
          // The native mod consumes this documented handoff file and registers the new conversation itself.
          write(path.join(home,'team-chat.json'),{folder:p.folder,chatId:next.id,requestId:randomUUID()});
          rememberSelection(p,next.id);json(200,{chat:next.id,project:p.id});return;
        }
        throw failure('找不到操作。',404);
      }
      if(req.method==='GET'&&['/','/index.html','/style.css','/app.js','/format.mjs','/viewport.mjs','/activity.mjs','/tasks.mjs','/sheep.svg','/shepherd.svg','/manifest.webmanifest','/sw.js','/app-icon.svg','/icon-192.png','/icon-512.png','/apple-touch-icon.png'].includes(route)){
        if(url.pathname==='/herdr'){res.writeHead(302,{Location:'/herdr/'});res.end();return;}
        const name=route==='/'?'index.html':route.slice(1);res.writeHead(200,{'Content-Type':contentTypes[path.extname(name)]});res.end(fs.readFileSync(path.join(root,name)));return;
      }
      throw failure('找不到頁面。',404);
    }catch(e){json(e.status||400,{error:e.status?e.message:'操作失敗，請重新整理或查看主機紀錄。'});}
  });
  const timer=setInterval(()=>push.tick(async({project,chat})=>state(new URL('http://localhost/api/state?'+new URLSearchParams({project,chat})))).catch(()=>{}),15000);timer.unref();server.on('close',()=>clearInterval(timer));
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=read(path.join(root,'config.json'));
  if(!config)throw Error('Missing local web/config.json');
  const server=createServer(config);
  server.listen(config.port||48723,'127.0.0.1',()=>console.log('Herdr web listening on loopback; Tailnet identity required.'));
}
