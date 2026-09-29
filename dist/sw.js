/* Squidify caches only its own app shell. Audio is in device-local IndexedDB. */
const VERSION = 'squidify-shell-v1';
const SHELL = ['./','./index.html','./styles.css','./app.js','./core.js','./storage.js','./metadata.js','./icons.js','./manifest.webmanifest','./icon-192.png','./icon-512.png','./icon-maskable.png'];
const absolute = path => new URL(path,self.registration.scope).href;
const shellURLs = new Set(SHELL.map(absolute));
async function cacheShell(cache, onlyMissing = false) {
  const responses = await Promise.all(SHELL.map(async path=>{
    const url=absolute(path);
    if(onlyMissing && await cache.match(url))return null;
    const response=await fetch(new Request(url,{cache:'reload',credentials:'same-origin'}));
    if(!response.ok)throw new Error('App asset is unavailable: '+path);
    if(path.endsWith('.js') && (response.headers.get('content-type')||'').includes('text/html'))throw new Error('App script returned a sign-in page.');
    if(path==='./index.html' && !(await response.clone().text()).includes('id="audio"'))throw new Error('App page is not available yet.');
    return {url,response};
  }));
  for(const item of responses)if(item)await cache.put(item.url,item.response);
}

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(VERSION);
    // An interrupted installation never activates an incomplete offline shell.
    await cacheShell(cache);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const key of await caches.keys())if(key.startsWith('squidify-shell-')&&key!==VERSION)await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  if(request.mode==='navigate'){
    event.respondWith((async()=>{
      const cache=await caches.open(VERSION);
      // The installed shell always opens immediately, including offline launches.
      const shell=await cache.match(absolute('./index.html'))||await cache.match(absolute('./'));
      if(shell)return shell;
      return fetch(request);
    })());return;
  }
  url.search='';url.hash='';
  if(shellURLs.has(url.href))event.respondWith((async()=>{
    const cache=await caches.open(VERSION);
    const cached=await cache.match(url.href);
    return cached||fetch(request);
  })());
});
self.addEventListener('message',event=>{
  if(!['CHECK_OFFLINE','REPAIR_OFFLINE'].includes(event.data?.type))return;
  event.waitUntil((async()=>{
    const cache=await caches.open(VERSION);
    if(event.data.type==='REPAIR_OFFLINE')try{await cacheShell(cache,true);}catch{}
    const cached=await Promise.all(SHELL.map(path=>cache.match(absolute(path))));
    event.ports[0]?.postMessage({ready:cached.every(Boolean),version:VERSION});
  })());
});
