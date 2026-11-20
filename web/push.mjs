import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import * as webpush from 'web-push';import {attentionItems} from './tasks.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
export function validateSubscription(value){
 if(!value||typeof value.endpoint!=='string'||value.endpoint.length>4096)throw Error('無效的通知訂閱。');
 const u=new URL(value.endpoint),allowed=['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'];
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!(allowed.includes(u.hostname)||u.hostname.endsWith('.push.apple.com')||u.hostname.endsWith('.notify.windows.com')))throw Error('不支援的通知服務。');
 const {p256dh,auth}=value.keys||{};if(!/^[A-Za-z0-9_-]{87}={0,1}$/.test(p256dh||'')||!/^[-_A-Za-z0-9]{22}={0,2}$/.test(auth||''))throw Error('無效的通知加密金鑰。');
 if(Buffer.from(p256dh,'base64url').length!==65||Buffer.from(auth,'base64url').length!==16)throw Error('無效的通知加密金鑰。');
 return{endpoint:u.href,keys:{p256dh,auth}};
}
export function createPushStore({home,origin,send=webpush.sendNotification.bind(webpush),now=()=>Date.now()}){
 const dir=path.join(home,'notifications'),file=path.join(dir,'subscriptions.json'),keyfile=path.join(dir,'vapid.json');
 const read=(f,fallback)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
 const save=(f,v)=>{fs.mkdirSync(dir,{recursive:true,mode:0o700});const tmp=f+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v),{mode:0o600});fs.renameSync(tmp,f);};
 const keys=()=>{let k=read(keyfile,null);if(!k){k=webpush.generateVAPIDKeys();save(keyfile,k);}return k;};
 const list=()=>read(file,[]);let running=false;
 function add(subscription,project,chat){const sub=validateSubscription(subscription),rows=list(),id=digest(sub.endpoint),old=rows.find(s=>s.id===id);if(!old&&rows.length>=32)throw Error('通知裝置已達上限。');const scopes=old?.scopes||[];if(!scopes.some(s=>s.project===project&&s.chat===chat)){if(scopes.length>=64)throw Error('此裝置的通知對話已達上限。');scopes.push({project,chat});}const item={...old,id,subscription:sub,scopes,seen:old?.seen||{},updatedAt:now()};save(file,[...rows.filter(s=>s.id!==id),item]);return{id,subscribed:true};}
 function remove(endpoint){const rows=list(),id=digest(String(endpoint));save(file,rows.filter(s=>s.id!==id));return{unsubscribed:true};}
 function status(endpoint,project,chat){const own=list().find(s=>s.id===digest(String(endpoint)));return{subscribed:!!own?.scopes.some(s=>s.project===project&&s.chat===chat),scopeCount:own?.scopes.length||0,lastSentAt:own?.lastSentAt||null,lastError:own?.lastError||null};}
 async function sendOne(row,payload){const k=keys();await send(row.subscription,JSON.stringify(payload),{vapidDetails:{subject:origin,publicKey:k.publicKey,privateKey:k.privateKey},TTL:300,urgency:'normal',timeout:8000,contentEncoding:'aes128gcm'});}
 async function test(endpoint,project,chat){const row=list().find(s=>s.id===digest(String(endpoint)));if(!row?.scopes.some(s=>s.project===project&&s.chat===chat))throw Error('請先在此裝置開啟這段對話的通知。');await sendOne(row,{title:'Herdr · 測試通知',body:'通知通道測試，沒有啟動代理或送出任務。',url:'/herdr/?'+new URLSearchParams({project,chat}),tag:'herdr-test'});return{acceptedByPushService:true,deliveredToDevice:false};}
 async function tick(getState){if(running)return;running=true;try{const rows=list();if(!rows.length)return;const states=new Map();for(const row of rows){if(row.retryAt>now())continue;const active=new Set();let failed=false,expired=false,unknown=[];
  for(const scope of row.scopes){const key=scope.project+':'+scope.chat;if(!states.has(key)){try{states.set(key,await getState(scope));}catch{states.set(key,null);}}const state=states.get(key);if(!state||state.coreError){unknown.push(key);continue;}
   for(const a of attentionItems(state)){const event=key+':'+a.id;active.add(event);if(row.seen[event])continue;try{await sendOne(row,{title:'Herdr · 需要你確認',body:'有代理等待登入、信任或權限確認。請回工作台查看。',tag:'herdr-'+digest(event).slice(0,24),url:'/herdr/?'+new URLSearchParams({project:scope.project,chat:scope.chat,...(a.agentId?{agent:a.agentId}:{})})});row.seen[event]=now();row.lastSentAt=now();delete row.lastError;delete row.retryAt;}catch(error){if([404,410].includes(error.statusCode))expired=true;else{row.lastError='通知服務暫時無法送出，稍後重試。';row.retryAt=now()+60000;}failed=true;break;}}
   if(failed)break;
  }
  if(!failed)for(const event of Object.keys(row.seen))if(!active.has(event)&&!unknown.some(k=>event.startsWith(k+':')))delete row.seen[event];
  // Re-read before writing: subscription changes while awaiting a push must survive.
  const current=list(),live=current.find(s=>s.id===row.id);if(!live)continue;if(expired)save(file,current.filter(s=>s.id!==row.id));else save(file,current.map(s=>s.id===row.id?{...s,seen:row.seen,lastSentAt:row.lastSentAt,lastError:row.lastError,retryAt:row.retryAt}:s));
 }}finally{running=false;}}
 return{publicKey:()=>keys().publicKey,add,remove,status,test,tick};
}
