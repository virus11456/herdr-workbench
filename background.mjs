import {fileURLToPath} from 'node:url';
import fs from 'node:fs';import path from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
import {context,drainProject} from './team-runtime.mjs';
const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
export function serviceProjects(config){
 const all=read(path.join(config.appHome,'web/projects.json'),[]);
 const unique=new Map();for(const p of all){if(typeof p.folder!=='string'||!Array.isArray(p.chats))continue;let folder=path.resolve(p.folder);try{folder=fs.realpathSync(folder);}catch{}unique.set(folder,{...p,folder});}return [...unique.values()];
}
export function tick(config,run){
 const projects=serviceProjects(config),results=[];
 for(const p of projects){try{const c=context(p.folder,null,run,null,config);results.push({folder:p.folder,ok:true,conversations:drainProject(c)});}catch(e){results.push({folder:p.folder,ok:false,error:String(e.message).slice(0,500)});}}
 return results;
}
export async function serveQueue(config){
 const file=path.join(config.appHome,'service-status.json');let stopped=false;
 process.once('SIGTERM',()=>{stopped=true;});process.once('SIGINT',()=>{stopped=true;});
 while(!stopped){
  let results;try{results=tick(config);}catch(e){results=[{ok:false,error:String(e.message).slice(0,500)}];}
  const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify({pid:process.pid,time:Date.now(),results}),{mode:0o600});fs.renameSync(tmp,file);
  await delay(1500);
 }
 fs.writeFileSync(file,JSON.stringify({pid:process.pid,time:Date.now(),stopped:true}),{mode:0o600});
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const home=process.env.HERDR_WORKBENCH_HOME;if(!home)throw Error('HERDR_WORKBENCH_HOME is required.');
 await serveQueue(read(path.join(home,'service.json'),null));
}
