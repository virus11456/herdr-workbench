#!/usr/bin/env node
// Workbench deployment is independent from the upstream Herdr desktop installer.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';import {randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';import {createInterface} from 'node:readline/promises';
import {validateDriveRoot} from './storage.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {hooksSettings} from './team-runtime.mjs';
const source=path.dirname(fileURLToPath(import.meta.url));
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function findTool(name){for(const dir of [path.join(os.homedir(),'.local/bin'),...(process.env.PATH||'').split(path.delimiter)]){const p=path.join(dir,name);try{fs.accessSync(p,fs.constants.X_OK);if(fs.statSync(p).isFile())return p;}catch{}}throw Error(`缺少 ${name}，請依 README 官方來源安裝；登入與授權需由你親自完成。`);}
export function mergeProjects(groups){
 const map=new Map();
 for(const group of groups)for(const item of group||[]){
  const folder=fs.realpathSync(item.folder),old=map.get(folder),chats=new Map((old?.chats||[]).map(c=>[c.id,c]));
  for(const chat of item.chats||[])if(!chats.has(chat.id))chats.set(chat.id,chat);
  map.set(folder,{...item,...old,folder,chats:[...chats.values()].sort((a,b)=>(a.createdAt||0)-(b.createdAt||0))});
 }
 return [...map.values()];
}
export function deploymentPlan(input,tools){
 const home=input.home||path.join(os.homedir(),'.config/herdr-workbench'),bin=input.bin||path.join(os.homedir(),'.local/bin'),core=input.core||path.join(os.homedir(),'.config/herdr-core');
 if(!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(input.origin||'')||!input.login||/[\r\n\0]/.test(input.login))throw Error('需要有效的 HTTPS origin 與本人 Tailscale LoginName。');
 const port=Number(input.port||48724);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('port 必須為 1024–65535。');
 const cloud=path.join(os.homedir(),'Library/CloudStorage');if(path.resolve(home).startsWith(cloud+path.sep))throw Error('執行控制資料不得存進雲端同步資料夾。');
 let driveRoot=input.driveRoot?validateDriveRoot(input.driveRoot):null;
 const config={appHome:home,headless:true,stateRoot:path.join(home,'runtime/projects'),origin:input.origin,allowedLogin:input.login,port,projectRoot:driveRoot||input.projectRoot||path.join(os.homedir(),'HerdrProjects'),driveRoot,legacyProjects:input.legacyProjects||[]};
 const files=[];const add=(target,content,mode=0o600)=>files.push({target,content,mode});
 for(const name of ['package.json','package-lock.json','team-runtime.mjs','background.mjs','storage.mjs','checklist.mjs','direct.mjs','agy-reply.mjs','minimax-reply.mjs'])add(path.join(home,name),fs.readFileSync(path.join(source,name)));
 const agyHooks=input.antigravityHooks||path.join(os.homedir(),'.gemini/config/hooks.json');let existingHooks={};
 try{existingHooks=JSON.parse(fs.readFileSync(agyHooks,'utf8'));if(!existingHooks||typeof existingHooks!=='object'||Array.isArray(existingHooks))throw Error('Invalid hooks file');}catch(e){if(e.code!=='ENOENT')throw e;}
 add(agyHooks,JSON.stringify({...existingHooks,'herdr-workbench-reply':{Stop:[{type:'command',command:quote(tools.node)+' '+quote(path.join(home,'agy-reply.mjs')),timeout:10}]}},null,2)+'\n');
 const minimaxHooks=input.minimaxHooks||path.join(os.homedir(),'.minimax/hooks.json');let previousMinimax={enabled:true,hooks:{}};
 try{previousMinimax=JSON.parse(fs.readFileSync(minimaxHooks,'utf8'));if(!previousMinimax||typeof previousMinimax!=='object'||Array.isArray(previousMinimax))throw Error('Invalid MiniMax hooks file');}catch(e){if(e.code!=='ENOENT')throw e;}
 const stop=(previousMinimax.hooks?.Stop||[]).map(group=>({...group,hooks:(group.hooks||[]).filter(hook=>hook.name!=='Herdr reply')})).filter(group=>group.hooks.length);
 stop.push({hooks:[{type:'command',name:'Herdr reply',command:quote(tools.node)+' '+quote(path.join(home,'minimax-reply.mjs')),timeout:10}]});
 add(minimaxHooks,JSON.stringify({...previousMinimax,hooks:{...previousMinimax.hooks,Stop:stop}},null,2)+'\n');
 const replacements={'@NODE_SHELL@':quote(tools.node),'@NOTIFY_CONFIG@':quote('notify='+JSON.stringify([tools.node,path.join(home,'team-runtime.mjs'),'codex-notify']))};
 for(const name of ['runtime','lead','backup','claude','codex','minimax','antigravity']){
  let text=fs.readFileSync(path.join(source,'bin/herdr-team-'+name),'utf8');
  for(const [key,value]of Object.entries(replacements))text=text.replaceAll(key,value);
  // The original paths occur inside double quoted shell strings.
  const escaped=home.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('$','\\$').replaceAll('`','\\`');
  text=text.replaceAll('$HOME/.config/herdr-app',escaped).replace('set -eu','set -eu\nexport HERDR_WORKBENCH_HOME='+quote(home));
  add(path.join(bin,'herdr-team-'+name),text,0o755);
 }
 for(const [name,marker,command]of [['herdr-claude-task','@CLAUDE_COMMAND@','herdr-team-claude'],['herdr-codex-implement','@CODEX_COMMAND@','herdr-team-codex'],['herdr-minimax-cn','@MINIMAX_COMMAND@','herdr-team-minimax'],['herdr-antigravity-task','@ANTIGRAVITY_COMMAND@','herdr-team-antigravity']]){
  add(path.join(core,'templates',name+'.md'),fs.readFileSync(path.join(source,'templates',name+'.md'),'utf8').replaceAll(marker,quote(path.join(bin,command))));
 }
 for(const name of ['server.mjs','push.mjs','tasks.mjs','pasture.mjs','pixel-sheep.svg','agent-management.mjs','index.html','app.js','style.css','format.mjs','viewport.mjs','activity.mjs','manifest.webmanifest','sw.js','app-icon.svg','icon-192.png','icon-512.png','apple-touch-icon.png','sheep.svg','pasture.svg','shepherd.svg'])add(path.join(home,'web',name),fs.readFileSync(path.join(source,'web',name)));
 add(path.join(home,'team-claude-settings.json'),JSON.stringify(hooksSettings(path.join(home,'team-runtime.mjs'),tools.node),null,2)+'\n');
 add(path.join(home,'service.json'),JSON.stringify(config,null,2)+'\n');add(path.join(home,'web/config.json'),JSON.stringify(config,null,2)+'\n');
 if(input.projects)add(path.join(home,'web/projects.json'),JSON.stringify(input.projects,null,2)+'\n');
 const agents=[];
 for(const [kind,program]of [['web',path.join(home,'web/server.mjs')],['queue',path.join(home,'background.mjs')]]){
  const label='dev.herdr.workbench-'+kind,target=path.join(input.launchAgents||path.join(os.homedir(),'Library/LaunchAgents'),label+'.plist');
  const envPath=[bin,path.dirname(tools.node),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].join(':');
  const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(tools.node)}</string><string>${xml(program)}</string></array><key>WorkingDirectory</key><string>${xml(home)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(envPath)}</string><key>HERDR_WORKBENCH_HOME</key><string>${xml(home)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(home,'logs',kind+'.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(home,'logs',kind+'.error.log'))}</string></dict></plist>`;
  add(target,plist);agents.push({label,target});
 }
 const links=Object.entries(tools).flatMap(([name,target])=>{const dest=path.join(bin,name);if(path.resolve(target)===dest)return[];try{fs.lstatSync(dest);return[];}catch(e){if(e.code!=='ENOENT')throw e;}return[{target:dest,source:target}];});
 return {config,files,links,agents};
}
export function applyDeployment(plan){
 const backup=path.join(plan.config.appHome,'backups',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
 fs.mkdirSync(backup,{recursive:true,mode:0o700});const manifest=[];
 for(const [i,file]of plan.files.entries()){
  let old;try{old=fs.lstatSync(file.target);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(old&&!old.isFile()&&!old.isSymbolicLink())throw Error('目的地不是一般檔案：'+file.target);
  const saved=old?path.join(backup,String(i)):null;
  if(old){if(old.isSymbolicLink())fs.symlinkSync(fs.readlinkSync(file.target),saved);else fs.copyFileSync(file.target,saved);}
  manifest.push({target:file.target,backup:saved});
 }
 fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify({files:manifest,links:plan.links},null,2),{mode:0o600});
 for(const file of plan.files){fs.mkdirSync(path.dirname(file.target),{recursive:true,mode:0o700});const tmp=file.target+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,file.content,{mode:file.mode});fs.renameSync(tmp,file.target);}
 for(const link of plan.links){fs.mkdirSync(path.dirname(link.target),{recursive:true});fs.symlinkSync(link.source,link.target);}
 fs.mkdirSync(path.join(plan.config.appHome,'logs'),{recursive:true,mode:0o700});fs.mkdirSync(plan.config.projectRoot,{recursive:true,mode:0o700});
 return backup;
}
async function main(){
 if(process.platform!=='darwin')throw Error('背景安裝器目前僅支援 macOS；Windows 不支援這套 POSIX 啟動器，Linux 尚未實機驗證。');
 if(Number(process.versions.node.split('.')[0])<20)throw Error('需要 Node.js 20+；建議 Node.js 24 LTS。');
 const args=process.argv.slice(2),input={},flags=new Set();
 const names={'--origin':'origin','--login':'login','--project-root':'projectRoot','--drive-root':'driveRoot','--port':'port','--home':'home'};
 for(let i=0;i<args.length;i++){const key=args[i];if(names[key]){if(!args[i+1]||args[i+1].startsWith('--'))throw Error('缺少參數：'+key);input[names[key]]=args[++i];}else if(['--dry-run','--no-start','--help','--import-desktop','--confirm'].includes(key))flags.add(key);else throw Error('未知參數：'+key);}
 if(flags.has('--help')){console.log('node setup.mjs [--dry-run] [--origin https://host.tailnet.ts.net --login owner@example.com] [--drive-root PATH] [--import-desktop] [--no-start]');return;}
 const existingHome=input.home||path.join(os.homedir(),'.config/herdr-workbench');let previous;try{previous=JSON.parse(fs.readFileSync(path.join(existingHome,'service.json')));}catch{}
 if(previous){input.origin??=previous.origin;input.login??=previous.allowedLogin;input.port??=previous.port;input.projectRoot??=previous.projectRoot;input.driveRoot??=previous.driveRoot;input.legacyProjects=previous.legacyProjects;}
 if(!input.origin||!input.login){
  if(!process.stdin.isTTY)throw Error('首次設定需提供 --origin 與 --login，或在互動式終端執行 Install.command。');
  const ui=createInterface({input:process.stdin,output:process.stdout});try{input.origin||=(await ui.question('Tailscale HTTPS 網址（不含 /herdr）：')).trim();input.login||=(await ui.question('Tailscale LoginName：')).trim();}finally{ui.close();}
 }
 if(flags.has('--import-desktop')){
  const old=path.join(os.homedir(),'.config/herdr-app'),groups=[];
  for(const [file,key]of [[path.join(existingHome,'web/projects.json'),null],[path.join(old,'shared.json'),'team-chat.projects'],[path.join(old,'web/projects.json'),null]]){try{const data=JSON.parse(fs.readFileSync(file));groups.push(key?data[key]||[]:data);}catch(e){if(e.code!=='ENOENT')throw e;}}
  input.projects=mergeProjects(groups);input.legacyProjects=[...new Set([...(previous?.legacyProjects||[]),...groups.slice(1).flatMap(list=>list.map(p=>fs.realpathSync(p.folder)))])];
 }
 const tools={node:process.execPath,...Object.fromEntries(['hc','claude','codex','mcode','agy'].map(name=>[name,findTool(name)]))};
 const plan=deploymentPlan(input,tools);console.log(JSON.stringify({mode:'background',dependencies:{command:'npm ci --omit=dev --ignore-scripts --no-audit --no-fund',lockfile:'package-lock.json',installScripts:false},files:plan.files.map(f=>f.target),links:plan.links,projects:input.projects?.length||0,drive:plan.config.driveRoot?'configured':'needs_login',launchAgents:plan.agents.map(a=>a.label)},null,2));
 if(flags.has('--dry-run')){console.log('Dry run：未寫入檔案、未啟動代理、未修改 Tailscale。');return;}
 if(flags.has('--confirm')){if(!process.stdin.isTTY)throw Error('請在主機互動式終端確認安裝。');const ui=createInterface({input:process.stdin,output:process.stdout});let answer;try{answer=await ui.question('依上列範圍備份並安裝？[y/N] ');}finally{ui.close();}if(!/^[yY]$/.test(answer.trim())){console.log('已取消，未安裝。');return;}}
 const backup=applyDeployment(plan);console.log('備份：'+backup);
 const npm=findTool('npm');execFileSync(npm,['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:plan.config.appHome,stdio:'inherit'});
 if(!flags.has('--no-start'))for(const a of plan.agents){
  const domain='gui/'+process.getuid();let loaded=false;try{execFileSync('launchctl',['print',domain+'/'+a.label],{stdio:'ignore'});loaded=true;}catch{}
  if(loaded){execFileSync('launchctl',['kickstart','-k',domain+'/'+a.label],{stdio:'inherit'});continue;}
  let error;for(let n=0;n<8;n++){try{execFileSync('launchctl',['bootstrap',domain,a.target],{stdio:'pipe'});error=null;break;}catch(e){error=e;await delay(250);}}
  if(error)throw Error('無法載入背景服務 '+a.label+'；請檢查使用者 LaunchAgent 與本機 logs，不需要 root。');
 }
 console.log('背景服務已安裝。請依 README 將 Tailscale Serve /herdr 指向 http://127.0.0.1:'+plan.config.port+'。這不會啟用 Funnel。');
 if(!plan.config.driveRoot)console.log('Google Drive 尚未連線：完成官方桌面版登入，再以 --drive-root 指定串流資料夾。');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
