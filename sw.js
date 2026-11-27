// Keeps the last loaded copy so the tower still opens on weak wifi. Fresh files win whenever the network answers.
// Only this site's own files are handled here; the live database connection goes straight to the network.
const C="wine-tower-v18";
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET"||new URL(e.request.url).origin!==location.origin) return;
  e.respondWith(fetch(e.request).then(r=>{
    if(r.ok){ const c=r.clone(); caches.open(C).then(x=>x.put(e.request,c)); }
    return r;
  }).catch(()=>caches.match(e.request,{ignoreSearch:true})));
});

// Lock-screen alerts from the Toast relay ("Heads up, Somm! Grab ... for Table 12!"). Tapping one opens the tower at that slot;
// on Android the "Got it" button marks the bottle pulled without opening the app.
self.addEventListener("push",e=>{
  let d={}; try{ d=e.data?e.data.json():{}; }catch(x){ try{ d={body:e.data.text()}; }catch(y){} }
  const db=/^https:\/\/[a-z0-9-]+\.firebaseio\.com$/.test(d.db||"")?d.db:null;
  const o={body:d.body||"A bottle was just ordered.",tag:d.tag||"pull",renotify:true,icon:"icon-192.png",timestamp:Date.now(),data:{url:d.url||"./",id:d.id||null,slot:d.slot||null,db}};
  if(d.id&&db) o.actions=[{action:"got",title:"Got it"}];
  e.waitUntil(self.registration.showNotification(d.title||"Heads up, Somm!",o));
});
self.addEventListener("notificationclick",e=>{
  const n=e.notification, d=n.data||{}; n.close();
  if(e.action==="got"&&d.id&&d.db){ e.waitUntil(fetch(d.db+"/pulls/"+encodeURIComponent(d.id)+"/got.json",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({".sv":"timestamp"})}).catch(()=>{})); return; }
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(ws=>{
    const w=ws.find(c=>new URL(c.url).origin===location.origin);
    if(w){ if(d.slot) w.postMessage({pull:d.slot}); return w.focus(); }
    return self.clients.openWindow(new URL(d.url||"./",self.registration.scope).href);
  }));
});
