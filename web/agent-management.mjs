import fs from 'node:fs';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {withRosterState} from '../direct.mjs';
import {roster,saveRoster,coordinatorProfile,missingTerminal} from '../team-runtime.mjs';
const read=(p,f=null)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e.code==='ENOENT')return f;throw e;}};
const write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});const tmp=p+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v),{mode:0o600});fs.renameSync(tmp,p);};
const base=c=>c.teamBase||path.join(c.cwd,'.herdr-team');
export function managementActive(c){
 const file=path.join(base(c),'agent-management.lock');if(!fs.existsSync(file))return false;const pid=Number(fs.readFileSync(file,'utf8'));if(!Number.isInteger(pid)||pid<=0)return true;try{process.kill(pid,0);return true;}catch(e){if(e.code!=='ESRCH')return true;const delivery=path.join(base(c),'chat-delivery.lock');if(fs.existsSync(delivery)&&fs.readFileSync(delivery,'utf8')===String(pid))fs.unlinkSync(delivery);fs.unlinkSync(file);return false;}
}
export const rosterRevision=c=>createHash('sha256').update(JSON.stringify(roster(c))).digest('hex');
export const sidebarIds=(c,workspace)=>[...(!workspace&&!coordinatorProfile(c).agentId?['__coordinator__']:[]),...roster(c).map(a=>a.id)];
export function sidebarState(c,workspace){managementActive(c);const ids=sidebarIds(c,workspace),s=read(path.join(base(c),'sidebar.json'),{});return{revision:s.revision||0,order:[...(s.order||[]).filter(id=>ids.includes(id)),...ids.filter(id=>!(s.order||[]).includes(id))],pinned:(s.pinned||[]).filter(id=>ids.includes(id))};}
export function updateSidebar(c,workspace,data){const old=sidebarState(c,workspace),ids=sidebarIds(c,workspace);if(data.revision!==old.revision)throw Object.assign(Error('排序已在另一個畫面更新，請重新整理後再試。'),{status:409});for(const key of ['order','pinned'])if(!Array.isArray(data[key])||new Set(data[key]).size!==data[key].length||data[key].some(id=>!ids.includes(id)))throw Error('代理排序或置頂設定無效。');if(data.order.length!==ids.length)throw Error('排序必須保留所有代理。');const next={revision:old.revision+1,order:data.order,pinned:data.pinned};write(path.join(base(c),'sidebar.json'),next);return next;}
function contexts(c){const dir=path.join(base(c),'conversations');return[{...c,teamDir:base(c),chat:null},...(fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>({...c,teamDir:path.join(dir,d.name),chat:d.name})):[])];}
export async function manageAgent(options){
 if(managementActive(options.source))throw Object.assign(Error('Another role change is still running.'),{status:409});const lock=path.join(base(options.source),'chat-delivery.lock');fs.mkdirSync(path.dirname(lock),{recursive:true,mode:0o700});let fd;try{fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));}catch(e){if(e.code==='EEXIST')throw Object.assign(Error('代理訊息正在送達，請稍後再試。'),{status:409});throw e;}let marker;const markerPath=path.join(base(options.source),'agent-management.lock');try{marker=fs.openSync(markerPath,'wx',0o600);fs.writeFileSync(marker,String(process.pid));return await manageUnlocked(options);}finally{if(marker!==undefined){fs.closeSync(marker);fs.unlinkSync(markerPath);}fs.closeSync(fd);fs.unlinkSync(lock);}
}
async function manageUnlocked({source,target,sourceWorkspace,targetWorkspace,agentId,expectedRevision,core}){
 if(agentId==='starter'||agentId==='__coordinator__')throw Error('預設領頭羊留在本專案，不能刪除或轉移。');
 if(coordinatorProfile(source).agentId===agentId)throw Error('請先任命其他協調者，再移除或轉移目前協調者。');
 if(target&&target.cwd===source.cwd)throw Error('請選擇另一個專案。');
 const agent=roster(source).find(a=>a.id===agentId);if(!agent)throw Error('找不到這位代理。');if(expectedRevision!==rosterRevision(source))throw Object.assign(Error('代理設定已更新，請重新整理後再試。'),{status:409});
 if(target&&(roster(target).some(a=>a.id===agentId)||roster(target).length>=24))throw Error('目的專案已有相同代理，或成員數已達上限。');
 const sessions=[];
 for(const c of contexts(source)){
  if(Object.values(read(path.join(c.teamDir,'skill-requests.json'),{})).some(r=>r.agentId===agentId&&r.status==='pending'))throw Error('這位代理仍有待確認的 Skill 安裝請求，請先同意或拒絕。');
  if((read(path.join(c.teamDir,'checklist.json'),{}).items||[]).some(item=>item.status!=='done'&&[agentId,agent.name].includes(item.owner)))throw Error('這位代理仍有未驗收待辦，請先完成工作。');
  for(const dirName of ['direct-queue','chat-queue']){const dir=path.join(c.teamDir,dirName);if(fs.existsSync(dir)&&fs.readdirSync(dir).filter(n=>n.endsWith('.json')).some(n=>{const q=read(path.join(dir,n),{});return q.agentId===agentId||q.target===agentId;}))throw Error('這位代理還有排隊訊息，請先完成工作。');}
  if(Object.values(read(path.join(c.teamDir,'collaborations.json'),{})).some(j=>!['done','failed'].includes(j.status)&&(j.sourceAgent===agentId||j.targetAgent===agentId)))throw Error('這位代理仍有未完成協作，請先驗收或完成工作。');
  for(const [file,direct]of [['direct-bindings.json',true],['worker-bindings.json',false]])for(const [id,b]of Object.entries(read(path.join(c.teamDir,file),{}))){if(b.retired||(direct&&b.agentId!==agentId))continue;if(direct&&(b.awaitingReply||b.activeJob))throw Error('仍在等待回覆或協作驗收，請完成後再試。');let t;try{t=await core(['get',id]);}catch(e){if(missingTerminal(e))continue;throw Error('無法核對代理終端，暫不變更角色。');}if(!direct&&t.labels?.['team.agent']!==agentId)continue;if(t.cwd!==source.cwd||t.labels?.['team.agent']!==agentId||(direct?(t.parent||t.labels?.['team.direct']!=='true'||t.labels?.['team.chat']!==(c.chat||'legacy')):(t.parent!==b.owner||t.labels?.['team.owner']!==b.owner)))throw Error('代理終端歸屬不符，停止變更。');if(t.state==='live'){if(!['idle','done'].includes(t.status?.state))throw Error('代理仍在執行或等待確認，請先完成工作。');sessions.push(id);}}
 }
 // Stop only verified idle sessions; never answer a permission prompt or kill work.
 for(const id of [...new Set(sessions)]){await core(['kill',id]);try{const t=await core(['get',id]);if(t.state==='live')throw Error('閒置會話尚未停止，未變更角色。');}catch(e){if(!missingTerminal(e))throw e;}}
 const finish=()=>{
 if(expectedRevision!==rosterRevision(source))throw Object.assign(Error('代理設定已更新，未移動任何設定。'),{status:409});
 if(target&&(roster(target).some(a=>a.id===agentId)||roster(target).length>=24))throw Error('目的專案已有相同代理，或成員數已達上限。');
 const paths=[path.join(base(source),'roster.json'),path.join(base(source),'coordinator.json'),path.join(base(source),'sidebar.json'),...(target?[path.join(base(target),'roster.json'),path.join(base(target),'coordinator.json'),path.join(base(target),'sidebar.json')]:[])];
 const snapshot=paths.map(file=>({file,content:fs.existsSync(file)?fs.readFileSync(file,'utf8'):null})),backup=path.join(base(source),'management-backups',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));fs.mkdirSync(backup,{recursive:true,mode:0o700});write(path.join(backup,'before.json'),{agentId,target:target?.cwd||null,files:snapshot});
 const from=sidebarState(source,sourceWorkspace),to=target?sidebarState(target,targetWorkspace):null;
 try{
  if(target)saveRoster(target,[...roster(target),agent]);saveRoster(source,roster(source).filter(a=>a.id!==agentId));
  write(path.join(base(source),'sidebar.json'),{revision:from.revision+1,order:from.order.filter(id=>id!==agentId),pinned:from.pinned.filter(id=>id!==agentId)});
  if(target)write(path.join(base(target),'sidebar.json'),{revision:to.revision+1,order:[...to.order,agentId],pinned:from.pinned.includes(agentId)?[...to.pinned,agentId]:to.pinned});
 }catch(error){for(const s of snapshot){if(s.content===null)fs.rmSync(s.file,{force:true});else{fs.mkdirSync(path.dirname(s.file),{recursive:true});fs.writeFileSync(s.file,s.content,{mode:0o600});}}throw error;}
 return{saved:true,moved:!!target,agentId,stoppedIdleSessions:sessions.length,historyPreserved:true};
 };
 return withRosterState(source,()=>target?withRosterState(target,finish):finish());
}
