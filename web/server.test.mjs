import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {saveRoster,context} from '../team-runtime.mjs';
import {createServer} from './server.mjs';
test('a kept login shell is parked rather than a connected or starting agent; permission prompts are not parked',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-parked-')),home=path.join(root,'app'),folder=path.join(root,'project');fs.mkdirSync(home);fs.mkdirSync(folder);fs.writeFileSync(path.join(home,'shared.json'),JSON.stringify({'team-chat.projects':[{folder,name:'Parked fixture',chats:[{id:'unit-chat',title:'Unit chat'}]}]}));
 const c=context(folder,null,null,'unit-chat');fs.mkdirSync(c.teamDir,{recursive:true});fs.writeFileSync(path.join(c.teamDir,'control.json'),JSON.stringify({terminal:'tunitparked',phase:'active'}));let actual={address:'tunitparked',state:'live',foreground:{argv:['/bin/zsh','-l']},status:null};
 const server=createServer({allowedLogin:'owner@example.test',origin:'https://unit.tail.test',appHome:home,core:args=>args[0]==='get'?actual:{terminals:[]}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const read=async()=>await(await fetch('http://127.0.0.1:'+server.address().port+'/api/state',{headers:{'Tailscale-User-Login':'owner@example.test'}})).json();let s=await read();assert.equal(s.coordinatorParked,true);assert.equal(s.terminals[0].parked,true);assert.equal(s.coordinatorReady,false);
 actual={...actual,foreground:{argv:['/bin/sh','-c','herdr-team-lead']}};s=await read();assert.equal(s.coordinatorParked,false);
 actual={...actual,status:{app:'claude-code',state:'blocked'}};s=await read();assert.equal(s.coordinatorParked,false);assert.equal(s.coordinatorReady,true);
});
test('web bridge enforces Tailnet identity, origin, CSRF and registered project scope',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-web-unit-'));const app=path.join(dir,'app'),project=path.join(dir,'project');fs.mkdirSync(app);fs.mkdirSync(project);
 fs.writeFileSync(path.join(app,'shared.json'),JSON.stringify({'team-chat.projects':[{folder:project,name:'Unit project',chats:[{id:'unit-chat',title:'Unit chat'}]}]}));
 saveRoster(context(project,null),[{id:'member',name:'成員',provider:'codex',level:'worker',group:'',brief:''}]);
 const server=createServer({projectRoot:path.join(dir,'new-projects'),allowedLogin:'owner@example.test',origin:'https://unit.tail.test',appHome:app,core:()=>{throw Error('No real core allowed');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(base+'/api/state')).status,403);
 assert.equal((await fetch(base+'/api/state',{headers:{'Tailscale-User-Login':'other@example.test'}})).status,403);
 const headers={'Tailscale-User-Login':'owner@example.test'};
 // PWA assets retain the same Tailnet access boundary as the chat UI.
 assert.equal((await fetch(base+'/manifest.webmanifest')).status,403);
 const manifestReply=await fetch(base+'/herdr/manifest.webmanifest',{headers});
 assert.match(manifestReply.headers.get('content-type'),/application\/manifest\+json/);
 const manifest=await manifestReply.json();assert.equal(manifest.scope,'/herdr/');assert.equal(manifest.start_url,'/herdr/');assert.equal(manifest.display,'standalone');
 for(const icon of manifest.icons){const r=await fetch(base+'/herdr/'+icon.src.replace('./',''),{headers});assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0,8).toString('hex'),'89504e470d0a1a0a');}
 assert.match((await fetch(base+'/sw.js',{headers})).headers.get('content-type'),/javascript/);
 assert.equal((await fetch(base+'/config.json',{headers})).status,404);
 const data=await (await fetch(base+'/api/state',{headers})).json();assert.equal(data.agents.length,1);assert.equal(data.terminals.length,0);
 const post=(route,body,extra={})=>fetch(base+route,{method:'POST',headers:{...headers,Origin:'https://unit.tail.test','Content-Type':'application/json','X-Herdr-CSRF':data.csrfToken,...extra},body:JSON.stringify({project:data.project,chat:data.chat,...body})});
 assert.equal((await post('/api/message',{text:'do not send'}, {'X-Herdr-CSRF':'wrong'})).status,403);
 assert.equal((await post('/api/message',{text:'do not send'}, {Origin:'https://evil.test'})).status,403);
 assert.equal((await post('/api/message',{project:'unregistered',text:'do not send'})).status,404);
 const renamed=await (await post('/api/coordinator',{name:'  牧羊人總控  '})).json();assert.equal(renamed.name,'牧羊人總控');
 assert.equal((await (await fetch(base+'/api/state',{headers})).json()).coordinatorName,'牧羊人總控');
 assert.equal((await post('/api/coordinator',{name:'\n'})).status,400);
 const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',body={text:'@member Unit fixture only',id};
 const one=await (await post('/api/message',body)).json(),two=await (await post('/api/message',body)).json();assert(one.queued);assert.equal(one.id,two.id);
 const logs=fs.readFileSync(path.join(project,'.herdr-team/conversations/unit-chat/messages.jsonl'),'utf8').trim().split('\n');assert.equal(logs.length,1);
 assert.equal((await fetch(base+'/../../etc/passwd',{headers})).status,404);
 const agents=[...data.agents,{...data.agents[0],id:'frontend',name:'Frontend'}];
 const saved=await (await post('/api/roster',{agents})).json();assert.equal(saved.started,false);
 const next=await (await post('/api/chat',{})).json();assert.match(next.chat,/^web-/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(project,'.herdr-team/roster.json'))).length,2);
 assert.equal(JSON.parse(fs.readFileSync(path.join(app,'team-chat.json'))).chatId,next.chat);
 const created=await (await post('/api/project',{name:'New project'})).json();assert(created.project);assert(created.chat);
 const newState=await (await fetch(base+'/api/state?project='+created.project+'&chat='+created.chat,{headers})).json();assert.equal(newState.agents.length,1);assert.equal(newState.agents[0].id,'starter');assert.equal(newState.agents[0].name,'領頭羊');assert.equal(newState.agentWorkspace,true);assert.equal(newState.projects.length,2);
 assert.equal((await post('/api/roster',{project:created.project,chat:created.chat,agents:[]})).status,400);
 const registered=JSON.parse(fs.readFileSync(path.join(app,'web/projects.json'))).find(p=>p.chats.some(c=>c.id===created.chat)),folder=registered.folder;
 assert.equal((await post('/api/project-name',{project:created.project,chat:created.chat,name:'Renamed project'})).status,200);
 const renamedState=await(await fetch(base+'/api/state?project='+created.project+'&chat='+created.chat,{headers})).json();assert.equal(renamedState.projects.find(p=>p.id===created.project).name,'Renamed project');assert.equal(JSON.parse(fs.readFileSync(path.join(app,'web/projects.json'))).find(p=>p.folder===folder).chats[0].id,created.chat);
 assert.equal((await post('/api/appoint',{project:created.project,chat:created.chat,agentId:'starter'})).status,200);
 const appointed=await(await fetch(base+'/api/state?project='+created.project+'&chat='+created.chat,{headers})).json();assert.equal(appointed.coordinatorAgentId,'starter');assert.equal(appointed.agents[0].model,'claude-opus-5-5');
 assert.equal((await post('/api/appoint',{project:created.project,chat:created.chat,agentId:'foreign'})).status,400);
 const resumed=await (await fetch(base+'/api/state',{headers})).json();assert.equal(resumed.project,created.project);assert.equal(resumed.chat,created.chat);
 assert.equal((await post('/api/select',{project:data.project,chat:data.chat})).status,200);
 const otherClient=await (await fetch(base+'/api/state',{headers})).json();assert.equal(otherClient.project,data.project);assert.equal(otherClient.chat,data.chat);
 assert.equal((await post('/api/select',{project:'unknown',chat:data.chat})).status,404);
 assert.equal((await post('/api/select',{project:created.project,chat:created.chat},{'X-Herdr-CSRF':'invalid'})).status,403);
 const stillSelected=await (await fetch(base+'/api/state',{headers})).json();assert.equal(stillSelected.project,data.project);
 assert.equal(JSON.parse(fs.readFileSync(path.join(app,'web/selection.json'))).chat,data.chat);
 const direct=await(await post('/api/message',{agentId:'member',text:'Direct message fixture only',id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'})).json();assert.equal(direct.direct,true);assert.equal(direct.target,'member');assert(fs.existsSync(path.join(project,'.herdr-team/conversations/unit-chat/direct-queue',direct.id+'.json')));
 const mention=await(await post('/api/message',{agentId:'frontend',text:'@成員 Question fixture',id:'cccccccc-cccc-cccc-cccc-cccccccccccc'})).json();assert.equal(mention.target,'member');assert.equal(mention.direct,true);assert.equal(JSON.parse(fs.readFileSync(path.join(project,'.herdr-team/conversations/unit-chat/direct-queue',mention.id+'.json'))).text,'Question fixture');
 const html=await (await fetch(base+'/',{headers})).text();assert(html.includes('copy-chat-link'));
 assert.equal((await post('/api/project',{name:'x'.repeat(81)})).status,400);
});

test('startup retry API is scoped, explicit and refuses an active coordinator',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-retry-api-')),home=path.join(root,'app'),folder=path.join(root,'project');fs.mkdirSync(home);fs.mkdirSync(folder);
 fs.writeFileSync(path.join(home,'shared.json'),JSON.stringify({'team-chat.projects':[{folder,name:'Startup fixture',chats:[{id:'unit-chat',title:'Unit chat'}]}]}));
 const c=context(folder,null,null,'unit-chat');fs.mkdirSync(c.teamDir,{recursive:true});const control=path.join(c.teamDir,'control.json');fs.writeFileSync(control,JSON.stringify({terminal:'tunitowner',phase:'active'}));let live=false;
 const server=createServer({allowedLogin:'owner@example.test',origin:'https://unit.tail.test',appHome:home,core:args=>args[0]==='get'?{address:'tunitowner',state:live?'live':'finished',status:null}:{terminals:[]}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port,headers={'Tailscale-User-Login':'owner@example.test'};const state=await (await fetch(base+'/api/state',{headers})).json();assert.equal(state.startupStopped,true);
 const post=token=>fetch(base+'/api/retry-start',{method:'POST',headers:{...headers,Origin:'https://unit.tail.test','Content-Type':'application/json','X-Herdr-CSRF':token},body:JSON.stringify({project:state.project,chat:state.chat})});
 assert.equal((await post('wrong')).status,403);const retry=await (await post(state.csrfToken)).json();assert.equal(retry.queued,true);assert.equal(retry.restarted,false);assert.equal(JSON.parse(fs.readFileSync(control)).phase,'retry_requested');
 live=true;assert.equal((await post(state.csrfToken)).status,400);
});

test('removed owner is explicitly retryable while transient core failures remain errors',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-owner-missing-')),home=path.join(root,'app'),folder=path.join(root,'project');fs.mkdirSync(home);fs.mkdirSync(folder);
 fs.writeFileSync(path.join(home,'shared.json'),JSON.stringify({'team-chat.projects':[{folder,name:'Missing owner',chats:[{id:'unit-chat',title:'Unit chat'}]}]}));const c=context(folder,null,null,'unit-chat');fs.mkdirSync(c.teamDir,{recursive:true});fs.writeFileSync(path.join(c.teamDir,'control.json'),JSON.stringify({terminal:'tunitremoved',phase:'active'}));let missing=true;
 const server=createServer({allowedLogin:'owner@example.test',origin:'https://unit.tail.test',appHome:home,core:()=>{throw missing?Object.assign(Error('removed'),{stderr:JSON.stringify({error:{kind:'not_found'}})}):Error('offline');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});const base='http://127.0.0.1:'+server.address().port,headers={'Tailscale-User-Login':'owner@example.test'};
 const state=await(await fetch(base+'/api/state',{headers})).json();assert.equal(state.startupStopped,true);assert.equal(state.coreError,null);
 const request=()=>fetch(base+'/api/retry-start',{method:'POST',headers:{...headers,Origin:'https://unit.tail.test','Content-Type':'application/json','X-Herdr-CSRF':state.csrfToken},body:JSON.stringify({project:state.project,chat:state.chat})});assert.equal((await request()).status,200);missing=false;const offline=await(await fetch(base+'/api/state',{headers})).json();assert.equal(offline.startupStopped,false);assert(offline.coreError);assert.equal((await request()).status,400);
});
