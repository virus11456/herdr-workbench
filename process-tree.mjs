import {execFileSync} from 'node:child_process';
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
// Inspect only the owned subtree. Known infrastructure launch arguments are
// matched in memory below; never persist them, environment or a host-wide list.
export function nativeProcessTree(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Invalid native process ID.');
 const inspect=id=>{
  let text;try{text=execFileSync('/bin/ps',['-p',String(id),'-o','ppid=,lstart=,comm='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'},timeout:2000}).trim();}catch(error){if(error.status===1)return null;throw error;}
  if(!text)return null;const match=text.match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);if(!match)throw Error('Native process identity unavailable.');
  return{pid:id,parent:Number(match[1]),started:match[2],command:match[3]};
 };
 const root=inspect(pid);if(!root)throw Error('Native process disappeared.');const children=[],queue=[pid],seen=new Set();
 while(queue.length){const parent=queue.shift();if(seen.has(parent))continue;seen.add(parent);if(seen.size>128)throw Error('Native process tree exceeds verification limit.');
  let output;try{output=execFileSync('/usr/bin/pgrep',['-P',String(parent)],{encoding:'utf8',timeout:2000}).trim();}catch(error){if(error.status===1)continue;throw error;}
  for(const value of output.split(/\s+/).filter(Boolean)){const id=Number(value);if(!Number.isSafeInteger(id)||id<=0)throw Error('Invalid child identity.');const child=inspect(id);if(!child||child.parent!==parent)continue;children.push(child);queue.push(id);}
 }
 const after=inspect(pid);if(JSON.stringify(after)!==JSON.stringify(root))throw Error('Native process changed during inspection.');return{root,children:children.sort((a,b)=>a.pid-b.pid)};
}
export function idleProcessTree(tree,baseline){
 if(!tree?.root||!Array.isArray(tree.children))return false;
 if(!tree.children.length)return true;
 if(baseline?.verifiedIdle!==true||JSON.stringify(tree.root)!==JSON.stringify(baseline.tree?.root)||!Array.isArray(baseline.tree.children))return false;
 const known=new Map(baseline.tree.children.map(row=>[row.pid,JSON.stringify(row)]));return tree.children.every(row=>known.get(row.pid)===JSON.stringify(row));
}
export function inspectTerminalProcesses(c,terminal){
 // A supplied Core runner/process observer is a host/test dependency, never a
 // setting accepted from HTTP, a model response or a project document.
 return c.processTree?c.processTree(terminal.pid):c.run.nativeProcessInspection?nativeProcessTree(terminal.pid):{root:{pid:terminal.pid},children:[]};
}

// This is the native MiniMax lease guard implementation, not an arbitrary Node
// script. Pin the program; a new implementation must be reviewed explicitly.
export const minimaxGuardHash='cf98a766ebc1b65f6947b4136f47843ca8d4966b55e4329b79b6354679c2dd00';
export function infrastructureLaunch({provider,child,rootExecutable,nodeExecutable,args,targetAlive,rootPid,mappedExecutable}){
 if(provider==='claude'&&['caffeinate','/usr/bin/caffeinate'].includes(child.command)&&mappedExecutable==='/usr/bin/caffeinate'){
  const words=args.split(/\s+/);if(!['caffeinate','/usr/bin/caffeinate'].includes(words.shift())||!words.length)return null;
  for(let i=0;i<words.length;i++){const flag=words[i];if(/^-[dimsu]+$/.test(flag))continue;if(flag==='-w'&&/^\d+$/.test(words[i+1]||'')&&Number(words[++i])===rootPid)continue;if(flag==='-t'&&/^\d+(?:\.\d+)?$/.test(words[i+1]||'')&&Number(words[i+1])>0&&Number(words[++i])<=86400)continue;return null;}
  return{kind:'macos-power-assertion',executable:'/usr/bin/caffeinate'};
 }
 if(provider==='codex'&&typeof rootExecutable==='string'&&path.basename(rootExecutable)==='codex'){
  const bundle=path.resolve(path.dirname(rootExecutable),'../../..'),expected=path.join(bundle,'bin','codex-code-mode-host');
  if(path.basename(bundle)==='codex-cli'&&child.command===expected&&args===expected+' --listen grpc+stdio://')return{kind:'codex-code-mode-host',executable:expected};
 }
 if(provider==='minimax'&&child.command===nodeExecutable){
  const prefix=nodeExecutable+' --input-type=module --eval ';if(!args.startsWith(prefix))return null;
  const match=args.slice(prefix.length).match(/^([\s\S]+) (\d+) (\d+) ([a-f0-9-]{36})$/);if(!match)return null;
  const script=match[1].replaceAll('\\012','\n'),hash=createHash('sha256').update(script).digest('hex');
  const pid=Number(match[2]),grace=Number(match[3]);if(hash!==minimaxGuardHash||!Number.isSafeInteger(pid)||pid<=0||grace<0||grace>30000||targetAlive(pid)!==false)return null;
  return{kind:'minimax-lease-guard',executable:nodeExecutable,scriptSha256:hash,initialTarget:pid};
 }
 return null;
}
export function automaticIdleBaseline(c,terminal,tree,baseline){
 if(!tree?.root||!Array.isArray(tree.children)||!['idle','done'].includes(terminal.status?.state))return null;
 const known=new Map((baseline?.verifiedIdle===true&&JSON.stringify(baseline.tree?.root)===JSON.stringify(tree.root)?baseline.tree.children:[]).map(p=>[p.pid,JSON.stringify(p)]));
 const helpers=[];for(const child of tree.children){
  if(known.get(child.pid)===JSON.stringify(child))continue;
  // New infrastructure must be a direct, childless helper. Never learn a new
  // shell, a generic Node/Python service, an executor's descendants or a task.
  if(child.parent!==tree.root.pid||tree.children.some(p=>p.parent===child.pid))return null;
  let proof;try{
   if(c.processInfrastructure)proof=c.processInfrastructure(terminal,child);
   else if(c.run.nativeProcessInspection){
    const args=execFileSync('/bin/ps',['-ww','-p',String(child.pid),'-o','args='],{encoding:'utf8',timeout:2000,maxBuffer:32*1024}).trim();
    const targetAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='ESRCH'?false:null;}};
    let mappedExecutable;if(terminal.status.app==='claude-code'&&['caffeinate','/usr/bin/caffeinate'].includes(child.command)){const text=execFileSync('/usr/sbin/lsof',['-a','-p',String(child.pid),'-d','txt','-Fn'],{encoding:'utf8',timeout:2000,maxBuffer:32*1024});if(text.split('\n').includes('n/usr/bin/caffeinate'))mappedExecutable='/usr/bin/caffeinate';}
    proof=infrastructureLaunch({rootPid:tree.root.pid,mappedExecutable,provider:{codex:'codex',mcode:'minimax','claude-code':'claude'}[terminal.status.app],child,rootExecutable:tree.root.command.includes('/')?fs.realpathSync(tree.root.command):tree.root.command,nodeExecutable:fs.realpathSync(process.execPath),args,targetAlive});
   }
  }catch{return null;}if(!proof)return null;helpers.push({pid:child.pid,...proof});
 }
 return helpers.length?{tree,helpers}:null;
}
