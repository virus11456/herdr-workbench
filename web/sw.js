const CACHE='herdr-shell-v28';
const base=new URL('./',self.location.href);
const shell=['./','./style.css','./app.js','./format.mjs','./viewport.mjs','./activity.mjs','./tasks.mjs','./style.css?v=20261120-work28','./app.js?v=20261120-work28','./sheep.svg','./shepherd.svg','./app-icon.svg','./icon-192.png','./icon-512.png','./apple-touch-icon.png','./manifest.webmanifest'];
const allowed=new Set(shell.map(p=>new URL(p,base).href));
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);await cache.addAll(shell.map(p=>new Request(new URL(p,base),{cache:'reload'})));await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const name of await caches.keys())if(name.startsWith('herdr-shell-')&&name!==CACHE)await caches.delete(name);
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 // In particular, never cache /api, authentication, other apps, or POSTs; never queue tasks offline.
 if(request.method!=='GET'||url.origin!==base.origin||!allowed.has(url.href))return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  try{const response=await fetch(request);if(response.ok)await cache.put(request,response.clone());return response;}
  catch(error){const saved=await cache.match(request);if(saved)return saved;throw error;}
 })());
});

self.addEventListener('push',event=>{event.waitUntil((async()=>{let data={};try{data=event.data?.json()||{};}catch{}const url=new URL(data.url||'./',base);const safe=url.origin===base.origin&&url.pathname===base.pathname?url.href:base.href;await self.registration.showNotification(data.title==='Herdr · 測試通知'?data.title:'Herdr · 需要你確認',{body:data.title==='Herdr · 測試通知'?'通知通道測試，沒有啟動代理或送出任務。':'有代理等待登入、信任或權限確認。請回工作台查看。',icon:new URL('./icon-192.png',base).href,tag:String(data.tag||'herdr-attention').slice(0,80),data:{url:safe}});})());});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{const url=new URL(event.notification.data?.url||'./',base);if(url.origin!==base.origin||url.pathname!==base.pathname)return;const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of windows){const current=new URL(client.url);if(current.origin===base.origin&&current.pathname===base.pathname){await client.navigate(url.href);await client.focus();return;}}await self.clients.openWindow(url.href);})());});
