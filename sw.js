// Keeps the last loaded copy so the tower still opens on weak wifi. Fresh data wins whenever the network answers.
const C="wine-tower-v1";
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET") return;
  e.respondWith(fetch(e.request).then(r=>{
    if(r.ok&&new URL(e.request.url).origin===location.origin){ const c=r.clone(); caches.open(C).then(x=>x.put(e.request,c)); }
    return r;
  }).catch(()=>caches.match(e.request,{ignoreSearch:true})));
});
