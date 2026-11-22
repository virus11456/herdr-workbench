import fs from 'node:fs';import path from 'node:path';
import {terminalProvider} from './agent-models.mjs';
const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const terminalId=id=>/^t[a-z0-9]+$/.test(id||'');
export function workerCandidates(project,context){
 const scopes=[context(project.folder),...project.chats.filter(c=>c.id!=='legacy').map(c=>context(project.folder,c.id))],seen=new Set(),rows=[];
 for(const scope of scopes){
  const control=read(path.join(scope.teamDir,'control.json'),{}),owners=[control.terminal,control.previousTerminal].filter(terminalId);
  for(const [address,binding]of Object.entries(read(path.join(scope.teamDir,'worker-bindings.json'),{}))){
   if(!terminalId(address)||seen.has(address)||!owners.includes(binding.owner)||binding.chat!==(scope.chat||'legacy'))continue;
   seen.add(address);rows.push({address,binding,scope});
  }
 }
 return rows;
}
// A display projection of verified existing Core workers. It cannot create, send to, rename, or promote an agent.
export function workerView(candidate,terminal,events=[]){
 const {address,binding,scope}=candidate,provider=terminalProvider(terminal);
 if(binding.agentId||!provider||terminal.address!==address||terminal.cwd!==scope.cwd||terminal.parent!==binding.owner||terminal.labels?.['team.owner']!==binding.owner||terminal.labels?.['team.chat']!==binding.chat||terminal.labels?.['team.agent']||terminal.state!=='live')return null;
 const reports=events.filter(e=>e.terminal===address&&e.kind==='worker-report'),report=reports.at(-1),named=reports.findLast(e=>typeof e.role==='string'&&!['Codex','Claude','MiniMax','Antigravity','代理','系統'].includes(e.role));
 const name=named?.role||binding.displayName||terminal.name||binding.name||'工作代理';
 return {terminal:address,name:String(name).slice(0,80),provider,chat:binding.chat,state:terminal.state,status:terminal.status,lastReport:typeof report?.text==='string'?report.text.slice(0,6000):null,reportTime:report?.time||null,temporary:true};
}
export function createWorkerObserver(core,events){
 let cacheKey=null,expires=0,pending;
 return async plans=>{
  const key=JSON.stringify(plans.map(p=>[p.id,p.candidates.map(c=>[c.address,c.binding.owner,c.binding.chat])]));
  if(key!==cacheKey||Date.now()>=expires){
   cacheKey=key;expires=Date.now()+2000;
   pending=(async()=>{
    let list;try{const result=await core(['ls','--json']);list=Array.isArray(result)?result:result.terminals||[];}catch{return new Map();}
    const listed=new Set(list.map(t=>t.address||t.id||t.terminal));
    const ids=[...new Set(plans.flatMap(p=>p.candidates.map(c=>c.address)).filter(id=>listed.has(id)))];
    return new Map(await Promise.all(ids.map(async id=>{try{return[id,await core(['get',id])];}catch{return[id,null];}})));
   })();
  }
  const terminals=await pending;
  return plans.map(p=>({id:p.id,workers:p.candidates.flatMap(c=>{const view=workerView(c,terminals.get(c.address),events(c.scope));return view?[view]:[];})}));
 };
}
