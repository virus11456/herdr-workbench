import {checklist} from '../checklist.mjs';
import {validateDriveRoot,storageStatus,serviceAlive} from '../storage.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {context,roster,saveRoster,enqueueChat,coordinatorProfile,setCoordinatorName} from '../team-runtime.mjs';
const exec=promisify(execFile);
const root=path.dirname(fileURLToPath(import.meta.url));
const validChat=id=>id==='legacy'||/^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
const read=(file,fallback=null)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);};
const projectId=folder=>createHash('sha256').update(folder).digest('hex').slice(0,20);
const failure=(message,status=400)=>Object.assign(new Error(message),{status});
export function createServer(config) {
  if(!config.allowedLogin||!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(config.origin))throw Error('An explicit Tailnet login and HTTPS origin are required.');
  const home=config.appHome || path.join(os.homedir(),'.config/herdr-app');
  const ctx=(folder,terminal=null,run,chat=null)=>context(folder,terminal,run,chat,config.headless?config:undefined);
  const extraFile=path.join(home,'web','chats.json');
  const projectFile=path.join(home,'web','projects.json');
  const csrf=randomBytes(32).toString('hex');let lastMessages=new Map();
  const projects=()=>{
    const shared=read(path.join(home,'shared.json'),{}),extra=read(extraFile,[]);
    const all=[...(shared['team-chat.projects']||[])];
    for(const p of read(projectFile,[]))if(!all.some(x=>x.folder===p.folder))all.push(p);
    return all.filter(p=>typeof p.folder==='string'&&Array.isArray(p.chats)).map(p=>{
      const chats=[...p.chats];for(const c of extra.filter(c=>c.folder===p.folder))if(!chats.some(x=>x.id===c.id))chats.push(c);
      return {...p,id:projectId(p.folder),chats:chats.filter(c=>validChat(c.id))};
    });
  };
  const selection=(project,chat)=>{
    const list=projects(),p=project?list.find(p=>p.id===project):list[0];
    if(!p)throw failure('請先建立工作專案。',404);
    const c=chat?p.chats.find(c=>c.id===chat):p.chats.at(-1);
    if(!c)throw failure('找不到已登記的對話。',404);
    let folder;try{folder=fs.realpathSync(p.folder);}catch{throw failure('專案儲存位置未就緒，請檢查主機 Drive 登入或資料夾。',503);}
    return {p,chat:c.id,c:ctx(folder,null,undefined,c.id==='legacy'?null:c.id)};
  };
  const core=async args=>{
    if(config.core)return config.core(args);
    const {stdout}=await exec(path.join(os.homedir(),'.local/bin/hc'),args,{timeout:4000,maxBuffer:1024*1024});return JSON.parse(stdout);
  };
  const state=async url=>{
    const list=projects();const summary=list.map(p=>{let profile={name:'協調總控'},agents=[],available=true;try{const c=ctx(p.folder,null);profile=coordinatorProfile(c);agents=roster(c);}catch{available=false;}return{id:p.id,name:p.name,coordinatorName:profile.name,agents,available,chats:p.chats.map(c=>({id:c.id,title:c.title,createdAt:c.createdAt}))};});
    if(!list.length)return {projects:summary,agents:[],messages:[],terminals:[],csrfToken:csrf,host:os.hostname(),appOpen:config.headless?serviceAlive(home):false,backendMode:config.headless?'background':'desktop',drive:storageStatus(config)};
    const picked=summary.find(p=>p.id===url.searchParams.get('project'))||summary[0];
    if(picked&&!picked.available)return{projects:summary,project:picked.id,chat:picked.chats.at(-1)?.id,agents:[],messages:[],terminals:[],projectAvailable:false,coreError:'專案儲存位置未就緒，請檢查主機 Drive 登入或資料夾。',appOpen:config.headless?serviceAlive(home):false,backendMode:config.headless?'background':'desktop',drive:storageStatus(config),csrfToken:csrf,host:os.hostname()};
    const {p,chat,c}=selection(url.searchParams.get('project'),url.searchParams.get('chat'));
    const control=read(path.join(c.teamDir,'control.json'));
    let messages=[],messagesRevision='empty';try{const st=fs.statSync(path.join(c.teamDir,'messages.jsonl'));messagesRevision=st.size+':'+st.mtimeMs;messages=fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').slice(-300).flatMap(x=>{try{return[JSON.parse(x)];}catch{return[];}});}catch(e){if(e.code!=='ENOENT')throw e;}
    let terminals=[],coreError=null;
    if(control?.terminal && /^t[a-z0-9]+$/.test(control.terminal)){
      try{
        const own=await core(['get',control.terminal]);terminals.push(own);
        const result=await core(['ls','--json','--label',`team.owner=${control.terminal}`,'--label',`team.chat=${chat}`]);
        const workers=await Promise.all((result.terminals||[]).slice(0,24).map(t=>core(['get',t.address])));
        terminals.push(...workers.filter(t=>t.parent===control.terminal));
      }catch{coreError='目前無法取得代理終端狀態。';}
    }
    let appOpen=false;const service=read(path.join(home,'service-status.json'));if(config.headless){appOpen=serviceAlive(home);}else{try{await fs.promises.stat(path.join(home,'herdr-app.sock'));appOpen=true;}catch{}}
    return {projects:summary,project:p.id,chat,agents:roster(c),coordinatorName:coordinatorProfile(c).name,checklist:checklist(c),messages,messagesRevision,control:control?{terminal:control.terminal,role:control.role,phase:control.phase}:null,
      terminals:terminals.map(t=>({address:t.address,parent:t.parent,name:t.name,state:t.state,status:t.status,agentId:t.labels?.['team.agent']||null})),coreError,appOpen,backendMode:config.headless?'background':'desktop',drive:storageStatus(config),csrfToken:csrf,host:os.hostname()};
  };
  const contentTypes={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try {
      const url=new URL(req.url,'http://localhost'),route=url.pathname.replace(/^\/herdr(?=\/|$)/,'')||'/';
      if(route==='/health'&&req.method==='GET'){json(200,{ok:true});return;}
      // Only a localhost Tailscale Serve proxy can reach this listener. Serve strips client-supplied identity headers.
      if(req.headers['tailscale-user-login']!==config.allowedLogin)throw failure('請從你本人已登入 Tailscale 的裝置開啟此連結。',403);
      if(req.headers.origin && req.headers.origin!==config.origin)throw failure('不允許的來源。',403);
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
          if(!config.projectRoot)throw failure('主機尚未設定新專案工作資料夾。');
          const records=read(projectFile,[]);if(records.length>=100)throw failure('已達專案數量上限。');
          const parent=path.resolve(config.projectRoot);fs.mkdirSync(parent,{recursive:true,mode:0o700});
          const slug=data.name.trim().replace(/[^\p{L}\p{N}_ -]/gu,'').slice(0,45)||'project';
          const folder=path.join(fs.realpathSync(parent),slug+'-'+randomBytes(4).toString('hex'));
          fs.mkdirSync(folder,{mode:0o700});
          const chat='web-'+Date.now().toString(36)+'-'+randomBytes(4).toString('hex');
          const project={folder,name:data.name.trim(),chats:[{id:chat,title:'新對話',createdAt:Date.now()}]};
          saveRoster(ctx(folder,null),[]);records.push(project);write(projectFile,records);
          write(path.join(home,'team-chat.json'),{folder,name:project.name,chatId:chat,requestId:randomUUID()});
          json(200,{project:projectId(folder),chat});return;
        }
        const {p,chat,c}=selection(data.project,data.chat);
        if(route==='/api/coordinator'){json(200,setCoordinatorName(c,data.name));return;}
        if(route==='/api/message'){
          if(typeof data.text!=='string'||!data.text.trim()||data.text.length>12000)throw failure('請填寫任務（最多 12000 字）。');
          if(typeof data.id!=='string'||!/^[a-f0-9-]{36}$/.test(data.id))throw failure('缺少訊息識別碼。');
          const key=p.id+':'+chat+':'+data.id;
          if(lastMessages.has(key)){json(200,lastMessages.get(key));return;}
          // Queue through the existing runtime. This endpoint cannot invoke arbitrary CLI commands.
          const result=enqueueChat(c,data.text,data.id);lastMessages.set(key,result);
          if(lastMessages.size>1000)lastMessages.delete(lastMessages.keys().next().value);
          json(200,result);return;
        }
        if(route==='/api/roster'){json(200,saveRoster(c,data.agents));return;}
        if(route==='/api/chat'){
          const next={folder:p.folder,id:'web-'+Date.now().toString(36)+'-'+randomBytes(4).toString('hex'),title:'新對話',createdAt:Date.now()};
          const extra=read(extraFile,[]);if(extra.length>=1000)throw failure('對話數量已達上限。');extra.push(next);write(extraFile,extra);
          // The native mod consumes this documented handoff file and registers the new conversation itself.
          write(path.join(home,'team-chat.json'),{folder:p.folder,chatId:next.id,requestId:randomUUID()});
          json(200,{chat:next.id,project:p.id});return;
        }
        throw failure('找不到操作。',404);
      }
      if(req.method==='GET'&&['/','/index.html','/style.css','/app.js','/format.mjs','/viewport.mjs','/sheep.svg','/shepherd.svg','/manifest.webmanifest','/sw.js','/app-icon.svg','/icon-192.png','/icon-512.png','/apple-touch-icon.png'].includes(route)){
        if(url.pathname==='/herdr'){res.writeHead(302,{Location:'/herdr/'});res.end();return;}
        const name=route==='/'?'index.html':route.slice(1);res.writeHead(200,{'Content-Type':contentTypes[path.extname(name)]});res.end(fs.readFileSync(path.join(root,name)));return;
      }
      throw failure('找不到頁面。',404);
    }catch(e){json(e.status||400,{error:e.status?e.message:'操作失敗，請重新整理或查看主機紀錄。'});}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=read(path.join(root,'config.json'));
  if(!config)throw Error('Missing local web/config.json');
  const server=createServer(config);
  server.listen(config.port||48723,'127.0.0.1',()=>console.log('Herdr web listening on loopback; Tailnet identity required.'));
}
