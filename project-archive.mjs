import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const checked=new Map();
const sha=text=>createHash('sha256').update(text).digest('hex');
const pick=(row,keys)=>Object.fromEntries(keys.filter(key=>row?.[key]!==undefined).map(key=>[key,row[key]]));
function read(root,name,fallback){
 const file=path.join(root,name);let stat;
 try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return fallback;throw error;}
 if(!stat.isFile()||stat.size>16*1024*1024||!fs.realpathSync(file).startsWith(fs.realpathSync(root)+path.sep))throw Error('專案紀錄來源超出允許範圍，未歸檔。');
 return fs.readFileSync(file,'utf8');
}
const json=(root,name,fallback)=>{const text=read(root,name,null);return text===null?fallback:JSON.parse(text);};
export function archiveStatus(c){
 const value=json(c.teamBase,'archive-status.json',null);
 return value?{writtenAt:value.writtenAt,sha256:value.sha256,cloudVerified:false}:null;
}
function directory(root,name){
 const dir=path.join(root,name);fs.mkdirSync(dir,{recursive:true,mode:0o700});
 if(!fs.lstatSync(dir).isDirectory()||fs.realpathSync(dir)!==dir)throw Error('專案歸檔位置不能是連結。');
 return dir;
}
// Recovery data only. Never copy control files, queues, native CLI sessions,
// credentials, usage/auth responses or the entire private state directory.
export function archiveProject(c,project,config,now=Date.now()){
 if(!config.driveRoot)return{status:'not_configured'};
 const root=fs.realpathSync(config.driveRoot),folder=fs.realpathSync(c.cwd);
 if(!folder.startsWith(root+path.sep))return{status:'local_project',written:false};
 const key=folder,last=checked.get(key);if(last&&now-last.time<60000)return{...last.result,throttled:true};
 fs.mkdirSync(c.teamBase,{recursive:true,mode:0o700});
 const base=fs.realpathSync(c.teamBase),memory=c.memoryDir||base,scopes=[{id:'legacy',dir:base}];
 const conversations=path.join(base,'conversations');
 if(fs.existsSync(conversations))for(const d of fs.readdirSync(conversations,{withFileTypes:true}))if(d.isDirectory()&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(d.name)){
  const dir=path.join(conversations,d.name);if(!fs.realpathSync(dir).startsWith(base+path.sep))throw Error('對話來源超出專案。');scopes.push({id:d.name,dir});
 }
 const members=json(base,'roster.json',[]).map(row=>pick(row,['id','name','provider','model','brief','group','level']));
 const record={schema:1,project:{name:project.name,id:project.stableId||sha(config.projectOrigins?.[folder]||folder).slice(0,20)},members,
  coordinator:pick(json(base,'coordinator.json',{}),['name','agentId','provider','managerModel']),
  memory:pick(json(memory,'project-memory.json',{}),['text','revision']),sidebar:pick(json(base,'sidebar.json',{}),['order','pinned']),conversations:[]};
 for(const scope of scopes){
  const lines=read(scope.dir,'messages.jsonl','').split('\n').filter(Boolean),messages=lines.map(line=>pick(JSON.parse(line),['kind','role','text','time','messageId','replyTo','direct','target','agentId','collaborationId','reportId']));
  record.conversations.push({id:scope.id,messages,handoff:read(scope.dir,'STATUS.md',null),checklist:json(scope.dir,'checklist.json',null),collaborations:Object.values(json(scope.dir,'collaborations.json',{})).map(row=>pick(row,['id','sourceAgent','targetAgent','task','acceptance','status','verification','feedback','evidence','revision','createdAt']))});
 }
 const body=JSON.stringify(record,null,2)+'\n';
 if(/(?:sk-proj-[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,})/.test(body))throw Error('紀錄疑似包含憑證，已停止寫入雲端快照，請先檢查。');
 const digest=sha(body),statusFile=path.join(base,'archive-status.json'),previous=json(base,'archive-status.json',{});
 const destination=path.join(folder,'專案紀錄','工作台快照.json');
 let written=false;
 if(previous.sha256!==digest||!fs.existsSync(destination)){
  const dir=directory(folder,'專案紀錄'),file=path.join(dir,'工作台快照.json');
  if(fs.existsSync(file)&&!fs.lstatSync(file).isFile())throw Error('專案快照目的地無效。');
  const tmp=path.join(dir,'.archive-'+randomUUID());try{fs.writeFileSync(tmp,body,{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}
  const status={sha256:digest,bytes:Buffer.byteLength(body),writtenAt:new Date(now).toISOString(),cloudVerified:false};
  const tmpStatus=statusFile+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmpStatus,JSON.stringify(status),{mode:0o600});fs.renameSync(tmpStatus,statusFile);written=true;
 }
 const result={status:'awaiting_drive_sync',written,sha256:digest,cloudVerified:false};
 checked.set(key,{time:now,result});if(checked.size>256)checked.delete(checked.keys().next().value);return result;
}
