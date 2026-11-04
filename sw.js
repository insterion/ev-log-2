'use strict';
/* EV Log 2.0 v0.7.0 — stable source names, versioned cache entries.
   Network-first for online updates. IndexedDB is never cached/uploaded. */
const CACHE_NAME='ev-log-2-shell-v070';
const PREFIX='ev-log-2-shell-';
const SHELL=['./','./index.html','./styles.css?v=070','./app.js?v=070','./legacy-import.js?v=070','./manifest.json','./icon-192.png','./icon-512.png'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const names=await caches.keys();
    await Promise.all(names.filter(name=>name.startsWith(PREFIX) && name!==CACHE_NAME).map(name=>caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  const scopePath=new URL(self.registration.scope).pathname;
  if(url.origin!==self.location.origin || !url.pathname.startsWith(scopePath))return;
  event.respondWith((async()=>{
    try{
      const response=await fetch(req);
      if(response.ok){const cache=await caches.open(CACHE_NAME);await cache.put(req,response.clone());}
      return response;
    }catch(_){
      const cached=await caches.match(req);
      if(cached)return cached;
      if(req.mode==='navigate')return(await caches.match('./index.html')) || Response.error();
      return Response.error();
    }
  })());
});
