import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import{randomUUID}from'node:crypto';import{requestJSON,createClientUpgrade,newerBuild,confirmedSend,settledDraft}from'./client.mjs';import{createServer}from'./server.mjs';import{context,saveRoster}from'../team-runtime.mjs';
const empty=()=>new Response('',{status:200});
test('empty and truncated reads retry once, use no-store, and do not leak parser errors',async()=>{
 for(const bad of[empty,()=>new Response('{"projects":'),()=>({headers:new Headers(),text:async()=>{throw new TypeError('body terminated');}})]){
  const calls=[];const value=await requestJSON('history',{wait:async()=>{},fetch:async(_url,options)=>{calls.push(options);return calls.length===1?bad():Response.json({messages:[]});}});assert.deepEqual(value,{messages:[]});assert.equal(calls.length,2);assert(calls.every(c=>c.method==='GET'&&c.cache==='no-store'));
 }
 let calls=0;await assert.rejects(requestJSON('state',{wait:async()=>{},fetch:async()=>{calls++;return empty();}}),/主機回應不完整/);assert.equal(calls,2);
});
test('a lost write response is uncertain, never replayed, and retains the supplied ID',async()=>{
 for(const fetch of[async()=>empty(),async()=>{throw new TypeError('failed');}]){let calls=0;const id=randomUUID();await assert.rejects(requestJSON('message',{scope:{project:'p',chat:'c'},data:{id,text:'保留草稿'},csrfToken:'token',fetch:async(url,options)=>{calls++;assert.deepEqual(JSON.parse(options.body),{project:'p',chat:'c',id,text:'保留草稿'});return fetch();}}),e=>e.uncertain===true&&!e.message.includes('Unexpected'));assert.equal(calls,1);}
});
test('malformed state and JSON arrays cannot replace the current state snapshot',async()=>{
 for(const data of[null,[],{}, {projects:[],agents:[]}]){let calls=0;await assert.rejects(requestJSON('state?project=p',{wait:async()=>{},fetch:async()=>{calls++;return Response.json(data);}}),/不完整/);assert.equal(calls,2);}
});
test('native parser error text is replaced with a recovery instruction and never retried as a write',async()=>{
 let calls=0;await assert.rejects(requestJSON('roster',{data:{agents:[]},fetch:async()=>{calls++;return Response.json({error:"Failed to execute 'json' on 'Response': Unexpected end of JSON input"},{status:400});}}),e=>e.message.includes('先核對')&&!e.message.includes('Unexpected'));assert.equal(calls,1);
});
function upgradeFixture(){const map=new Map(),state={ready:true},events=[];const storage={getItem:key=>map.get(key),setItem:(key,value)=>map.set(key,value)};let saved=true;const controller=createClientUpgrade({build:'20261123-idle62',status:()=>state,saveDraft:()=>{events.push('save-draft');return saved;},storage,reload:()=>events.push('reload')});return{controller,state,map,events,storage,failSave:()=>saved=false};}
test('upgrade saves the draft before one reload, ignores old or invalid builds, and bounds reload attempts',()=>{
 assert(newerBuild('20261123-idle62','20261124-client63'));assert(!newerBuild('20261124-client63','20261123-idle62'));const f=upgradeFixture();for(const b of['20261123-idle62','20261122-report58','garbage','https://evil.test/'])f.controller.observe(b);assert(!f.controller.attempt());f.controller.observe('20261124-client63');assert(f.controller.attempt());assert.deepEqual(f.events,['save-draft','reload']);assert(!f.controller.attempt());
 const second=createClientUpgrade({build:'20261123-idle62',status:()=>({ready:true}),saveDraft:()=>{throw Error('must not loop');},storage:f.storage,reload:()=>assert.fail('reload loop')});second.observe('20261124-client63');assert(!second.attempt());
});
for(const flag of['hidden','offline','posting','navigating','attachments','dialog','pending','editing','readingHistory'])test('upgrade preserves active work while '+flag,()=>{
 const f=upgradeFixture();f.controller.observe('20261124-client63');f.state[flag]=true;assert(!f.controller.attempt());assert.equal(f.events.length,0);f.state[flag]=false;assert(f.controller.attempt());assert.deepEqual(f.events,['save-draft','reload']);
});
test('failed or unavailable draft storage prevents automatic reload',()=>{
 const f=upgradeFixture();f.failSave();f.controller.observe('20261124-client63');assert(!f.controller.attempt());assert(!f.events.includes('reload'));const g=upgradeFixture();g.storage.setItem=()=>{throw Error('storage full');};g.controller.observe('20261124-client63');assert(!g.controller.attempt());assert(!g.events.includes('reload'));
});
test('newer response headers request an upgrade without affecting read results',async()=>{
 const observed=[];const value=await requestJSON('history',{onBuild:b=>observed.push(b),fetch:async()=>Response.json({messages:[]},{headers:{'X-Herdr-UI-Build':'20261124-client63'}})});assert.deepEqual(value,{messages:[]});assert.deepEqual(observed,['20261124-client63']);
});
test('real server response loss followed by explicit same-ID retry creates only one queued task',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'herdr-client63-'))),home=path.join(root,'home'),folder=path.join(root,'project');fs.mkdirSync(home);fs.mkdirSync(folder);fs.writeFileSync(path.join(home,'shared.json'),JSON.stringify({'team-chat.projects':[{folder,name:'Client fixture',chats:[{id:'one'}]}]}));
 const c=context(folder,null,null,'one');saveRoster(c,[{id:'engineer',name:'工程師',provider:'codex',level:'worker'}]);const coreCalls=[],origin='https://unit.tail.test';const server=createServer({appHome:home,origin,allowedLogin:'owner@example.test',core:args=>{coreCalls.push(args[0]);throw Error('No actual agents');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port+'/herdr/',identity={'Tailscale-User-Login':'owner@example.test'},s=await(await fetch(base+'api/state?chat=one',{headers:identity})).json(),id=randomUUID();let posts=0;const fetcher=async(url,options)=>{const response=await fetch(base+url.slice(2),{...options,headers:{...options.headers,...identity,Origin:origin}});if(options.method==='POST'&&++posts===1){await response.text();return empty();}return response;};const options={scope:{project:s.project,chat:'one'},data:{id,text:'一次送出驗收',agentId:'engineer'},csrfToken:s.csrfToken,fetch:fetcher};
 await assert.rejects(requestJSON('message',options),e=>e.uncertain);assert.equal(posts,1);const confirmedState=await(await fetch(base+'api/state?chat=one',{headers:identity})).json();assert.equal(confirmedSend({project:s.project,chat:'one',id,agentId:'engineer'},confirmedState),'queued');assert.equal(posts,1);const result=await requestJSON('message',options);assert(result.queued);assert.equal(posts,2);const rows=fs.readFileSync(path.join(c.teamDir,'messages.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.filter(r=>r.kind==='user'&&r.messageId===id).length,1);assert.equal(fs.readdirSync(path.join(c.teamDir,'direct-queue')).filter(n=>n.endsWith('.json')).length,1);assert(!coreCalls.some(x=>['run','send','kill','keys'].includes(x)));
});

test('lost acknowledgements reconcile only from the exact project, chat, message and recipient',()=>{
 const pending={project:'p',chat:'c',id:'m',agentId:'engineer'},state={project:'p',chat:'c',messages:[{kind:'user',direct:true,target:'engineer',messageId:'m'}]};assert.equal(confirmedSend(pending,state),'queued');for(const change of[{project:'other'},{chat:'other'},{id:'other'},{agentId:'other'},{agentId:null}])assert.equal(confirmedSend({...pending,...change},state),null);state.messages.push({kind:'reply',direct:true,target:'engineer',replyTo:'m'});assert.equal(confirmedSend(pending,state),'replied');
});

test('confirmed sends clear only their own unchanged draft and preserve newer text and attachments',()=>{
 const old={name:'old'},added={name:'new'},value={pendingId:'m',messageId:'m',currentText:'sent',sentText:'sent',currentFiles:[old],sentFiles:[old]};assert.deepEqual(settledDraft(value),{files:[],clearText:true});assert.deepEqual(settledDraft({...value,currentText:'new text'}),{files:[old],clearText:false});assert.deepEqual(settledDraft({...value,pendingId:'new-message'}),{files:[old],clearText:false});assert.deepEqual(settledDraft({...value,currentFiles:[old,added]}),{files:[added],clearText:false});
});
