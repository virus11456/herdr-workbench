import {checklist,updateChecklist} from './checklist.mjs';
import {drainDirect,directReply,drainCollaboration,directTerminal} from './direct.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const recoverable = new Set(['rate_limit', 'server_error', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error', 'model_not_found', 'cloud_credential_error']);
export const claudeModels = {'claude-opus-5-5':'Opus 5.5', 'claude-fable-5-2':'Fable 5.2'};
export const defaultRoster = () => [];
export function coordinatorProfile(c) {return read(path.join(c.teamBase || path.join(c.cwd,'.herdr-team'),'coordinator.json')) || {name:'領頭羊'};}
export function missingTerminal(error) {
 try{return (error?.error?.kind||JSON.parse(String(error?.stdout||error?.stderr||'{}')).error?.kind)==='not_found';}catch{return false;}
}
export function setCoordinatorName(c,name) {
 if(typeof name!=='string'||!name.trim()||name.trim().length>40||/[\x00-\x1f\x7f]/.test(name))throw Error('名稱需為 1–40 字，且不得包含控制字元。');
 const profile={...coordinatorProfile(c),name:name.trim()};save(path.join(c.teamBase || path.join(c.cwd,'.herdr-team'),'coordinator.json'),profile);return profile;
}
export function appointAgent(c,agentId){
 const agent=roster(c).find(a=>a.id===agentId);if(!agent)throw Error('請選擇這個專案已加入的代理。');
 saveRoster(c,roster(c).map(a=>a.id===agentId?{...a,provider:'claude',model:'claude-opus-5-5',level:'manager'}:a));
 const profile={...coordinatorProfile(c),agentId:agent.id,name:agent.name,managerModel:'claude-opus-5-5'};save(path.join(c.teamBase||path.join(c.cwd,'.herdr-team'),'coordinator.json'),profile);return{...profile,started:false,providerChanged:agent.provider!=='claude'};
}
const workerTemplates = {claude:'herdr-claude-task',codex:'herdr-codex-implement',minimax:'herdr-minimax-cn',antigravity:'herdr-antigravity-task'};
export function validateRoster(value) {
  if (!Array.isArray(value) || value.length > 24) throw new Error('團隊最多可設定 24 位代理。');
  const ids = new Set();
  return value.map(a => {
    if (!a || !/^[a-z][a-z0-9-]{0,31}$/.test(a.id || '') || [...Object.keys(workerTemplates),'team'].includes(a.id) || ids.has(a.id)) throw new Error('代理識別碼必須唯一，且不能使用供應商名稱。');
    ids.add(a.id);
    if (!Object.hasOwn(workerTemplates,a.provider) || !['manager','worker'].includes(a.level)) throw new Error('代理引擎或職責無效。');
    const out={id:a.id,provider:a.provider,level:a.level};
    if(a.model!==undefined){if(a.provider!=='claude'||!Object.hasOwn(claudeModels,a.model))throw Error('此代理模型選擇無效。');out.model=a.model;}
    for (const [key,max] of [['name',40],['group',40],['brief',1000]]) {
      if (typeof (a[key] ?? '') !== 'string' || (key==='name' && !a[key]?.trim()) || (a[key] || '').length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(a[key] || '')) throw new Error('請填寫有效的代理名稱、分組與職責。');
      out[key]=(a[key] || '').trim();
    }
    return out;
  });
}
export function roster(c) { return validateRoster(read(path.join(c.teamBase || path.join(c.cwd,'.herdr-team'),'roster.json')) ?? read(path.join(teamDir(c),'roster.json')) ?? defaultRoster()); }
export function saveRoster(c,value) {
  const agents=validateRoster(value);if(roster(c).some(a=>a.id==='starter')&&!agents.some(a=>a.id==='starter'))throw Error('預設領頭羊不能刪除；可以改名、設定模型或另外任命協調者。');save(path.join(c.teamBase || path.join(c.cwd,'.herdr-team'),'roster.json'),agents);
  const profile=coordinatorProfile(c);if(profile.agentId){const selected=agents.find(a=>a.id===profile.agentId);save(path.join(c.teamBase||path.join(c.cwd,'.herdr-team'),'coordinator.json'),{...profile,agentId:selected?.id||null,...(selected?{name:selected.name}:{})});}
  return {agents,saved:true,started:false};
}
export function teamBrief(c) {
  return '專案協作：由使用者指定目標、代理與分工，不預設部門、工作順序或引擎職責。專案代理名冊（設定角色不代表已啟動）：\n'+JSON.stringify(roster(c))+'\n'+
    '你是這段對話的協調入口，不是整個工作台唯一的中介。使用者可直接和每位代理聊天；已加入的代理可依使用者授權，透過工作台在彼此對話交付協作、收取真實回報、退回修正並驗收。不能宣稱所有訊息或代理協作都必須經過你。只處理交付給你的任務，不強制規劃→開發→審查。'+
    '以下 report／request 規則只適用你從本終端派出的舊版 worker，並不限制其他代理的直接對話。舊版工作代理可用 herdr-team-runtime report <總控ID> <角色> <協作請求與依據> 向自己的派工者回報，派工者必須接收並回覆處理結果；所有模式都不得繞過使用者權限或沙箱。'+
    '啟動 worker 後核對 first_message.sent，若為 false 則交給使用者處理登入或權限、確認狀態後才補送，不得假稱已收到任務。名冊代理派工使用 runtime request run 的 agentId 欄位，以綁定角色、引擎、回報與側欄狀態；保存同一請求 ID 並讀取 response 的 ok/result，queued 不是成功。'+
    '多步或多代理任務先用 herdr-team-runtime checklist 讀共用清單，再用 request checklist 更新並讀取同 ID response。每項記錄 id/title/owner/status/acceptance/revision；驗收後才標記 done，附 verification 與 evidence（檔案相對路徑及 SHA-256，或同 ID 成功 read response.result 的 JSON SHA-256）。不要以 queued 或代理自稱完成作為驗收。清單依對話保存，接手先續讀，不刪掉未完成項。'+
    '派工時清楚提供任務、工作範圍、產物、驗收、總控回報命令及不得自行啟動其他代理。多位寫入者必須使用獨立 worktree，否則依序寫入。不得自動付費、答覆信任或權限提示。';
}
export function routeMessage(text, agents = []) {
  const original = String(text).trim();
  const custom=original.match(/^@([a-z][a-z0-9-]{0,31})(?=\s|[：:，,]|$)[\s：:，,]*/i);
  const agent=custom && agents.find(a=>a.id===custom[1].toLowerCase());
  if(agent) {
    const task=original.slice(custom[0].length).trim();
    if(!task)throw new Error('請在代理名稱後輸入任務。');
    return {target:agent.id,text:`[Herdr 路由：指定名冊代理 ${agent.name}（${agent.id}），引擎 ${agent.provider}。總控以 request run 的 agentId=${agent.id} 派工並等待實際回報。職責：${agent.brief}]\n${task}`};
  }
  const match = original.match(/^@(claude|codex|minimax|antigravity)(?=\s|[：:，,]|$)[\s：:，,]*/i);
  if(custom && !match)throw new Error('找不到這位代理，請先在團隊設定新增。');
  if (!match) return {target:'team', text:original};
  const target = match[1].toLowerCase(), task = original.slice(match[0].length).trim();
  if (!task) throw new Error('請在 @代理名稱 後輸入要處理的內容。');
  const role = workerTemplates[target];
  return {target, text:`[Herdr 路由：指定 ${target}；單一代理任務。若目前總控就是指定代理，直接處理；否則透過 ${role} 派工並等待真實回報。不能以自己的答案代替。]\n${task}`};
}
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const validChat = id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
const teamDir = c => c.teamDir || path.join(c.cwd, '.herdr-team');
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function selectedModel(c) {
  if(c.terminal)try{const id=c.run('hc',['get',c.terminal]).labels?.['team.agent'],agent=roster(c).find(a=>a.id===id);if(agent?.model)return agent.model;}catch{}
  const value = read(path.join(teamDir(c), 'model.json'));
  return claudeModels[value?.model] ? value.model : 'claude-opus-5-5';
}
export async function switchAgentModel(c,agentId,model,pause=delay){
 if(!Object.hasOwn(claudeModels,model))throw Error('只能選擇 Opus 5.5 或 Fable 5.2。');
 const agents=roster(c),agent=agents.find(a=>a.id===agentId);if(!agent||agent.provider!=='claude')throw Error('只能為 Claude 代理選擇此模型。');
 const bindings=read(path.join(teamDir(c),'direct-bindings.json'))||{};let terminal;
 for(const [id,b]of Object.entries(bindings))if(b.agentId===agentId){const t=c.run('hc',['get',id]);if(t.state==='live'&&t.cwd===c.cwd&&!t.parent&&t.labels?.['team.direct']==='true'&&t.labels?.['team.agent']===agentId&&t.labels?.['team.chat']===(c.chat||'legacy'))terminal=t;}
 if(!terminal){saveRoster(c,agents.map(a=>a.id===agentId?{...a,model}:a));return{model,applied:false,message:'已保存，下一次開啟這位代理時使用 '+claudeModels[model]+'。'};}
 if(!['idle','done'].includes(terminal.status?.state)||!['claude','claude-code'].includes(terminal.status?.app))throw Error('代理尚未待命，請先處理登入、信任或目前工作。');
 c.run('hc',['send',terminal.address,`/model ${model}`]);let confirmed=false;
 for(let i=0;i<32;i++){
  await pause(250);const screen=c.run('hc',['read',terminal.address,'--json','--lines','0']).text||'',at=screen.lastIndexOf(`/model ${model}`);if(at<0)continue;const current=screen.slice(at+`/model ${model}`.length);
  if(current.includes('Set model to '+claudeModels[model])){saveRoster(c,agents.map(a=>a.id===agentId?{...a,model}:a));const file=path.join(teamDir(c),'agent-models.json');save(file,{...(read(file)||{}),[agentId]:{model,terminal:terminal.address,confirmedAt:new Date().toISOString()}});return{model,applied:true,message:'已確認切換為 '+claudeModels[model]+'。'};}
  if(!confirmed&&current.includes('Switch model?')&&current.includes(`❯ 1. Yes, switch to ${claudeModels[model]}`)&&/2\. No, go back\s*$/.test(current)){c.run('hc',['keys',terminal.address,'enter']);confirmed=true;}
 }
 throw Error('CLI 尚未確認模型切換成功，請查看主機終端；未標記套用成功。');
}
export async function switchModel(c, model, pause = delay) {
  if (!Object.hasOwn(claudeModels, model)) throw new Error('只能選擇 Opus 5.5 或 Fable 5.2。');
  const file = path.join(teamDir(c), 'model.json');
  const control = read(path.join(teamDir(c), 'control.json'));
  const label = claudeModels[model];
  if (control?.role !== 'claude' || !control.terminal) {
    save(file, {model, scope:'next_claude_session'});
    return {model, applied:false, message:`下次啟動 Claude 將使用 ${label}。`};
  }
  const id = control.terminal, t = c.run('hc', ['get', id]);
  if (t.state !== 'live' || !['claude-code','claude'].includes(t.status?.app)) throw new Error('Claude 尚未就緒，請先開啟總控。');
  if (!['idle','done'].includes(t.status?.state)) throw new Error(t.status?.state === 'blocked' ? 'Claude 正等待確認，請先處理提示，再切換模型。' : 'Claude 正在處理任務，請等這一回合結束再切換模型。');
  c.run('hc', ['send', id, `/model ${model}`]);
  let confirmed = false;
  for (let attempt=0; attempt<32; attempt++) {
    await pause(250);
    const screen = c.run('hc', ['read', id, '--json', '--lines', '0']).text || '';
    const marker = `/model ${model}`, at = screen.lastIndexOf(marker);
    if (at < 0) continue;
    const current = screen.slice(at + marker.length);
    if (current.includes(`Set model to ${label}`)) {
      save(file, {model, terminal:id, confirmedAt:new Date().toISOString()});
      log(c, '系統', `Claude 模型已切換為 ${label}。`, 'model');
      return {model, applied:true, message:`Claude 已切換為 ${label}。`};
    }
    // Only confirm the exact model-switch prompt requested by this button.
    // Permission, billing and any other dialog must remain for the user.
    if (!confirmed && current.includes('Switch model?') && current.includes(`❯ 1. Yes, switch to ${label}`) && /2\. No, go back\s*$/.test(current)) {
      c.run('hc', ['keys', id, 'enter']);
      confirmed = true;
    }
  }
  throw new Error('尚未收到模型切換成功的確認。請點「查看確認」查看 Claude 提示；目前選擇未標示為成功。');
}
export function context(cwd = process.cwd(), terminal = process.env.HC_TERMINAL_ID, run, chat = process.env.HERDR_TEAM_CHAT_ID || null, options) {
  if (chat && !validChat(chat)) throw new Error('Invalid conversation ID.');
  const root = fs.realpathSync(path.resolve(cwd));
  if(!options)options=process.env.HERDR_WORKBENCH_HOME ? read(path.join(process.env.HERDR_WORKBENCH_HOME,'service.json')) || {} : {};
  if(options.legacyProjects?.includes(root))options={...options,stateRoot:null};
  const teamBase=options.stateRoot ? path.join(options.stateRoot,createHash('sha256').update(root).digest('hex').slice(0,32)) : path.join(root,'.herdr-team');
  return {cwd:root,chat,headless:!!options.headless,teamBase,teamDir:path.join(teamBase,...(chat?['conversations',chat]:[])),terminal,
    run:run||((cmd,args)=>JSON.parse(execFileSync(path.join(os.homedir(),'.local/bin',cmd),args,{cwd:root,encoding:'utf8',timeout:75000,maxBuffer:1024*1024})))};
}
function coreLaunch(c,argv) {
 const made=c.run('hc',['run','--bg','--no-parent','--keep','--cwd',c.cwd,...argv]);
 const terminal=made.terminal||made.address;
 if(!/^t[a-z0-9]+$/.test(terminal||''))throw Error('Core did not return a real local terminal.');
 return {...made,terminal};
}

