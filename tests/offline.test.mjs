import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
const base=new URL('../dist/',import.meta.url);
const origin='https://squidify.example/';
async function workerHarness(redirectedShell=null){
  const listeners={},stores=new Map();let offline=false,failPath=null,networkCalls=0,claimed=false,skipped=false;
  const caches={keys:async()=>[...stores.keys()],delete:async name=>stores.delete(name),open:async name=>{
    if(!stores.has(name))stores.set(name,new Map());const store=stores.get(name);
    return {match:async key=>store.get(typeof key==='string'?key:key.url)?.clone(),put:async(key,response)=>{store.set(typeof key==='string'?key:key.url,response.clone());}};
  }};
  const fetch=async request=>{
    networkCalls++;if(offline)throw new TypeError('Offline');const url=new URL(typeof request==='string'?request:request.url);
    if(url.pathname===failPath)return new Response('Missing',{status:404});
    if(redirectedShell&&['/','/index.html'].includes(url.pathname))return redirectedShell.clone();
    const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    return new Response(await readFile(new URL(file,base)),{headers:{'content-type':file.endsWith('.js')?'application/javascript':file.endsWith('.html')?'text/html':'application/octet-stream'}});
  };
  const self={registration:{scope:origin},location:{origin:new URL(origin).origin},addEventListener:(name,handler)=>listeners[name]=handler,skipWaiting:async()=>{skipped=true;},clients:{claim:async()=>{claimed=true;}}};
  vm.runInNewContext(await readFile(new URL('sw.js',base),'utf8'),{self,caches,fetch,Request,Response,Headers,URL,Set,Promise});
  const lifecycle=async type=>{let promise;listeners[type]({waitUntil:p=>{promise=p;}});await promise;};
  const request=async(path,navigate=false)=>{let response;listeners.fetch({request:{method:'GET',url:new URL(path,origin).href,mode:navigate?'navigate':'cors'},respondWith:p=>response=p});return response?await response:null;};
  const message=async type=>{let pending,result;listeners.message({data:{type},ports:[{postMessage:r=>result=r}],waitUntil:p=>pending=p});await pending;return result;};
  return {lifecycle,request,message,stores,setOffline:value=>offline=value,setFail:path=>failPath=path,get networkCalls(){return networkCalls;},get claimed(){return claimed;},get skipped(){return skipped;}};
}
async function redirectedDocument(t) {
  const html=await readFile(new URL('index.html',base));
  const server=createServer((req,res)=>{
    if(req.url==='/index.html'){res.writeHead(302,{location:'/'});res.end();}
    else {res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/index.html`);
  assert.equal(response.redirected,true,'fixture must carry real Fetch redirect history');
  return response;
}
test('a real HTTP redirect is stripped before caching and serving Home Screen navigation',async t=>{
  const redirected=await redirectedDocument(t),w=await workerHarness(redirected);
  await w.lifecycle('install');await w.lifecycle('activate');w.setOffline(true);
  const response=await w.request('/',true);
  assert.equal(response.redirected,false);assert.equal(response.url,'');assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/text\/html/);assert.match(await response.text(),/id="audio"/);
  for(const [url,cached] of [...w.stores.values()][0])assert.equal(cached.redirected,false,url);
});
test('install repairs redirect history in the previous shell before waiting for activation',async t=>{
  const redirected=await redirectedDocument(t),w=await workerHarness();
  w.stores.set('squidify-shell-v2',new Map([[origin,redirected.clone()],[origin+'index.html',redirected.clone()]]));
  await w.lifecycle('install');
  const old=w.stores.get('squidify-shell-v2');assert.ok(old,'old shell remains usable until activation');
  assert.equal(old.get(origin).redirected,false);assert.equal(old.get(origin+'index.html').redirected,false);
  assert.match(await old.get(origin+'index.html').clone().text(),/id="audio"/);
  assert.equal(w.claimed,false);assert.equal(w.skipped,false);
});
test('hosting and authentication navigations are not replaced with the offline app',async()=>{
  const w=await workerHarness();await w.lifecycle('install');
  assert.equal(await w.request('/auth/callback?code=example',true),null);
  assert.equal(await w.request('/some-hosting-route',true),null);
});
test('complete installed shell launches and serves all modules with the network disabled',async()=>{
  const w=await workerHarness();await w.lifecycle('install');await w.lifecycle('activate');assert.equal(w.claimed,false,'do not take over an open file picker');assert.equal(w.skipped,false,'updates wait for existing windows to close');
  w.setOffline(true);const count=w.networkCalls;
  assert.match(await (await w.request('/?home=1',true)).text(),/id="audio"/);
  for(const path of ['app.js','context.js','interface.js','gestures.js','import.js','playlists.js','playback.js','offline.js','release.js','motion.js','styles.css','core.js','storage.js','metadata.js','icons.js','manifest.webmanifest','icon-192-v9.png','icon-512-v9.png','icon-maskable-v9.png','apple-touch-icon-v9.png','favicon-32-v9.png'])assert.equal((await w.request(path)).status,200,path);
  assert.equal(w.networkCalls,count);assert.equal((await w.message('CHECK_OFFLINE')).ready,true);
  assert.equal(await w.request('https://other.example/analytics.js'),null);
});
test('an incomplete installation does not activate or report offline readiness',async()=>{
  const w=await workerHarness();w.setFail('/core.js');await assert.rejects(w.lifecycle('install'));assert.equal(w.skipped,false);assert.equal((await w.message('CHECK_OFFLINE')).ready,false);
});
test('readiness detects an evicted asset, and an online check repairs it',async()=>{
  const w=await workerHarness();await w.lifecycle('install');const store=[...w.stores.values()][0];store.delete(origin+'core.js');
  assert.equal((await w.message('CHECK_OFFLINE')).ready,false);assert.equal((await w.message('REPAIR_OFFLINE')).ready,true);
  w.setOffline(true);assert.equal((await w.request('core.js')).status,200);
});
test('manifest and runtime files stay fully packaged without CDN dependencies',async()=>{
  const manifest=JSON.parse(await readFile(new URL('manifest.webmanifest',base),'utf8'));assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'./');
  for(const image of manifest.icons)await access(new URL(image.src,base));
  const html=await readFile(new URL('index.html',base),'utf8');assert.doesNotMatch(html,/(?:src|href)="https?:\/\//);
  for(const file of ['app.js','context.js','interface.js','gestures.js','import.js','playlists.js','playback.js','offline.js','release.js','motion.js','core.js','metadata.js','storage.js','icons.js','sw.js'])new vm.Script((await readFile(new URL(file,base),'utf8')).replace(/^import .+;\n/gm,'').replace(/^export \{[^\n]+\};\n/gm,'').replace(/export /g,''),{filename:file});
});


test('worker reports an upgrade after replacing an older shell, including empty libraries',async()=>{
  const w=await workerHarness();w.stores.set('squidify-shell-v5',new Map());
  await w.lifecycle('install');await w.lifecycle('activate');
  const result=await w.message('CHECK_OFFLINE');assert.equal(result.ready,true);assert.equal(result.updated,true);assert.equal(result.version,'squidify-shell-v15');
  const fresh=await workerHarness();await fresh.lifecycle('install');await fresh.lifecycle('activate');assert.equal((await fresh.message('CHECK_OFFLINE')).updated,false);
});
