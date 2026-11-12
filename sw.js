// Keeps the last loaded copy so the tower still opens on weak wifi. Fresh files win whenever the network answers.
// Only this site's own files are handled here; the live database connection goes straight to the network.
const C="wine-tower-v2";
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET"||new URL(e.request.url).origin!==location.origin) return;
  e.respondWith(fetch(e.request).then(r=>{
    if(r.ok){ const c=r.clone(); caches.open(C).then(x=>x.put(e.request,c)); }
    return r;
  }).catch(()=>caches.match(e.request,{ignoreSearch:true})));
});