function paths(c) {
  const dir = teamDir(c);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, control: path.join(dir, 'control.json'), lock: path.join(dir, 'takeover.lock'), messages: path.join(dir, 'messages.jsonl') };
}
export function log(c, role, text, kind = role === '你' ? 'user' : 'progress', extra = {}) {
  if (!String(text).trim()) return;
  const p = paths(c);
  fs.appendFileSync(p.messages, JSON.stringify({ ...extra, time: new Date().toISOString(), terminal: c.terminal || null, role: String(role).slice(0, 40), kind, text: String(text).slice(0, 12000) }) + '\n', { mode: 0o600 });
}
export function enqueueChat(c, text, id=randomUUID()) {
  const original=String(text).trim(), routed=routeMessage(original,roster(c));
  if (!original) throw new Error('請先輸入訊息。');
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid message ID.');
  const dir=path.join(paths(c).dir,'chat-queue');
  for(const suffix of ['.json.cancelled','.json','.json.sent']){
    const existing=read(path.join(dir,id+suffix));
    if(existing){if(existing.original!==original)throw Error('訊息 ID 已被其他內容使用。');return{id,queued:suffix!=='.json.cancelled',target:existing.target,...(suffix==='.json.cancelled'?{status:'cancelled'}:{})};}
  }
  save(path.join(dir,`${id}.json`),{id,original,...routed,createdAt:new Date().toISOString(),sequence:process.hrtime.bigint().toString().padStart(24,'0')});
  log(c,'你',original,'user',{messageId:id,delivery:'queued',target:routed.target});
  return {id,queued:true,target:routed.target};
}
function conversationContexts(c) {
  const root=c.teamBase || path.join(c.cwd,'.herdr-team'), list=[{...c,chat:null,teamDir:root}];
  const dir=path.join(root,'conversations');
  if(fs.existsSync(dir)) for(const d of fs.readdirSync(dir,{withFileTypes:true})) if(d.isDirectory()&&validChat(d.name)) list.push({...c,chat:d.name,teamDir:path.join(dir,d.name)});
  return list;
}
export async function retryStartup(c) {
  const file=path.join(teamDir(c),'control.json'),control=read(file);
  if(!control?.terminal)throw Error('No previous coordinator to reopen.');
  let terminal;try{terminal=await c.run('hc',['get',control.terminal]);}catch(error){if(!missingTerminal(error))throw error;}
  if(terminal&&(terminal.state!=='finished'||terminal.status?.app))throw Error('總控仍在執行或已進入工作階段，請先親自查看原終端。');
  const current=read(file);
  if(current?.terminal!==control.terminal)throw Error('總控已變更，請重新整理。');
  save(file,{...current,phase:'retry_requested'});
  return {queued:true,restarted:false};
}
export function drainChats(c) {
  const dir=path.join(teamDir(c),'chat-queue');
  if(!fs.existsSync(dir)) return {sent:0,pending:0};
  const lock=path.join(c.teamBase || path.join(c.cwd,'.herdr-team'),'chat-delivery.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')return{sent:0};throw e;}
  try {
    const files=fs.readdirSync(dir).filter(n=>/^[a-f0-9-]+\.json$/.test(n)).map(n=>({name:n,msg:read(path.join(dir,n))})).sort((a,b)=>(a.msg.sequence||a.msg.createdAt).localeCompare(b.msg.sequence||b.msg.createdAt)||a.name.localeCompare(b.name));
    if(!files.length)return{sent:0,pending:0};
    // A project shares files: do not start another conversation while one is busy.
    for(const other of conversationContexts(c)) {
      if(teamDir(other)===teamDir(c)) continue;
      const owner=read(path.join(teamDir(other),'control.json'));
      if(!owner?.terminal)continue;
      let t;try{t=c.run('hc',['get',owner.terminal]);}catch{continue;}
      if(t.state==='live' && ['working','blocked'].includes(t.status?.state))return{sent:0,pending:files.length,reason:'another_conversation_busy',blockingChat:other.chat,blockedTerminal:owner.terminal};
    }
    let control=read(path.join(teamDir(c),'control.json')), t=null;
    if(control?.terminal) {
      try{t=c.run('hc',['get',control.terminal]);}catch(error){if(!missingTerminal(error)||control.phase!=='retry_requested')return{sent:0,pending:files.length,reason:'coordinator_unavailable'};}
    }
    const foreground=t?.foreground?.argv || [];
    const shellWithoutAgent=foreground.length && /(?:^|\/)(?:zsh|bash|sh|fish|nu|pwsh)$/.test(foreground[0]) && !t?.status?.app;
    // Leaving a startup/trust dialog is not permission to repeatedly reopen it.
    if(t?.state==='finished'&&!t.status?.app&&control?.phase!=='retry_requested')return{sent:0,pending:files.length,reason:'startup_stopped',blockedTerminal:control.terminal};
    if(!t || t.state==='finished' || (shellWithoutAgent && Date.now()-(control.startedAt||0)>60000)) {
      const argv=[path.join(os.homedir(),'.local/bin/herdr-team-lead')];
      if(c.chat)argv.push('--team-chat',c.chat);
      if(control?.role==='claude' && /^[a-f0-9-]{36}$/.test(control.sessionId||''))argv.push('--resume',control.sessionId);
      const made=c.headless ? coreLaunch(c,argv) : c.run('herdr-app',['do','space.new',JSON.stringify({name:path.basename(c.cwd),tab:'Claude · 對話總控',folder:c.cwd,argv,focus:false})]);
      if(!made.terminal)throw new Error('Herdr 沒有回傳總控。');
      const current=read(path.join(teamDir(c),'control.json'));
      if(current?.terminal!==made.terminal)save(path.join(teamDir(c),'control.json'),{...control,terminal:made.terminal,role:'claude',phase:'starting',startedAt:Date.now()});
      return{sent:0,pending:files.length,reason:'starting'};
    }
    if(!['claude-code','claude','codex'].includes(t.status?.app) || !['idle','done'].includes(t.status?.state))return{sent:0,pending:files.length,reason:t.status?.state||'starting'};
    // Avoid delivering a second queued message before the core reports the new turn.
    const leaseFile=path.join(c.teamBase || path.join(c.cwd,'.herdr-team'),'chat-delivery.json'),lease=read(leaseFile);
    if(lease && Date.now()-lease.time<2500)return{sent:0,pending:files.length,reason:'awaiting_turn'};
    const {name,msg}=files[0];
    try {
      const routed=routeMessage(msg.original,roster(c));
      if(routed.target!==msg.target)throw Error('Queued recipient changed; refusing to redirect.');
      save(leaseFile,{terminal:control.terminal,time:Date.now(),messageId:msg.id,chat:c.chat});
      c.run('hc',['send',control.terminal,teamBrief(c)+'\n\n'+routed.text]);
      fs.renameSync(path.join(dir,name),path.join(dir,name+'.sent'));
      log(c,'系統','訊息已送到總控。','delivery',{messageId:msg.id,delivery:'sent'});
      return{sent:1,pending:files.length-1};
    } catch {
      return{sent:0,pending:files.length,reason:'delivery_paused'};
    }
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function drainProject(c) {
  return conversationContexts(c).filter(x=>fs.existsSync(teamDir(x))).map(x=>({chat:x.chat,...drain(x),directQueue:drainDirect(x),collaborationQueue:drainCollaboration(x),chatQueue:drainChats(x)}));
}
export function captureReply(event, c, role) {
  const isClaude = role === 'Claude' && event.hook_event_name === 'Stop';
  const isCodex = ['Codex','Antigravity','MiniMax'].includes(role) && event.type === 'agent-turn-complete';
  if (!isClaude && !isCodex) return {captured: false};
  if(role==='Codex'&&titleMetadata(event['last-assistant-message']))return{captured:false,reason:'session_title_metadata'};
  let observedModel=event.modelName||event.model;
  if(role==='Codex'&&!observedModel&&directTerminal(c,c.terminal))try{const screen=c.run('hc',['read',c.terminal,'--json','--lines','0']).text||'';observedModel=screen.split('\n').slice(-8).flatMap(line=>{const match=line.match(/^\s*(GPT-[A-Za-z0-9.-]+)\s+(?:low|medium|high|xhigh|max)\s*[·|]/);return match?[match[1]]:[];}).at(-1);}catch{}
  const direct=directReply(c,isClaude?event.last_assistant_message:event['last-assistant-message'],String(event['turn-id']||event.session_id||''),observedModel);
  if(direct.captured||direct.reason)return direct;
  const control = read(path.join(teamDir(c), 'control.json'));
  if (control?.terminal && control.terminal !== c.terminal) return captureWorkerReply(event,c,role,control);
  const text = isClaude ? event.last_assistant_message : event['last-assistant-message'];
  if (typeof text !== 'string' || !text.trim()) return {captured:false};
  if(isClaude && control && /^[a-f0-9-]{36}$/.test(event.session_id||'')) save(path.join(teamDir(c),'control.json'),{...control,sessionId:event.session_id});
  log(c, role, text, 'reply');
  return {captured:true};
}
function titleMetadata(text) {
 try {const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&typeof value.title==='string';}catch{return false;}
}
function captureWorkerReply(event,c,role,control) {
 if(!['Codex','Antigravity','MiniMax'].includes(role)||event.type!=='agent-turn-complete'||!c.terminal)return{captured:false,reason:'not_active_coordinator'};
 const file=path.join(teamDir(c),'worker-bindings.json'),bindings=read(file)||{},binding=bindings[c.terminal];
 if(!binding||binding.owner!==control.terminal||binding.chat!==(c.chat||'legacy'))return{captured:false,reason:'unregistered_worker'};
 const worker=c.run('hc',['get',c.terminal]);
 if(worker.parent!==control.terminal||worker.labels?.['team.owner']!==control.terminal||worker.labels?.['team.chat']!==(c.chat||'legacy'))return{captured:false,reason:'foreign_worker'};
 const text=event['last-assistant-message'];if(typeof text!=='string'||!text.trim())return{captured:false};
 if(titleMetadata(text))return{captured:false,reason:'session_title_metadata'};
 const hash=createHash('sha256').update(String(event['turn-id']??worker.turn??'')+'\n'+text).digest('hex');
 if(binding.captureHash===hash)return{captured:false,reason:'duplicate'};
 let explicit=false;
 try{explicit=fs.readFileSync(path.join(teamDir(c),'messages.jsonl'),'utf8').trim().split('\n').slice(-200).some(line=>{const e=JSON.parse(line);return e.terminal===c.terminal&&e.kind==='worker-report'&&!['codex-notify','antigravity-stop','minimax-stop'].includes(e.via)&&!titleMetadata(e.text)&&Date.parse(e.time)>=binding.sentAt;});}catch{}
 if(explicit){binding.captureHash=hash;save(file,bindings);return{captured:false,reason:'explicit_report_already_sent'};}
 const result=report(c,control.terminal,binding.name||role,text,{via:{Codex:'codex-notify',Antigravity:'antigravity-stop',MiniMax:'minimax-stop'}[role]});binding.captureHash=hash;save(file,bindings);return {captured:true,...result};
}
export function report(c, target, role, text, metadata={}) {
  if (!/^t[a-z0-9]+$/.test(target || '')) throw new Error('A local coordinator terminal ID is required.');
  const p = paths(c), dir = path.join(p.dir, 'outbox');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  save(path.join(dir, `${id}.json`), { id, target, role, text: String(text), from: c.terminal || null });
  log(c, role, text, 'worker-report', {...metadata,reportId:id});
  return { queued: true, id };
}
export function drain(c) {
  const requestsProcessed = drainRequests(c);
  const dir = path.join(teamDir(c), 'outbox');
  if (!fs.existsSync(dir)) return { delivered: 0, errors: [], requestsProcessed };
  let delivered = 0;
  const errors = [];
  for (const name of fs.readdirSync(dir).filter(x => /^[a-f0-9-]+\.json$/.test(x))) {
    const file = path.join(dir, name), pending = file + '.sending';
    try { fs.renameSync(file, pending); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    try {
      const msg = read(pending);
      if (!/^t[a-z0-9]+$/.test(msg.target || '') || typeof msg.text !== 'string') throw new Error('Invalid queued report.');
      const control = read(path.join(teamDir(c), 'control.json'));
      const target = control?.role === 'codex' && msg.target === control.previousTerminal ? control.terminal : msg.target;
      if (!target) throw new Error('Coordinator handover is still in progress.');
      c.run('hc', ['send', target, `[Herdr report ${msg.id}; from ${msg.from || msg.role}${target !== msg.target ? `; forwarded from ${msg.target}` : ''}] ${msg.text}`]);
      fs.renameSync(pending, file + '.sent');
      delivered++;
    } catch (e) {
      fs.renameSync(pending, file);
      errors.push(String(e.message));
    }
  }
  return { delivered, errors, requestsProcessed };
}
export function request(c, action, args) {
  if (!c.terminal) throw new Error('Requests must originate in a Herdr terminal.');
  const p = paths(c), dir = path.join(p.dir, 'requests'), id = randomUUID();
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.mkdirSync(path.join(p.dir, 'responses'), {recursive: true, mode: 0o700});
  save(path.join(dir, `${id}.json`), {id, sender: c.terminal, action, args});
  return {queued: true, id, response: path.join(p.dir, 'responses', `${id}.json`)};
}
export function executeRequest(c, req) {
  const control = read(path.join(teamDir(c), 'control.json'));
  if (!control?.terminal || req.sender !== control.terminal) throw new Error('Only the active coordinator may request operations.');
  const a = req.args || {};
  if(req.action==='checklist'){const result=updateChecklist(c,a,req.sender);const item=result.items.find(i=>i.id===a.id);log(c,'總控',`任務清單：${result.items.filter(i=>i.status==='done').length}/${result.items.length} 已核對完成 · ${item.title} · ${{pending:'待處理',in_progress:'進行中',blocked:'等待處理',done:'已核對完成'}[item.status]}`,'checklist');return result;}
  if (req.action === 'templates') return c.run('hc', ['templates']);
  if (req.action === 'list') {
    const all = c.run('hc', ['ls', '--json']);
    const owners = [control.terminal, control.previousTerminal].filter(Boolean);
    const full=(Array.isArray(all) ? all : all.terminals || []).flatMap(t=>{
      try{return [c.run('hc',['get',t.address||t.id||t.terminal])];}catch{return [];}
    });
    return {terminals:full.filter(t => owners.includes(t.parent) || owners.includes(t.address || t.id || t.terminal))};
  }
  if (req.action === 'run') {
    const agent=a.agentId ? roster(c).find(x=>x.id===a.agentId) : null;
    if(a.agentId && !agent) throw new Error('Unknown team agent.');
    const template=agent ? workerTemplates[agent.provider] : a.template;
    if (!Object.values(workerTemplates).includes(template)) throw new Error('Unknown worker template.');
    if (!/^[a-z0-9_-]{1,32}$/.test(a.name || '') || typeof a.task !== 'string' || !a.task.trim()) throw new Error('A valid worker name and task are required.');
    const root = fs.realpathSync(c.cwd), cwd = fs.realpathSync(path.resolve(c.cwd, a.cwd || '.'));
    if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error('Worker cwd must remain inside this project.');
    const quote=x=>"'"+String(x).replaceAll("'","'\\''")+"'";
    const command=`herdr-team-runtime${c.chat ? ' --chat '+c.chat : ''} report ${control.terminal} ${quote(agent?.name || '代理')} '<摘要>'`;
    const task=(agent ? `你是 ${agent.name}（${agent.id}），${agent.group?`分組：${agent.group}。`:""}職責：${agent.brief}。代理可提出協作、指派建議、追蹤與驗收；以回報命令向總控提出「協作請求：目標代理、任務、驗收條件」，等待總控派工與轉回結果。不得自行啟動其他代理。\n` : '')+
      `本對話回報命令：${command}；交接資料在 ${teamDir(c)}/。\n${a.task}`;
    const labels=['--label',`team.chat=${c.chat || 'legacy'}`,'--label',`team.owner=${control.terminal}`,...(agent?['--label',`team.agent=${agent.id}`]:[])];
    if(agent) {
      const all=c.run('hc',['ls','--json','--label',`team.agent=${agent.id}`,'--label',`team.chat=${c.chat||'legacy'}`]);
      const duplicate=(Array.isArray(all)?all:all.terminals||[]).some(t=>{
        const full=c.run('hc',['get',t.address||t.id||t.terminal]);
        return [control.terminal,control.previousTerminal].filter(Boolean).includes(full.parent) && full.state==='live';
      });
      if(duplicate)throw new Error('This agent already has a live terminal; inspect or send to it instead of starting a duplicate.');
    }
    const made=c.run('hc', ['run', '--bg', '--name', a.name, '--cwd', cwd, '--parent', control.terminal,...labels, template, task]);
    const workerId=made.terminal||made.address;
    if(/^t[a-z0-9]+$/.test(workerId||'')){const file=path.join(teamDir(c),'worker-bindings.json'),bindings=read(file)||{};bindings[workerId]={owner:control.terminal,chat:c.chat||'legacy',name:agent?.name||(template==='herdr-codex-implement'?'Codex':'代理'),sentAt:Date.now()};save(file,bindings);}
    log(c,'總控',`${made.first_message?.sent===false?'代理已開啟，任務尚未送達':'已派工'}${agent ? '給 '+agent.name : ''}：${a.task.slice(0,160)}`,'assignment',{agentId:agent?.id||null,terminal:made.terminal||made.address||null});
    return made;
  }
  if (!['get', 'read', 'wait', 'send', 'interrupt'].includes(req.action)) throw new Error('Unsupported coordinator operation.');
  if (!/^t[a-z0-9]+$/.test(a.terminal || '')) throw new Error('A local worker terminal is required.');
  const terminal = c.run('hc', ['get', a.terminal]);
  const previousRead = a.terminal === control.previousTerminal && ['get', 'read'].includes(req.action);
  if (![control.terminal, control.previousTerminal].filter(Boolean).includes(terminal.parent) && a.terminal !== control.terminal && !previousRead) throw new Error('This terminal does not belong to the current team.');
  if (req.action === 'get') return terminal;
  if (req.action === 'read') return c.run('hc', ['read', a.terminal, '--json', '--lines', String(Math.max(0, Math.min(80, Number(a.lines) || 0)))]);
  if (req.action === 'wait') return c.run('hc', ['wait', a.terminal, '--timeout', '8']);
  if (req.action === 'send') {
    if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('A message is required.');
    const result=c.run('hc', ['send', a.terminal, a.text]);const file=path.join(teamDir(c),'worker-bindings.json'),bindings=read(file)||{};if(bindings[a.terminal]){bindings[a.terminal].sentAt=Date.now();save(file,bindings);}return result;
  }
  return c.run('hc', ['interrupt', a.terminal]);
}
export function drainRequests(c) {
  const dir = path.join(teamDir(c), 'requests');
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(dir).filter(x => /^[a-f0-9-]+\.json$/.test(x))) {
    const file = path.join(dir, name), pending = file + '.running';
    try { fs.renameSync(file, pending); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const req = read(pending);
    let response;
    try { response = {ok: true, result: executeRequest(c, req)}; }
    catch (error) { response = {ok: false, error: String(error.message)}; }
    save(path.join(teamDir(c), 'responses', name), response);
    fs.renameSync(pending, file + '.done');
    count++;
  }
  return count;
}
async function response(c, id) {
  if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Invalid request ID.');
  const dir = path.join(teamDir(c), 'responses'), file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) return read(file);
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(dir, () => { if (fs.existsSync(file)) { clearTimeout(timer); watcher.close(); resolve(read(file)); } });
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Response is still pending; keep the request ID and check again.')); }, 60000);
    if (fs.existsSync(file)) { clearTimeout(timer); watcher.close(); resolve(read(file)); }
  });
}
export function register(c, role) {
  if (!c.terminal) return { registered: false, reason: 'not_in_herdr' };
  const p = paths(c), registrationLock = path.join(p.dir, 'register.lock');
  let registration;
  try { registration = fs.openSync(registrationLock, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Another coordinator is being registered; retry from the panel.'); throw e; }
  try {
  const old = read(p.control);
  if (old?.terminal && old.terminal !== c.terminal) {
    let t;
    try { t = c.run('hc', ['get', old.terminal]); } catch(error) {
      if(!missingTerminal(error)||old.phase!=='retry_requested')throw new Error('Cannot verify the previous coordinator; refusing to create a second one.');
      const current=c.run('hc',['get',c.terminal]);if(current.cwd!==c.cwd||current.parent||current.state!=='live')throw Error('Replacement must be a real local project coordinator.');
    }
    if (t?.state === 'live' && ((t.status?.app && !['done', 'error'].includes(t.status.state)) || (!t.status?.app && Date.now() - old.startedAt < 60000))) throw new Error('This project already has a coordinator. Use the panel to continue or take over.');
  }
  const state = { ...old, terminal: c.terminal, role, phase: 'active', startedAt: Date.now() };
  save(p.control, state);
  log(c, role, role === 'claude' ? 'Claude 主總控已連線。' : 'Codex 備援總控已連線；先讀交接紀錄再接手。');
  return state;
  } finally { fs.closeSync(registration); fs.unlinkSync(registrationLock); }
}
export function takeover(c, reason, automatic = false) {
  const p = paths(c);
  let fd;
  try { fd = fs.openSync(p.lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return { switched: false, reason: 'transition_in_progress' }; throw e; }
  try {
    const old = read(p.control);
    if (!old?.terminal || old.role !== 'claude' || (c.terminal && old.terminal !== c.terminal)) return { switched: false, reason: 'not_active_claude' };
    const t = c.run('hc', ['get', old.terminal]);
    if (t.status?.state === 'blocked' && (!automatic || ['permission', 'question'].includes(t.status.kind))) throw new Error('Claude is waiting for a user or permission decision; handle it in the terminal before switching.');
    if (!automatic && t.status?.state === 'working') {
      c.run('hc', ['interrupt', old.terminal]);
      c.run('hc', ['wait', old.terminal, '--timeout', '5']);
      const after = c.run('hc', ['get', old.terminal]);
      if (after.status?.state === 'working' || after.status?.state === 'blocked') throw new Error('The previous coordinator has not stopped; takeover was not started.');
    }
    const handoff = { ...old, terminal: null, previousTerminal: old.terminal, role: 'codex', phase: 'handoff', reason, switchedAt: Date.now(), startedAt: Date.now() };
    save(p.control, handoff);
    const args = { name: 'Codex · 備援總控', folder: c.cwd, argv: [path.join(os.homedir(), '.local/bin/herdr-team-backup'), `前一位總控 ${old.terminal} 已停止當前回合，切換原因：${reason}。讀取 TASK.md（若存在）、.herdr-team/STATUS.md 及現有 worker 終端狀態，接手未完成的工作，避免重複派工。`], focus: true };
    if (reason.startsWith('simulated_')) args.argv[1] = '這是已完成任務後的備援演練，不是 Claude 真正耗盡額度。請只讀取 TASK.md、RESULT.md 與 .herdr-team/STATUS.md，核對既有工作代理和產物，寫一份簡短的 BACKUP-CHECK.md，確認能接手且不重複派工。不要修改實作、不要啟動其他代理，不要擴大到修復報告中的品質建議。完成後可用 herdr-team-runtime log Codex 記錄摘要。';
    if(c.chat)args.argv.splice(1,0,'--team-chat',c.chat);
    if (t.labels?.['herdr.space']) args.space = t.labels['herdr.space'];
    let made;
    try {
      made = c.headless ? coreLaunch(c,args.argv) : c.run('herdr-app', ['do', 'tab.new', JSON.stringify(args)]);
      if (!made.terminal) throw new Error('Herdr did not return a terminal.');
    } catch (e) {
      save(p.control, { ...old, phase: 'handoff_failed', failure: String(e.message) });
      throw e;
    }
    save(p.control, { ...handoff, terminal: made.terminal, tab: made.tab, phase: 'active' });
    log(c, '系統', `${automatic ? '自動' : '手動'}切換至 Codex 備援總控：${reason}；終端 ${made.terminal}。`);
    return { switched: true, terminal: made.terminal, reason };
  } finally { fs.closeSync(fd); fs.unlinkSync(p.lock); }
}
export function handleFailure(event, c) {
  if (event.hook_event_name !== 'StopFailure' || !recoverable.has(event.error)) return { switched: false, reason: 'not_a_recoverable_api_failure' };
  return takeover(c, event.simulated === true ? `simulated_${event.error}` : event.error, true);
}
export function hooksSettings(runtime, node) {
  const quote = x => "'" + String(x).replace(/'/g, "'\\''") + "'";
  return { hooks: { Stop: [{hooks: [{type:'command',command:`${quote(node)} ${quote(runtime)} reply`,timeout:10}]}], StopFailure: [{ matcher: [...recoverable].join('|'), hooks: [{ type: 'command', command: `${quote(node)} ${quote(runtime)} hook`, timeout: 20 }] }] } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argv=process.argv.slice(2);
    if(argv[0]==='--chat') {const id=argv[1];if(!id||!validChat(id))throw new Error('Invalid conversation ID.');process.env.HERDR_TEAM_CHAT_ID=id;argv.splice(0,2);}
    const [cmd, ...args] = argv;
    let result;
    if (['help', '--help', '-h'].includes(cmd)) result = { usage: 'herdr-team-runtime register claude|codex; report <coordinator-id> <role> <summary>; checklist; request <action> <json>; response <id>; log <role> <summary>; drain; takeover <project>' };
    else if (cmd === 'hook') {
      const event = JSON.parse(fs.readFileSync(0, 'utf8'));
      result = handleFailure(event, context(event.cwd || process.cwd()));
    } else if (cmd === 'reply') {
      const event = JSON.parse(fs.readFileSync(0,'utf8'));
      result = captureReply(event, context(event.cwd || process.cwd()), 'Claude');
    } else if (cmd === 'codex-notify') {
      const event = JSON.parse(args[0] || '{}');
      result = captureReply(event, context(event.cwd || process.cwd()), 'Codex');
    } else if (cmd === 'model-id') { process.stdout.write(selectedModel(context()) + '\n'); result = null; }
    else if (cmd === 'switch-model') result = await switchModel(context(), args[0]);
    else if (cmd === 'direct-report') result = directReply(context(),args[0],String(Date.now()));
    else if (cmd === 'checklist') result = checklist(context());
    else if (cmd === 'coordinator') result = args[0]==='set' ? setCoordinatorName(context(),args[1]) : coordinatorProfile(context());
    else if (cmd === 'roster') result = args[0]==='set' ? saveRoster(context(),JSON.parse(args[1]||'null')) : {agents:roster(context())};
    else if (cmd === 'route') result = routeMessage(args[0] || '',roster(context()));
    else if (cmd === 'enqueue') result = enqueueChat(context(),args[0]||'');
    else if (cmd === 'drain-project') result = drainProject(context());
    else if (cmd === 'prompt') {let prompt=fs.readFileSync(0,'utf8');const c=context();prompt=prompt.replaceAll('.herdr-team/',teamDir(c)+'/');if(c.chat)prompt=prompt.replaceAll('herdr-team-runtime ',`herdr-team-runtime --chat ${c.chat} `);if(c.headless)prompt=prompt.replaceAll('面板必須開啟。','背景工作服務必須運作。');process.stdout.write(prompt);result=null;}
    else if(cmd==='state-dir'){const c=context();paths(c);process.stdout.write(c.teamBase+'\n');result=null;}
    else if (cmd === 'register') result = register(context(), args[0]);
    else if (cmd === 'takeover') result = takeover(context(args[0] || process.cwd(), null), 'user_requested', false);
    else if (cmd === 'log') result = log(context(), args[0], args.slice(1).join(' '));
    else if (cmd === 'report') result = report(context(), args[0], args[1], args.slice(2).join(' '));
    else if (cmd === 'drain') result = drain(context());
    else if (cmd === 'request') result = request(context(), args[0], JSON.parse(args[1] || '{}'));
    else if (cmd === 'response') result = await response(context(), args[0]);
    else if (cmd === 'settings') result = hooksSettings(args[0], args[1]);
    else throw new Error('Unknown runtime command');
    if (!['hook','reply','codex-notify','model-id','prompt','state-dir'].includes(cmd)) process.stdout.write(JSON.stringify(result ?? { ok: true }) + '\n');
  } catch (error) { console.error(`Herdr team: ${error.message}`); process.exitCode = 1; }
}
