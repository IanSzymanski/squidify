import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, access } from 'node:fs/promises';
const base=new URL('../dist/',import.meta.url);
const origin='https://squidify.example/';
async function workerHarness(){
  const listeners={},stores=new Map();let offline=false,failPath=null,networkCalls=0,claimed=false,skipped=false;
  const caches={keys:async()=>[...stores.keys()],delete:async name=>stores.delete(name),open:async name=>{
    if(!stores.has(name))stores.set(name,new Map());const store=stores.get(name);
    return {match:async key=>store.get(typeof key==='string'?key:key.url)?.clone(),put:async(key,response)=>{store.set(typeof key==='string'?key:key.url,response.clone());}};
  }};
  const fetch=async request=>{
    networkCalls++;if(offline)throw new TypeError('Offline');const url=new URL(typeof request==='string'?request:request.url);
    if(url.pathname===failPath)return new Response('Missing',{status:404});
    const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    return new Response(await readFile(new URL(file,base)),{headers:{'content-type':file.endsWith('.js')?'application/javascript':file.endsWith('.html')?'text/html':'application/octet-stream'}});
  };
  const self={registration:{scope:origin},location:{origin:new URL(origin).origin},addEventListener:(name,handler)=>listeners[name]=handler,skipWaiting:async()=>{skipped=true;},clients:{claim:async()=>{claimed=true;}}};
  vm.runInNewContext(await readFile(new URL('sw.js',base),'utf8'),{self,caches,fetch,Request,Response,URL,Set,Promise});
  const lifecycle=async type=>{let promise;listeners[type]({waitUntil:p=>{promise=p;}});await promise;};
  const request=async(path,navigate=false)=>{let response;listeners.fetch({request:{method:'GET',url:new URL(path,origin).href,mode:navigate?'navigate':'cors'},respondWith:p=>response=p});return response?await response:null;};
  const message=async type=>{let pending,result;listeners.message({data:{type},ports:[{postMessage:r=>result=r}],waitUntil:p=>pending=p});await pending;return result;};
  return {lifecycle,request,message,stores,setOffline:value=>offline=value,setFail:path=>failPath=path,get networkCalls(){return networkCalls;},get claimed(){return claimed;},get skipped(){return skipped;}};
}
test('complete installed shell launches and serves all modules with the network disabled',async()=>{
  const w=await workerHarness();await w.lifecycle('install');await w.lifecycle('activate');assert.equal(w.claimed,false,'do not take over an open file picker');assert.equal(w.skipped,false,'updates wait for existing windows to close');
  w.setOffline(true);const count=w.networkCalls;
  assert.match(await (await w.request('/?home=1',true)).text(),/id="audio"/);
  for(const path of ['app.js','styles.css','core.js','storage.js','metadata.js','icons.js','manifest.webmanifest','icon-192.png','icon-512.png','icon-maskable.png'])assert.equal((await w.request(path)).status,200,path);
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
  for(const file of ['app.js','core.js','metadata.js','storage.js','icons.js','sw.js'])new vm.Script((await readFile(new URL(file,base),'utf8')).replace(/^import .+;\n/gm,'').replace(/export /g,''),{filename:file});
});
