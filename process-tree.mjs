import {execFileSync} from 'node:child_process';
// Read only this process subtree: no arguments, environment or whole-host list.
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
