import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {serviceAlive} from './storage.mjs';

// Read-only checks for installation and post-reboot recovery. Never print the
// private configuration, API responses, credentials or conversation contents.
const home=process.env.HERDR_WORKBENCH_HOME||path.join(os.homedir(),'.config/herdr-workbench');
const checks=[];
const check=(name,passed,detail)=>checks.push({name,passed,...(detail?{detail}: {})});
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
check('macOS host',process.platform==='darwin');
check('Node.js 20+',Number(process.versions.node.split('.')[0])>=20,process.version);
let config;
try{config=JSON.parse(fs.readFileSync(path.join(home,'service.json'),'utf8'));check('Private host configuration',!!config.headless&&/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(config.origin));}
catch{check('Private host configuration',false,'Run the installer for this user.');}
for(const [name,args]of [['hc',['-V']],['claude',['--version']],['codex',['--version']],['mcode',['--version']]]){
 try{const version=run(path.join(os.homedir(),'.local/bin',name),args).trim().split('\n')[0].slice(0,120);check(name+' CLI',true,version);}catch{check(name+' CLI',false,'Check the official installation and PATH.');}
}
if(config){
 check('Background queue heartbeat',serviceAlive(home));
 for(const name of ['dev.herdr.workbench-web','dev.herdr.workbench-queue']){
  try{check(name,/state = running/.test(run('/bin/launchctl',['print',`gui/${process.getuid()}/${name}`])));}catch{check(name,false,'Log in to macOS and inspect the LaunchAgent.');}
 }
 try{const templates=run(path.join(os.homedir(),'.local/bin/hc'),['templates']);check('Worker templates',['herdr-claude-task','herdr-codex-implement','herdr-minimax-cn'].every(name=>templates.includes(name)));}catch{check('Worker templates',false);}
 try{const response=await fetch(config.origin+'/herdr/api/state',{signal:AbortSignal.timeout(15000),cache:'no-store'});const data=response.ok?await response.json():null;check('Real Tailnet HTTPS entry',response.ok&&data?.backendMode==='background'&&data?.appOpen===true,response.ok?'Identity-checked background API responded.':'HTTP '+response.status);}
 catch{check('Real Tailnet HTTPS entry',false,'Check Tailscale, Serve and the background Web service.');}
 if(config.driveRoot)check('Configured Drive folder',fs.existsSync(config.driveRoot),'Folder availability is not cloud upload verification.');
}
let bootTime=null;
try{bootTime=Number(run('/usr/sbin/sysctl',['-n','kern.boottime']).match(/sec = (\d+)/)?.[1])||null;}catch{}
console.log(JSON.stringify({checkedAt:new Date().toISOString(),bootTime,passed:checks.every(c=>c.passed),checks,limits:'CLI presence is not login verification. This does not run agents, accept permissions, or prove fresh-machine/physical-device behavior.'},null,2));
if(checks.some(c=>!c.passed))process.exitCode=1;
