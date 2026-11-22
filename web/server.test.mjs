import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {saveRoster,context} from '../team-runtime.mjs';
import {createECDH,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from './server.mjs';

test('live updates require authenticated registered scope and report file changes without message content',async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'herdr-events-'))),app=path.join(dir,'app'),folder=path.join(dir,'project');
 fs.mkdirSync(app);fs.mkdirSync(folder);fs.mkdirSync(path.join(app,'web'));
 fs.writeFileSync(path.join(app,'shared.json'),JSON.stringify({'team-chat.projects':[{folder,name:'Events',chats:[{id:'one'}]}]}));
 const c=context(folder,null,null,'one');
 const server=createServer({appHome:app,allowedLogin:'owner@example.test',origin:'https://events.test',core:()=>{throw Error('No agents');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const abort=new AbortController();
 t.after(async()=>{abort.abort();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port+'/api/';const identity={'Tailscale-User-Login':'owner@example.test'};
 const s=await(await fetch(base+'state?chat=one',{headers:identity})).json();
 const route=base+'events?'+new URLSearchParams({project:s.project,chat:'one'});
 assert.equal((await fetch(route)).status,403);
 assert.equal((await fetch(route,{headers:{...identity,Origin:'https://wrong.test'}})).status,403);
 assert.equal((await fetch(base+'events?project=foreign&chat=one',{headers:identity})).status,404);
 const response=await fetch(route,{headers:identity,signal:abort.signal});assert.match(response.headers.get('content-type'),/text\/event-stream/);
 const reader=response.body.getReader(),decoder=new TextDecoder();let data=decoder.decode((await reader.read()).value);assert(data.includes('event: ready'));
 fs.mkdirSync(c.teamDir,{recursive:true});fs.appendFileSync(path.join(c.teamDir,'messages.jsonl'),'PRIVATE-MESSAGE-CONTENT\n');
 const timeout=setTimeout(()=>abort.abort(),3000);
 while(!data.includes('event: change'))data+=decoder.decode((await reader.read()).value);
 clearTimeout(timeout);assert(!data.includes('PRIVATE-MESSAGE-CONTENT'));await reader.cancel();
});

test('opening an agent finds its newest active chat while explicit history links stay pinned',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-recent-unit-'));
 const app=path.join(dir,'app'),project=path.join(dir,'project');
 fs.mkdirSync(app);fs.mkdirSync(project);
 const chats=[{id:'oldest',title:'Oldest'},{id:'middle',title:'Middle'},{id:'empty',title:'Empty'}];
 fs.writeFileSync(path.join(app,'shared.json'),JSON.stringify({'team-chat.projects':[
  {folder:project,name:'Fixture',agentWorkspace:true,chats}
 ]}));
 saveRoster(context(project,null),[
  {id:'starter',name:'領頭羊',provider:'claude',level:'worker'},
  {id:'engineer',name:'工程師',provider:'codex',level:'worker'}
 ]);
 const record=(chat,rows)=>{
  const scope=context(project,null,null,chat);
  fs.mkdirSync(scope.teamDir,{recursive:true});
  fs.writeFileSync(path.join(scope.teamDir,'messages.jsonl'),rows.map(e=>JSON.stringify(e)).join('\n')+'\n');
 };
 const event=(target,at,kind='reply')=>({kind,time:'2026-11-21T'+at+'Z',direct:true,target,text:'fixture'});
 record('oldest',[event('engineer','12:00:00'),event('starter','13:10:00')]);
 record('middle',[event('starter','13:00:00'),event('engineer','14:00:00')]);
 const server=createServer({allowedLogin:'owner@example.test',origin:'https://example.test',appHome:app,
  core:()=>{throw Error('No agents should start');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port+'/api/state?';
 const state=async query=>await(await fetch(base+query,{headers:{'Tailscale-User-Login':'owner@example.test'}})).json();
 assert.equal((await state('latest=1')).chat,'oldest');
 assert.equal((await state('latest=1&agent=engineer')).chat,'middle');
 assert.equal((await state('latest=1&chat=empty')).chat,'empty');
 record('middle',[event('starter','15:00:00','user')]);
 assert.equal((await state('latest=1')).chat,'middle');
 assert.equal((await state('chat=oldest')).chat,'oldest');
});

test('agent timeline combines only its own project conversations and pages through older messages',async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'herdr-timeline-')));
 const home=path.join(dir,'app'),folder=path.join(dir,'project'),other=path.join(dir,'other');
 for(const p of [home,folder,other])fs.mkdirSync(p);
 const chats=[{id:'old',title:'Old'},{id:'current',title:'Current'}];
 fs.writeFileSync(path.join(home,'shared.json'),JSON.stringify({'team-chat.projects':[
  {folder,name:'Fixture',agentWorkspace:true,chats},{folder:other,name:'Other',agentWorkspace:true,chats}
 ]}));
 const roster=[{id:'starter',name:'領頭羊',provider:'claude',level:'worker'},
  {id:'engineer',name:'工程師',provider:'codex',level:'worker'}];
 for(const p of [folder,other])saveRoster(context(p,null),roster);
 const row=(target,text,second,fields={})=>({kind:'reply',time:new Date(Date.UTC(2026,10,21,0,0,second)).toISOString(),direct:true,target,text,...fields});
 const save=(project,chat,rows)=>{
  const c=context(project,null,null,chat);
  fs.mkdirSync(c.teamDir,{recursive:true});
  fs.writeFileSync(path.join(c.teamDir,'messages.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
  return path.join(c.teamDir,'messages.jsonl');
 };
 const old=save(folder,'old',[
  row('engineer','file: Herdr 附件/example.txt',0,{kind:'user',messageId:'same',delivery:'queued'}),
  row('engineer','sent',1,{kind:'delivery',messageId:'same',delivery:'sent'}),
  ...Array.from({length:101},(_,i)=>row('engineer','older '+i,i+2)),
  row('starter','leader only',103),
  row('starter','legacy only',104,{direct:false})
 ]);
 save(folder,'current',[row('engineer','latest',110),row('starter','latest leader',111)]);
 save(other,'old',[row('engineer','other project',112)]);
 const server=createServer({allowedLogin:'owner@example.test',origin:'https://example.test',appHome:home,
  core:()=>{throw Error('No agents should start');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port+'/api/';
 const get=(route,q)=>fetch(base+route+'?'+new URLSearchParams(q),{headers:{'Tailscale-User-Login':'owner@example.test'}});
 const state=async q=>await(await get('state',q)).json();
 const initial=await state({timeline:1,latest:1,agent:'engineer'});
 assert.equal(initial.chat,'current');
 const {project,chat,timeline}=initial,scope={project,chat,agent:'engineer'};
 assert.equal(timeline.messages.length,100);
 assert.equal(timeline.messages[0].text,'older 2');
 assert.equal(timeline.messages.at(-1).text,'latest');
 assert.equal(initial.messages.length,2);
 const page=await(await get('history',{...scope,before:timeline.before})).json();
 assert.deepEqual(page.messages.map(m=>m.text),['file: Herdr 附件/example.txt','older 0','older 1']);
 assert.equal(page.messages[0].sourceChat,'old');assert.equal(page.messages[0].delivery,'sent');assert.equal(page.before,null);
 assert.equal((await get('history',{...scope,agent:'starter',before:timeline.before})).status,409);
 assert.deepEqual((await state({timeline:1,...scope,agent:'starter'})).timeline.messages.map(m=>m.text),['leader only','latest leader']);
 const unchanged=await state({timeline:1,...scope,timelineRevision:timeline.revision,messagesRevision:initial.messagesRevision});
 assert(!Object.hasOwn(unchanged.timeline,'messages'));assert(!Object.hasOwn(unchanged,'messages'));
 fs.appendFileSync(old,JSON.stringify(row('engineer','old task new reply',113))+'\n');
 const updated=await state({timeline:1,...scope,timelineRevision:timeline.revision,messagesRevision:initial.messagesRevision});
 assert.equal(updated.timeline.messages.at(-1).text,'old task new reply');assert(!Object.hasOwn(updated,'messages'));
 const exact=await state({project,chat:'old',timeline:1,agent:'engineer'});
 assert.equal(exact.chat,'old');assert.equal(exact.timeline.messages.at(-1).text,'old task new reply');
});

test('attachment upload stays inside the selected conversation and unchanged refreshes omit history',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'herdr-attachment-test-')));
 const home=path.join(root,'app'),folder=path.join(root,'project');
 fs.mkdirSync(home);fs.mkdirSync(folder);
 const chats=[{id:'one',title:'One'},{id:'two',title:'Two'}];
 fs.writeFileSync(path.join(home,'shared.json'),JSON.stringify({'team-chat.projects':[{folder,name:'Fixture',chats}]}));
 const c=context(folder,null,null,'one');
 saveRoster(c,[{id:'engineer',name:'工程師',provider:'codex',level:'worker'}]);
 const origin='https://unit.tail.test';
 const server=createServer({allowedLogin:'owner@example.test',origin,appHome:home,core:()=>{throw Error('No actual agents');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port+'/herdr/api/';
 const identity={'Tailscale-User-Login':'owner@example.test'};
 const initial=await(await fetch(base+'state?chat=one',{headers:identity})).json();
 const project=initial.project,id=randomUUID();
 const writes={...identity,Origin:origin,'X-Herdr-CSRF':initial.csrfToken};
 const upload=(content,extra={})=>fetch(base+'attachment?'+new URLSearchParams({project,chat:'one',id,slot:'0'}),{
  method:'POST',headers:{...writes,'Content-Type':'application/octet-stream',
   'X-Herdr-Filename':encodeURIComponent('核對 資料.txt'),...extra},body:content
 });
 const message=(chat,payload)=>fetch(base+'message',{method:'POST',headers:{...writes,'Content-Type':'application/json'},
  body:JSON.stringify({project,chat,id,text:'請讀取',agentId:'engineer',...payload})});
 assert.equal((await upload('answer = 42',{'X-Herdr-CSRF':'wrong'})).status,403);
 assert.equal((await upload('answer = 42',{Origin:'https://other.test'})).status,403);
 assert.equal((await message('one',{attachments:['核對_資料.txt']})).status,400);
 const first=await upload('answer = 42');
 assert.equal(first.status,201);const item=await first.json();
 assert.deepEqual(item,{name:'核對_資料.txt',size:11});
 assert.equal((await upload('answer = 42')).status,201);
 assert.equal((await upload('answer = 99')).status,409);
 assert.equal((await message('two',{attachments:[item.name]})).status,400);
 const result=await(await message('one',{attachments:[item.name]})).json();
 assert.equal(result.target,'engineer');assert.equal(result.queued,true);
 const queued=JSON.parse(fs.readFileSync(path.join(c.teamDir,'direct-queue',id+'.json'),'utf8'));
 const file=queued.text.match(/- `([^\n`]+)`/)?.[1];
 assert(file?.startsWith('Herdr 附件/'));
 assert.equal(fs.readFileSync(path.join(folder,file),'utf8'),'answer = 42');
 assert.equal(queued.allowAgentCreation,'when-alone');
 const query=new URLSearchParams({project,chat:'one'});
 const state=await(await fetch(base+'state?'+query,{headers:identity})).json();
 assert.equal(state.messages.length,1);
 query.set('messagesRevision',state.messagesRevision);
 const delta=await(await fetch(base+'state?'+query,{headers:identity})).json();
 assert.equal(Object.hasOwn(delta,'messages'),false);
 query.set('chat','two');
 const other=await(await fetch(base+'state?'+query,{headers:identity})).json();
 assert.deepEqual(other.messages,[]);
});
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
 const pushes=[];const server=createServer({pushSend:async(sub,payload)=>pushes.push(JSON.parse(payload)),projectRoot:path.join(dir,'new-projects'),allowedLogin:'owner@example.test',origin:'https://unit.tail.test',appHome:app,core:()=>{throw Error('No real core allowed');}});
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
 const ec=createECDH('prime256v1');ec.generateKeys();const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/unit-fixture',keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
 assert.equal((await fetch(base+'/api/notifications-key')).status,403);
 const publicReply=await(await fetch(base+'/api/notifications-key',{headers})).json();assert(publicReply.publicKey);assert(!('privateKey' in publicReply));
 assert.equal((await post('/api/notifications',{action:'subscribe',subscription},{'X-Herdr-CSRF':'wrong'})).status,403);
 assert.equal((await post('/api/notifications',{action:'subscribe',subscription},{Origin:'https://evil.test'})).status,403);
 assert.equal((await post('/api/notifications',{action:'subscribe',subscription,project:'unknown'})).status,404);
 assert.equal((await post('/api/notifications',{action:'subscribe',subscription:{...subscription,endpoint:'https://127.0.0.1/'}})).status,400);
 assert.equal((await post('/api/notifications',{action:'subscribe',subscription})).status,200);
 assert.equal((await(await post('/api/notifications',{action:'status',endpoint:subscription.endpoint})).json()).subscribed,true);
 const pushTest=await(await post('/api/notifications',{action:'test',endpoint:subscription.endpoint})).json();assert.equal(pushTest.acceptedByPushService,true);assert.equal(pushTest.deliveredToDevice,false);assert.equal(pushes.length,1);assert.equal(pushes[0].title,'Herdr · 測試通知');
 assert.equal((await post('/api/notifications',{action:'unsubscribe',endpoint:subscription.endpoint})).status,200);
 assert.equal((await(await post('/api/notifications',{action:'status',endpoint:subscription.endpoint})).json()).subscribed,false);
 assert.equal(data.projects[0].category,'');
 const cat=await(await post('/api/project',{name:'Categorized fixture',category:'Product'})).json();assert(cat.project);
 assert.equal((await post('/api/project-category',{action:'set',category:'Product'})).status,200);
 let categories=(await(await fetch(base+'/api/state?project='+data.project+'&chat='+data.chat,{headers})).json()).projects;
 assert.equal(categories.filter(p=>p.category==='Product').length,2);
 assert.equal((await post('/api/project-category',{action:'remove',category:'Stale'})).status,409);
 assert.equal((await post('/api/project-category',{action:'remove',category:'Product'})).status,200);
 categories=(await(await fetch(base+'/api/state?project='+data.project+'&chat='+data.chat,{headers})).json()).projects;
 assert.equal(categories.length,2);assert(categories.every(p=>p.category===''));
 const cancelId='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
 assert.equal((await post('/api/message',{id:cancelId,text:'Queued for cancellation',agentId:'member'})).status,200);
 assert.equal((await post('/api/task-action',{id:cancelId,action:'cancel',project:cat.project,chat:cat.chat})).status,409);
 assert.equal((await post('/api/task-action',{id:cancelId,action:'cancel'},{'X-Herdr-CSRF':'wrong'})).status,403);
 assert.equal((await(await post('/api/task-action',{id:cancelId,action:'cancel'})).json()).status,'cancelled');
 assert.equal((await(await post('/api/message',{id:cancelId,text:'Queued for cancellation',agentId:'member'})).json()).queued,false);
 assert.equal((await post('/api/message',{text:'do not send'}, {'X-Herdr-CSRF':'wrong'})).status,403);
 assert.equal((await post('/api/message',{text:'do not send'}, {Origin:'https://evil.test'})).status,403);
 assert.equal((await post('/api/message',{project:'unregistered',text:'do not send'})).status,404);
 const renamed=await (await post('/api/coordinator',{name:'  牧羊人總控  '})).json();assert.equal(renamed.name,'牧羊人總控');
 assert.equal((await (await fetch(base+'/api/state',{headers})).json()).coordinatorName,'牧羊人總控');
 assert.equal((await post('/api/coordinator',{name:'\n'})).status,400);
 const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',body={text:'@member Unit fixture only',id};
 const one=await (await post('/api/message',body)).json(),two=await (await post('/api/message',body)).json();assert(one.queued);assert.equal(one.id,two.id);
 const logs=fs.readFileSync(path.join(project,'.herdr-team/conversations/unit-chat/messages.jsonl'),'utf8').trim().split('\n');assert.equal(logs.length,2);
 assert.equal((await fetch(base+'/../../etc/passwd',{headers})).status,404);
 const agents=[...data.agents,{...data.agents[0],id:'frontend',name:'Frontend'}];
 const saved=await (await post('/api/roster',{agents})).json();assert.equal(saved.started,false);
 const next=await (await post('/api/chat',{})).json();assert.match(next.chat,/^web-/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(project,'.herdr-team/roster.json'))).length,2);
 assert.equal(JSON.parse(fs.readFileSync(path.join(app,'team-chat.json'))).chatId,next.chat);
 const created=await (await post('/api/project',{name:'New project'})).json();assert(created.project);assert(created.chat);
 const newState=await (await fetch(base+'/api/state?project='+created.project+'&chat='+created.chat,{headers})).json();assert.equal(newState.agents.length,1);assert.equal(newState.agents[0].id,'starter');assert.equal(newState.agents[0].name,'領頭羊');assert.equal(newState.agentWorkspace,true);assert.equal(newState.projects.length,3);
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
 const managementState=await(await fetch(base+'/api/state?project='+data.project+'&chat='+data.chat,{headers})).json();
 assert.equal((await post('/api/sidebar',{project:data.project,chat:data.chat,...managementState.sidebar,pinned:['frontend']})).status,200);
 assert.equal((await post('/api/sidebar',{project:data.project,chat:data.chat,...managementState.sidebar,pinned:[]})).status,409);
 const moveBody={project:data.project,chat:data.chat,action:'move',agentId:'frontend',targetProject:created.project,rosterRevision:managementState.rosterRevision};
 assert.equal((await post('/api/agent-manage',moveBody,{'X-Herdr-CSRF':'invalid'})).status,403);
 assert.equal((await post('/api/agent-manage',{...moveBody,targetProject:'unknown'})).status,404);
 assert.equal((await post('/api/agent-manage',moveBody)).status,200);
 const transferred=await(await fetch(base+'/api/state?project='+created.project+'&chat='+created.chat,{headers})).json();assert(transferred.agents.some(a=>a.id==='frontend'));assert(transferred.sidebar.pinned.includes('frontend'));
 assert.equal((await post('/api/agent-manage',{project:created.project,chat:created.chat,agentId:'frontend',action:'delete',rosterRevision:transferred.rosterRevision})).status,200);
 const afterDelete=await(await fetch(base+'/api/state?project='+created.project+'&chat='+created.chat,{headers})).json();assert(!afterDelete.agents.some(a=>a.id==='frontend'));assert(afterDelete.agents.some(a=>a.id==='starter'));
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

test('artifact preview is tied to accepted evidence and serves unchanged bytes with inert types',async t=>{
 const {createHash}=await import('node:crypto');
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'herdr-artifacts-'))),home=path.join(dir,'app'),folder=path.join(dir,'project');
 fs.mkdirSync(home);fs.mkdirSync(folder);
 const chats=['artifact-chat','other-chat'].map(id=>({id,title:id}));
 fs.writeFileSync(path.join(home,'shared.json'),JSON.stringify({'team-chat.projects':[{folder,name:'Artifacts',chats}]}));
 const contextFor=chat=>context(folder,null,null,chat);
 const output=Buffer.from('驗收完成\n');
 const digest=createHash('sha256').update(output).digest('hex');
 fs.writeFileSync(path.join(folder,'result.md'),output);
 fs.writeFileSync(path.join(dir,'elsewhere.md'),output);
 fs.symlinkSync(path.join(dir,'elsewhere.md'),path.join(folder,'linked.md'));
 const c=contextFor(chats[0].id);fs.mkdirSync(c.teamDir,{recursive:true});
 fs.writeFileSync(path.join(c.teamDir,'checklist.json'),JSON.stringify({items:[{id:'report',status:'done',evidence:[{path:'result.md',sha256:digest},{path:'linked.md',sha256:digest},{path:'../elsewhere.md',sha256:digest},{path:'.config/private.json',sha256:digest}]},{id:'pending',status:'pending',evidence:[{path:'result.md',sha256:digest}]}]}));
 const origin='https://unit.tail.test',headers={'Tailscale-User-Login':'owner@example.test'};
 const server=createServer({allowedLogin:headers['Tailscale-User-Login'],origin,appHome:home,driveRoot:folder});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 const state=await(await fetch(base+'/api/state?chat='+chats[0].id,{headers})).json();
 assert(state.checklist.items.find(x=>x.id==='report').artifacts.some(x=>x.name==='result.md'));
 const url=overrides=>base+'/api/artifact?'+new URLSearchParams({project:state.project,chat:chats[0].id,kind:'checklist',id:'report',index:'0',mode:'preview',...overrides});
 assert.equal((await fetch(url())).status,403);
 assert.equal((await fetch(url(),{headers:{...headers,Origin:'https://other.test'}})).status,403);
 assert.equal((await fetch(url({chat:chats[1].id}),{headers})).status,404);
 for(const index of ['1','2','3'])assert.equal((await fetch(url({index}),{headers})).status,404);
 assert.equal((await fetch(url({id:'pending'}),{headers})).status,404);
 const preview=await(await fetch(url(),{headers})).json();assert.equal(preview.text,output.toString());assert.equal(preview.canOpenInDrive,false);
 const driveURL=url({mode:'drive'});
 assert.equal((await fetch(driveURL,{headers,redirect:'manual'})).status,404);
 if(process.platform==='darwin'){
  const {execFileSync}=await import('node:child_process');
  execFileSync('/usr/bin/xattr',['-w','com.google.drivefs.item-id#S','verified_drive-artifact_ID',path.join(folder,'result.md')]);
  assert.equal((await(await fetch(url(),{headers})).json()).canOpenInDrive,true);
  const link=await fetch(driveURL,{headers,redirect:'manual'});
  assert.equal(link.status,302);assert.equal(link.headers.get('location'),'https://drive.google.com/file/d/verified_drive-artifact_ID/view');
  assert.equal((await fetch(url({chat:chats[1].id,mode:'drive'}),{headers,redirect:'manual'})).status,404);
 }
 const download=await fetch(url({mode:'download'}),{headers});assert.match(download.headers.get('content-disposition'),/^attachment/);assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.deepEqual(Buffer.from(await download.arrayBuffer()),output);
 fs.writeFileSync(path.join(folder,'result.md'),'Changed after verification');assert.equal((await fetch(url(),{headers})).status,409);
 assert.equal((await fetch(driveURL,{headers,redirect:'manual'})).status,409);
});

test('Drive original links require a valid provider ID for the same verified file inside the configured root',async t=>{
 const {createHash}=await import('node:crypto');const {driveArtifactLink,readArtifact}=await import('./artifacts.mjs');
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'artifact-drive-id-'))),drive=path.join(temp,'drive'),project=path.join(drive,'project');
 fs.mkdirSync(project,{recursive:true});t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const filename=path.join(project,'result.txt'),data='evidence';fs.writeFileSync(filename,data);
 const c={cwd:project},item=await readArtifact(c,{status:'done',evidence:[{path:'result.txt',sha256:createHash('sha256').update(data).digest('hex')}]},0);
 const id='test-GoogleDrive_ID-00001';
 assert.equal(await driveArtifactLink(c,item,drive,async name=>{assert.equal(name,filename);return id;}),'https://drive.google.com/file/d/'+id+'/view');
 assert.equal(await driveArtifactLink(c,item,drive,async()=>id+'?next=other'),null);
 assert.equal(await driveArtifactLink(c,item,path.join(temp,'drive-other'),()=>assert.fail()),null);
 assert.equal(await driveArtifactLink(c,item,drive,async()=>{fs.unlinkSync(filename);fs.writeFileSync(filename,data);return id;}),null);
});

test('project memory is shared across chats with a revision check and stays outside the project folder',async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'herdr-memory-'))),home=path.join(dir,'app'),folder=path.join(dir,'project');
 fs.mkdirSync(home);fs.mkdirSync(folder);
 fs.writeFileSync(path.join(home,'shared.json'),JSON.stringify({'team-chat.projects':[{folder,name:'Memory',chats:[{id:'alpha'},{id:'beta'}]}]}));
 const origin='https://unit.tail.test',headers={'Tailscale-User-Login':'owner@example.test'};
 const config={allowedLogin:headers['Tailscale-User-Login'],origin,appHome:home,headless:true,stateRoot:path.join(home,'private'),legacyProjects:[folder]};
 const server=createServer(config);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 const state=async chat=>await(await fetch(base+'/api/state?chat='+chat,{headers})).json();
 const initial=await state('alpha');assert.deepEqual(initial.projectMemory,{revision:0,text:''});
 const save=(revision,text)=>fetch(base+'/api/project-memory',{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json','X-Herdr-CSRF':initial.csrfToken},body:JSON.stringify({project:initial.project,chat:'alpha',revision,text})});
 assert.equal((await save(0,'每份成果需附測試結果')).status,200);
 assert.equal((await save(0,'Old edit')).status,409);
 assert.equal((await state('beta')).projectMemory.text,'每份成果需附測試結果');
 const {teamBrief}=await import('../team-runtime.mjs');assert.match(teamBrief(context(folder,null,null,'beta',config)),/每份成果需附測試結果/);
 assert.equal((await save(1,'')).status,200);assert.equal((await state('beta')).projectMemory.text,'');
 assert.equal(fs.existsSync(path.join(folder,'.herdr-team','project-memory.json')),false);
});

test('conversation usage counts matching observed deliveries and replies without guessing an engine',async()=>{
 const {conversationUsage}=await import('./usage.mjs');
 const delivered={kind:'delivery',delivery:'sent',messageId:'d',target:'engineer',direct:true,provider:'codex'};
 const reply={kind:'reply',replyTo:'d',target:'engineer',direct:true};
 const events=[delivered,delivered,{...delivered,messageId:'other',provider:'?'},{...reply,target:'another'},reply,reply,{...delivered,messageId:'q',delivery:'queued'}];
 assert.deepEqual(conversationUsage(events),[{provider:'codex',delivered:1,replies:1},{provider:'unknown',delivered:1,replies:0}]);
});
