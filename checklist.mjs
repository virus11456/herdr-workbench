import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const digest=value=>createHash('sha256').update(value).digest('hex');
const statuses=new Set(['pending','in_progress','blocked','done']);
export function checklist(c){return read(path.join(c.teamDir,'checklist.json'))||{revision:0,items:[]};}
function text(value,label,max=1000){if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw Error('Invalid '+label);return value.trim();}
function evidence(c,ref){
 if(!ref||! /^[a-f0-9]{64}$/.test(ref.sha256||''))throw Error('Evidence requires SHA-256.');
 let bytes,description;
 if(ref.type==='file'){
  const real=fs.realpathSync(path.resolve(c.cwd,text(ref.path,'evidence path'))),relative=path.relative(c.cwd,real);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Evidence must stay inside the project.');
  const stat=fs.statSync(real);if(!stat.isFile()||stat.size>20*1024*1024)throw Error('Evidence must be a file no larger than 20 MB.');
  bytes=fs.readFileSync(real);description={type:'file',path:relative};
 }else if(ref.type==='response'){
  if(!/^[a-f0-9-]{36}$/.test(ref.id||''))throw Error('Invalid response ID.');
  const request=read(path.join(c.teamDir,'requests',ref.id+'.json.done')),response=read(path.join(c.teamDir,'responses',ref.id+'.json'));
  if(!request||request.id!==ref.id||request.action!=='read'||response?.ok!==true)throw Error('Evidence needs a completed terminal read with the same request ID.');
  bytes=Buffer.from(JSON.stringify(response.result));description={type:'response',id:ref.id};
 }else throw Error('Unsupported evidence type.');
 const sha256=digest(bytes);if(sha256!==ref.sha256)throw Error('Evidence changed or SHA-256 does not match.');
 return {...description,sha256,checkedAt:new Date().toISOString()};
}
// Called only by the serialized runtime request executor; workers cannot update it.
export function updateChecklist(c,input,sender){
 const control=read(path.join(c.teamDir,'control.json'));
 if(!sender||control?.terminal!==sender)throw Error('Only the active coordinator may update the checklist.');
 const current=checklist(c);
 if(input?.revision!==current.revision)throw Error('Checklist changed; read it again before updating.');
 if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id||''))throw Error('Invalid task ID.');
 const previous=current.items.find(i=>i.id===input.id),status=input.status||'pending';
 if(!statuses.has(status))throw Error('Invalid task status.');
 if(!previous&&current.items.length>=100)throw Error('Checklist is limited to 100 tasks per conversation.');
 const item={id:input.id,title:text(input.title,'title',200),owner:text(input.owner,'owner',80),acceptance:text(input.acceptance,'acceptance'),status,reason:status==='blocked'?text(input.reason,'blocked reason'):null,verification:null,evidence:[],updatedAt:new Date().toISOString()};
 if(status==='done'){
  item.verification=text(input.verification,'coordinator acceptance result');
  if(!Array.isArray(input.evidence)||!input.evidence.length||input.evidence.length>10)throw Error('Completion requires evidence; queued or an agent claim is insufficient.');
  item.evidence=input.evidence.map(ref=>evidence(c,ref));
 }
 const next={revision:current.revision+1,items:previous?current.items.map(i=>i.id===item.id?item:i):[...current.items,item]};
 fs.mkdirSync(c.teamDir,{recursive:true,mode:0o700});const file=path.join(c.teamDir,'checklist.json'),tmp=file+'.'+randomUUID()+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);return next;
}
