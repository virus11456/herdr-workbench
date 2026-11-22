import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
const identity=file=>{try{const stat=fs.lstatSync(file);if(!stat.isFile())return null;return{ino:stat.ino,dev:stat.dev,text:fs.readFileSync(file,'utf8')};}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const same=(a,b)=>a&&b&&a.ino===b.ino&&a.dev===b.dev&&a.text===b.text;
function dead(record){
 if(!record)return false;let pid;try{const value=JSON.parse(record.text);pid=typeof value==='number'?value:value?.pid;}catch{pid=Number(record.text);}
 if(!Number.isSafeInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}
}
// Payload is complete before the atomic link. Unknown/legacy empty locks and
// crashed cleanup guards fail closed; age alone never authorizes takeover.
export function processLock(file){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const guard=file+'.reaping',tmp=file+'.'+randomUUID()+'.claim';let owned;
 const release=()=>{if(owned&&same(owned,identity(file)))fs.unlinkSync(file);owned=null;};
 const claim=()=>{try{fs.linkSync(tmp,file);owned=identity(file);return true;}catch(error){if(error.code==='EEXIST')return false;throw error;}};
 fs.writeFileSync(tmp,JSON.stringify({pid:process.pid,nonce:randomUUID()}),{mode:0o600,flag:'wx'});
 try{
  if(fs.existsSync(guard))return null;
  if(claim()){if(fs.existsSync(guard)){release();return null;}return release;}
  const previous=identity(file);if(!dead(previous))return null;
  try{fs.mkdirSync(guard,{mode:0o700});}catch(error){if(error.code==='EEXIST')return null;throw error;}
  try{
   if(!same(previous,identity(file))||!dead(previous))return null;
   fs.unlinkSync(file);if(!claim())return null;return release;
  }finally{fs.rmdirSync(guard);}
 }finally{fs.unlinkSync(tmp);}
}
