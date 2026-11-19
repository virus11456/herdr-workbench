const CACHE='herdr-shell-v3';
const base=new URL('./',self.location.href);
const shell=['./','./style.css','./app.js','./format.mjs','./sheep.svg','./shepherd.svg','./app-icon.svg','./icon-192.png','./icon-512.png','./apple-touch-icon.png','./manifest.webmanifest'];
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
