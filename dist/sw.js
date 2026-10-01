/* Squidify caches only its own app shell. Audio is in device-local IndexedDB. */
const VERSION = 'squidify-shell-v30';
const SHELL = ['./','./index.html','./styles.css','./app.js','./context.js','./audio-output.js','./interface.js','./gestures.js','./import.js','./playlists.js','./playback.js','./playback-report.js','./offline.js','./release.js','./motion.js','./enhancements.js','./spectrum.js','./bricolage-700.ttf','./bricolage-800.ttf','./core.js','./storage.js','./metadata.js','./icons.js','./squid-mark-v9.png','./manifest.webmanifest','./apple-touch-icon.png','./apple-touch-icon.png?v=10','./apple-touch-icon-precomposed.png','./apple-touch-icon-precomposed.png?v=10','./favicon.ico','./icon-192-v9.png','./icon-512-v9.png','./icon-maskable-v9.png','./apple-touch-icon-v9.png','./favicon-32-v9.png'];
const absolute = path => new URL(path,self.registration.scope).href;
const shellURLs = new Set(SHELL.map(absolute));
const navigationPaths = new Set([new URL(absolute('./')).pathname,new URL(absolute('./index.html')).pathname]);
function cleanResponse(response) {
  // Fetch follows redirects but keeps their URL history on the Response. Safari
  // rejects that history when a cached document answers a Home Screen navigation.
  // A readable, synthetic response preserves the content without that history.
  if(!response || response.status===0)return response;
  const headers=new Headers(response.headers);
  headers.delete('content-encoding');headers.delete('content-length');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
async function repairPreviousShells() {
  // Fix response metadata in already-installed shells too, so their next launch
  // can recover while this update waits. Music/playlists in IndexedDB are untouched.
  for(const key of await caches.keys()) {
    if(!key.startsWith('squidify-shell-')||key===VERSION)continue;
    const cache=await caches.open(key);
    for(const url of shellURLs) {
      const response=await cache.match(url);
      if(response?.redirected)await cache.put(url,cleanResponse(response));
    }
  }
}
async function cacheShell(cache, onlyMissing = false) {
  const responses = await Promise.all(SHELL.map(async path=>{
    const url=absolute(path);
    if(onlyMissing && await cache.match(url))return null;
    const response=await fetch(new Request(url,{cache:'reload',credentials:'same-origin'}));
    if(!response.ok)throw new Error('App asset is unavailable: '+path);
    if(path.endsWith('.js') && (response.headers.get('content-type')||'').includes('text/html'))throw new Error('App script returned a sign-in page.');
    if(path==='./index.html' && !(await response.clone().text()).includes('id="audio"'))throw new Error('App page is not available yet.');
    return {url,response:cleanResponse(response)};
  }));
  for(const item of responses)if(item)await cache.put(item.url,item.response);
}

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    await repairPreviousShells();
    const cache=await caches.open(VERSION);
    // An interrupted installation never activates an incomplete offline shell.
    await cacheShell(cache);
    const updated=(await caches.keys()).some(key=>key.startsWith('squidify-shell-')&&key!==VERSION);
    await cache.put(absolute('./.installed-release'),new Response(JSON.stringify({updated}),{headers:{'content-type':'application/json'}}));
    // Updates wait for existing app windows to close. Do not take over a live
    // session while a native file picker (or music playback) is in progress.
  })());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const key of await caches.keys())if(key.startsWith('squidify-shell-')&&key!==VERSION)await caches.delete(key);
    // New navigations use this worker. Already-open pages keep their controller.
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  if(request.mode==='navigate'){
    // Leave sign-in callbacks and other hosting routes to the network.
    if(!navigationPaths.has(url.pathname))return;
    event.respondWith((async()=>{
      const cache=await caches.open(VERSION);
      // The installed shell always opens immediately, including offline launches.
      const shell=await cache.match(absolute('./index.html'))||await cache.match(absolute('./'));
      if(shell)return cleanResponse(shell);
      return cleanResponse(await fetch(request));
    })());return;
  }
  url.search='';url.hash='';
  if(shellURLs.has(url.href))event.respondWith((async()=>{
    const cache=await caches.open(VERSION);
    const cached=await cache.match(url.href);
    return cleanResponse(cached||await fetch(request));
  })());
});
self.addEventListener('message',event=>{
  if(!['CHECK_OFFLINE','REPAIR_OFFLINE'].includes(event.data?.type))return;
  event.waitUntil((async()=>{
    const cache=await caches.open(VERSION);
    if(event.data.type==='REPAIR_OFFLINE')try{await cacheShell(cache,true);}catch{}
    const cached=await Promise.all(SHELL.map(path=>cache.match(absolute(path))));
    const installed=await cache.match(absolute('./.installed-release'));
    const updated=installed?!!(await installed.json()).updated:false;
    event.ports[0]?.postMessage({ready:cached.every(Boolean),version:VERSION,updated});
  })());
});
