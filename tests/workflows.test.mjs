// Domain-flow integration in a lightweight DOM/audio harness. Real phone behavior
// (file pickers, IndexedDB durability, playback policy) still needs device QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto, randomUUID } from 'node:crypto';

function memoryStore(){
  const stores=Object.fromEntries(['tracks','media','playlists','folders','settings'].map(n=>[n,new Map()]));
  let failure=null;
  const clone=x=>x===undefined?undefined:structuredClone(x);
  const check=()=>{if(failure){const e=failure;failure=null;throw e;}};
  return {stores,putTracks:async tracks=>{check();for(const t of tracks)stores.tracks.set(t.id,clone(t));},fail:e=>{failure=e;},all:async s=>[...stores[s].values()].map(clone),get:async(s,id)=>clone(stores[s].get(id)),put:async(s,r)=>{check();stores[s].set(r.id,clone(r));},remove:async(s,id)=>{check();stores[s].delete(id);},setting:async(id,def)=>clone(stores.settings.get(id)?.value??def),setSetting:async(id,value)=>{stores.settings.set(id,{id,value:clone(value)});},storageInfo:async()=>({quota:1e9,usage:1000,persistent:true}),saveTrack:async(t,blob)=>{check();stores.tracks.set(t.id,clone(t));stores.media.set(t.id,{id:t.id,blob});},deleteTrack:async id=>{check();stores.tracks.delete(id);stores.media.delete(id);for(const p of stores.playlists.values())p.trackIds=p.trackIds.filter(x=>x!==id);}};
}
function musicFile(title){
  const make=(id,text)=>{const value=new TextEncoder().encode(text),b=new Uint8Array(11+value.length);b.set(new TextEncoder().encode(id));new DataView(b.buffer).setUint32(4,value.length+1);b[10]=3;b.set(value,11);return b;};
  const frames=[make('TIT2',title),make('TPE1','Artist'),make('TLEN','120000')],size=frames.reduce((s,b)=>s+b.length,0),out=new Uint8Array(10+size);out.set([73,68,51,3,0,0,0,0,(size>>7)&127,size&127]);let pos=10;for(const b of frames){out.set(b,pos);pos+=b.length;}return new File([out],`${title}.mp3`,{type:'audio/mpeg'});
}
class Element {
  constructor(){this.innerHTML='';this.textContent='';this.dataset={};this.hidden=false;this.open=false;this.value='';this.disabled=false;this.attrs={};this.events={};this.style={setProperty(){}};const classes=new Set();this.classList={toggle:(name,force)=>{const next=force??!classes.has(name);if(next)classes.add(name);else classes.delete(name);},contains:n=>classes.has(n),add:n=>classes.add(n),remove:n=>classes.delete(n)};}
  setAttribute(k,v){this.attrs[k]=v;}removeAttribute(k){delete this.attrs[k];if(k==='src')this.src='';}getAttribute(k){return k==='src'?this.src:this.attrs[k];}
  addEventListener(n,f,options){(this.events[n]||=[]).push({f,once:options?.once});}
  emit(n){const callbacks=[...(this.events[n]||[])];this.events[n]=(this.events[n]||[]).filter(x=>!x.once);for(const {f}of callbacks)f({target:this});}
  showModal(){this.open=true;}close(){this.open=false;}focus(){}click(){this.clicks=(this.clicks||0)+1;}append(...children){this.children=children;}querySelectorAll(){return [];}querySelector(){return new Element();}
}
class FakeAudio extends Element {
  constructor(){super();this.src='';this.currentSrc='';this.readyState=0;this.paused=true;this.ended=false;this.currentTime=0;this.duration=NaN;this.volume=1;this.muted=false;this.playbackRate=1;this.playCalls=[];}
  async play(){this.beforePlay?.();this.playCalls.push(this.src);this.paused=false;this.ended=false;this.emit('play');}
  pause(){const old=this.paused;this.paused=true;if(!old)this.emit('pause');}
  load(){this.readyState=0;this.currentTime=0;this.ended=false;this.pause();this.currentSrc='';this.duration=NaN;this.emit('emptied');if(this.src&&!this.deferMetadata)this.finishMetadata(this.nextDuration??120);}
  finishMetadata(duration){this.currentSrc=this.src;this.readyState=1;this.duration=duration;this.emit('loadedmetadata');this.onloadedmetadata?.();}
}

async function mediaFixture(t,options={}) {
  const db=memoryStore();
  for(const id of ['a','b','c','d'])await db.saveTrack({id,title:`Song ${id}`,artist:`Artist ${id}`,album:`Album ${id}`,duration:120},new Blob([id],{type:'audio/mpeg'}));
  await db.setSetting('session',{queue:{source:['a','b','c'],order:['a','b','c'],index:0},time:24});
  return harness(t,db,{random:()=>0.5,...options});
}
const settlePlayback=()=>new Promise(resolve=>setImmediate(resolve));

test('locked Next and Previous start the preloaded source during the native action without ending its session',async t=>{
  const app=await mediaFixture(t),audio=app.element('#audio');await app.mediaActions.play();await settlePlayback();
  let inNativeAction=false,metadata=app.mediaSession.metadata,playbackState=app.mediaSession.playbackState;
  const changes=[];
  Object.defineProperty(app.mediaSession,'metadata',{get:()=>metadata,set:value=>{metadata=value;changes.push(['metadata',value]);}});
  Object.defineProperty(app.mediaSession,'playbackState',{get:()=>playbackState,set:value=>{playbackState=value;changes.push(['state',value]);}});
  audio.beforePlay=()=>assert.equal(inNativeAction,true,'play must run before returning from the external action');
  const firstSrc=audio.src,calls=audio.playCalls.length;
  inNativeAction=true;const next=app.mediaActions.nexttrack();inNativeAction=false;
  assert.notEqual(audio.src,firstSrc);assert.equal(audio.playCalls.length,calls+1);assert.equal(audio.paused,false);
  await next;await settlePlayback();
  inNativeAction=true;const previous=app.mediaActions.previoustrack();inNativeAction=false;
  assert.equal(audio.src,firstSrc);assert.equal(audio.playCalls.length,calls+2);await previous;
  assert.equal(changes.some(([name,value])=>name==='metadata'?value===null:value==='none'),false);
});

test('track switches reject stale duration and position until metadata belongs to the new source',async t=>{
  const app=await mediaFixture(t),audio=app.element('#audio');await app.mediaActions.play();await settlePlayback();
  const oldSrc=audio.src;app.state.tracks.get('b').duration=37;audio.deferMetadata=true;
  const next=app.mediaActions.nexttrack();
  assert.equal(app.mediaSession.metadata.title,'Song b');assert.equal(app.positions.at(-1),undefined);
  assert.deepEqual({...app.playback.progress()},{ready:false,duration:37,time:0});
  audio.readyState=1;audio.currentSrc=oldSrc;audio.duration=120;audio.currentTime=24;
  audio.emit('loadedmetadata');audio.emit('timeupdate');audio.emit('durationchange');
  assert.equal(app.state.tracks.get('b').duration,37);assert.equal(app.positions.at(-1),undefined);
  audio.currentTime=0;audio.finishMetadata(73);await next;
  assert.equal(app.positions.at(-1).duration,73);assert.equal(app.positions.at(-1).position,0);
  assert.equal(app.state.tracks.get('b').duration,73);assert.equal(app.playback.progress().ready,true);
  audio.emit('pause');assert.equal(audio.paused,false,'a queued pause from the replaced source cannot cancel current playback');
  audio.deferMetadata=true;const skip=app.mediaActions.nexttrack();app.mediaActions.pause();audio.finishMetadata(91);await skip;
  assert.equal(audio.paused,true);assert.equal(app.mediaSession.playbackState,'paused');assert.equal(app.positions.at(-1).duration,91);
});

function workerFixture(active=true) {
  const worker=new Element();worker.state='installing';
  const registration=new Element();registration.active=active?{}:null;registration.installing=worker;registration.waiting=null;
  const serviceWorker={register:async()=>registration,ready:new Promise(()=>{}),getRegistration:async()=>registration,addEventListener(){}};
  const finish=state=>{worker.state=state;registration.installing=null;if(state==='installed')registration.waiting=worker;worker.emit('statechange');};
  return {worker,registration,serviceWorker,finish};
}
test('an update download remains visible alongside toasts then becomes ready without activating or reloading',async t=>{
  const sw=workerFixture(),app=await harness(t,memoryStore(),{serviceWorker:sw.serviceWorker});await settlePlayback();
  assert.equal(app.state.updateDownloading,true);assert.equal(app.element('#updateStatus').hidden,false);
  assert.equal(app.element('#updateStatusText').textContent,'Downloading update…');
  assert.match(app.element('#offlineBadge').innerHTML,/Downloading/);
  app.ui.toast('Added to queue.');assert.equal(app.element('#updateStatus').hidden,false);
  sw.registration.emit('updatefound');assert.equal(sw.worker.events.statechange.length,1);
  sw.finish('installed');assert.equal(app.element('#updateStatus').hidden,true);assert.equal(app.state.updateDownloading,false);
  assert.match(app.element('#toast').textContent,/Update ready.*Close all/);
  assert.equal(app.db.stores.settings.has('installedShellVersion'),false,'download is not an installation');
});
test('download failure clears the indicator and first install uses offline setup wording',async t=>{
  const sw=workerFixture(),app=await harness(t,memoryStore(),{serviceWorker:sw.serviceWorker});await settlePlayback();
  sw.finish('redundant');assert.equal(app.element('#updateStatus').hidden,true);assert.equal(app.state.updateDownloading,false);
  assert.match(app.element('#toast').textContent,/download interrupted/);assert.equal(app.element('#toast').classList.contains('error'),true);
  const first=workerFixture(false),fresh=await harness(t,memoryStore(),{serviceWorker:first.serviceWorker});await settlePlayback();
  assert.equal(fresh.element('#updateStatusText').textContent,'Preparing offline playback…');
  first.finish('installed');assert.equal(fresh.element('#updateStatus').hidden,true);assert.equal(fresh.element('#toast').hidden,true);
});

test('media controls register once, remove seek offsets and resume without rebuilding the queue',async t=>{
  const app=await mediaFixture(t),audio=app.element('#audio'),order=[...app.state.queue.order],src=audio.src;
  assert.equal(app.mediaActions.seekbackward,null);assert.equal(app.mediaActions.seekforward,null);
  assert.equal(app.mediaSession.metadata.title,'Song a');assert.equal(app.mediaSession.playbackState,'paused');
  assert.equal(app.positions.at(-1).position,24);
  const count=app.registrations.length,listeners=audio.events.ended.length;
  app.playback.setupMediaSession();app.playback.bindEvents();
  assert.equal(app.registrations.length,count);assert.equal(audio.events.ended.length,listeners);
  await app.mediaActions.play();await app.mediaActions.play();
  assert.equal(audio.paused,false);assert.equal(audio.src,src);assert.equal(audio.currentTime,24);
  assert.equal(app.mediaSession.playbackState,'playing');assert.deepEqual([...app.state.queue.order],order);
  app.mediaActions.pause();app.mediaActions.pause();assert.equal(audio.paused,true);
  assert.equal(app.mediaSession.playbackState,'paused');assert.equal(audio.currentTime,24);
  await app.mediaActions.play();assert.equal(audio.currentTime,24);
  app.mediaActions.stop();assert.equal(audio.paused,true);assert.equal(audio.currentTime,0);
  assert.equal(app.positions.at(-1).position,0);assert.deepEqual([...app.state.queue.order],order);
});

test('external Next matches in-app Next for inserted queue items, shuffle, repeat and boundaries',async t=>{
  for(const shuffle of [false,true])for(const repeat of ['off','one','all']) {
    const remote=await mediaFixture(t),button=await mediaFixture(t);
    remote.state.queue.setShuffle(shuffle,remote.state.tracks);remote.state.queue.add('d',true);
    button.state.queue.source=[...remote.state.queue.source];button.state.queue.order=[...remote.state.queue.order];
    button.state.queue.shuffle=shuffle;remote.state.queue.repeat=button.state.queue.repeat=repeat;
    await remote.mediaActions.play();await button.actions['toggle-play']();
    for(let press=0;press<5;press++) {
      remote.mediaActions.nexttrack();button.actions.next();await settlePlayback();
      assert.equal(remote.state.queue.current,button.state.queue.current);
      assert.equal(remote.state.queue.index,button.state.queue.index);
      assert.deepEqual([...remote.state.queue.order],[...button.state.queue.order]);
      assert.equal(remote.element('#audio').paused,button.element('#audio').paused);
      assert.equal(remote.mediaSession.metadata.title,`Song ${remote.state.queue.current}`);
    }
    assert.equal(remote.mediaSession.playbackState,repeat==='all'?'playing':'paused');
  }
});

test('external Previous restarts after three seconds then follows the actual played order',async t=>{
  const app=await mediaFixture(t),audio=app.element('#audio');
  app.mediaActions.nexttrack();await settlePlayback();assert.equal(app.state.queue.current,'b');
  audio.currentTime=4;app.mediaActions.previoustrack();
  assert.equal(app.state.queue.current,'b');assert.equal(audio.currentTime,0);assert.equal(app.positions.at(-1).position,0);
  app.mediaActions.previoustrack();await settlePlayback();assert.equal(app.state.queue.current,'a');
  app.mediaActions.previoustrack();await settlePlayback();assert.equal(app.state.queue.index,0);
});

test('rapid skips perform one action each and publish only the latest loaded song',async t=>{
  const app=await mediaFixture(t);app.mediaActions.nexttrack();app.mediaActions.nexttrack();
  assert.equal(app.state.queue.index,2);assert.equal(app.mediaSession.metadata.title,'Song b');
  assert.equal(app.positions.at(-1),undefined);await settlePlayback();
  assert.equal(app.playback.activeTrackId(),'c');assert.equal(app.mediaSession.metadata.title,'Song c');
  const audio=app.element('#audio');app.state.queue.index=0;await app.playback.loadTrack('a',false);
  app.mediaActions.nexttrack();app.mediaActions.pause();await settlePlayback();
  assert.equal(app.state.queue.current,'b');assert.equal(audio.paused,true);assert.equal(app.mediaSession.playbackState,'paused');
});

test('external and native seeking validate bounds and refresh position, duration and rate',async t=>{
  const app=await mediaFixture(t),audio=app.element('#audio');
  for(const [time,expected] of [[-5,0],[999,120],[37,37]]) {
    app.mediaActions.seekto({seekTime:time});assert.equal(audio.currentTime,expected);assert.equal(app.positions.at(-1).position,expected);
  }
  for(const seekTime of [NaN,Infinity,undefined,'40'])app.mediaActions.seekto({seekTime});
  app.mediaActions.seekto();assert.equal(audio.currentTime,37);
  audio.currentTime=58;audio.emit('seeked');assert.equal(app.positions.at(-1).position,58);
  audio.duration=60;audio.emit('durationchange');assert.equal(app.positions.at(-1).duration,60);
  audio.playbackRate=1.5;audio.emit('ratechange');assert.equal(app.positions.at(-1).playbackRate,1.5);
  for(const [field,value] of [['currentTime',NaN],['currentTime',Infinity],['duration',NaN],['duration',Infinity],['duration',0],['playbackRate',0],['playbackRate',NaN]]) {
    audio.duration=120;audio.currentTime=20;audio.playbackRate=1;audio[field]=value;
    app.playback.updatePositionState();assert.equal(app.positions.at(-1),undefined);
  }
  audio.duration=NaN;app.mediaActions.seekto({seekTime:0});assert.equal(audio.currentTime,20);
  audio.duration=120;audio.currentTime=-10;audio.playbackRate=1;app.playback.updatePositionState();assert.equal(app.positions.at(-1).position,0);
});

test('completion respects repeat-one, repeat-all and end-of-queue with synchronized session state',async t=>{
  for(const repeat of ['off','one','all']) {
    const app=await mediaFixture(t),audio=app.element('#audio');app.state.queue.index=2;app.state.queue.repeat=repeat;
    await app.playback.loadTrack('c',true);audio.currentTime=120;audio.ended=true;audio.paused=true;audio.emit('ended');await settlePlayback();
    assert.equal(app.state.queue.current,{off:'c',one:'c',all:'a'}[repeat]);
    assert.equal(app.mediaSession.metadata.title,`Song ${app.state.queue.current}`);
    assert.equal(app.mediaSession.playbackState,repeat==='off'?'paused':'playing');
    assert.equal(app.positions.at(-1).position,repeat==='off'?120:0);
  }
});

test('metadata and artwork refresh, and unloading or failed loading clears stale session data',async t=>{
  const app=await mediaFixture(t),audio=app.element('#audio');
  app.state.tracks.get('a').title='Renamed';app.ui.mediaArtwork=()=>({src:'https://squidify.example/local-cover.png',type:'image/png'});
  app.playback.updateMediaSession();assert.equal(app.mediaSession.metadata.title,'Renamed');
  assert.equal(app.mediaSession.metadata.artist,'Artist a');assert.equal(app.mediaSession.metadata.album,'Album a');
  assert.equal(app.mediaSession.metadata.artwork[0].src,'https://squidify.example/local-cover.png');
  audio.readyState=0;audio.emit('emptied');assert.equal(app.positions.at(-1),undefined);
  assert.equal(app.mediaSession.metadata.title,'Renamed','a source transition retains the native session');
  audio.finishMetadata(120);assert.equal(app.mediaSession.metadata.title,'Renamed');
  await app.actions['remove-track']({dataset:{id:'a'}});
  assert.equal(app.mediaSession.metadata,null);assert.equal(app.mediaSession.playbackState,'none');assert.equal(app.positions.at(-1),undefined);
  app.state.queue.order.push('d');app.state.queue.index=2;app.db.stores.media.delete('d');await app.playback.loadTrack('d',false);
  assert.equal(audio.src,'');assert.equal(app.mediaSession.metadata,null);assert.equal(app.mediaSession.playbackState,'none');
  app.state.queue.index=1;await app.playback.loadTrack('c',false);assert.equal(app.mediaSession.metadata.title,'Song c');
  audio.emit('error');assert.equal(app.mediaSession.metadata,null);assert.equal(app.positions.at(-1),undefined);
});

test('missing or partially unsupported Media Session leaves playback and other handlers usable',async t=>{
  const absent=await mediaFixture(t,{absent:true});await absent.actions['toggle-play']();
  absent.actions.next();await settlePlayback();assert.equal(absent.state.queue.current,'b');
  absent.element('#audio').emit('ratechange');absent.playback.setupMediaSession();
  const partial=await mediaFixture(t,{unsupported:['seekbackward','previoustrack'],positionThrows:true,stateThrows:true});
  assert.equal(typeof partial.mediaActions.nexttrack,'function');assert.equal(partial.mediaActions.seekforward,null);
  await partial.mediaActions.play();partial.mediaActions.nexttrack();await settlePlayback();assert.equal(partial.state.queue.current,'b');
  partial.mediaActions.pause();assert.equal(partial.element('#audio').paused,true);
});
async function harness(t,db=memoryStore(),mediaOptions={}){
  const elements=new Map(),events={},timers=new Set(),waveCanvases=[];
  const element=s=>{if(!elements.has(s)){const el=s==='#audio'?new FakeAudio():new Element();if(['#queuePanel','#toast','#importBanner'].includes(s))el.hidden=true;elements.set(s,el);}return elements.get(s);};
  const document={querySelector:element,querySelectorAll:selector=>selector==='.audio-wave'?waveCanvases:[],addEventListener:(name,f)=>{(events['doc:'+name]||=[]).push(f);},createElement:()=>new Element(),body:Object.assign(new Element(),{append(){}}),hidden:false};
  const window={addEventListener:(name,f)=>{events[name]=f;},scrollTo(){}};
  let hash='#library';const location={href:'https://squidify.example/',get hash(){return hash;},set hash(v){hash=v;queueMicrotask(()=>events.hashchange?.());}};
  const actions={},registrations=[],positions=[];
  const mediaSession={setActionHandler:(name,f)=>{registrations.push(name);if(mediaOptions.unsupported?.includes(name))throw new Error('Unsupported action');actions[name]=f;},setPositionState:value=>{if(mediaOptions.positionThrows)throw new Error('Unsupported position');positions.push(value);}};
  const navigator={userAgent:'Test',platform:'Test',maxTouchPoints:0,onLine:true,storage:{persist:async()=>true},mediaSession:mediaOptions.absent?undefined:mediaSession};
  if(mediaOptions.serviceWorker)navigator.serviceWorker=mediaOptions.serviceWorker;
  if(mediaOptions.stateThrows)Object.defineProperty(mediaSession,'playbackState',{set(){throw new Error('Unsupported state');}});
  const context=vm.createContext({document,window,navigator,location,URL,Blob,File,TextEncoder,DataView,Uint8Array,ArrayBuffer,crypto:{subtle:webcrypto.subtle,randomUUID},Audio:FakeAudio,MediaMetadata:class{constructor(value){Object.assign(this,value);}},AbortController,FormData,matchMedia:()=>({matches:false}),console:{error(){}},setTimeout:(f,ms)=>{const timer=setTimeout(f,ms);timers.add(timer);return timer;},clearTimeout:id=>{clearTimeout(id);timers.delete(id);}});
  if(mediaOptions.random)context.Math=Object.assign(Object.create(Math),{random:mediaOptions.random});
  // Evaluate the real ES module graph in an isolated browser-like context.
  // Only IndexedDB is replaced; module imports/exports are not stripped.
  const modules=new Map();
  const storage=new vm.SyntheticModule(Object.keys(db),function(){for(const [key,value] of Object.entries(db))this.setExport(key,value);},{context});
  async function load(url){
    if(url.endsWith('/storage.js'))return storage;
    if(!modules.has(url))modules.set(url,new vm.SourceTextModule(await readFile(new URL(url),'utf8'),{context,identifier:url}));
    return modules.get(url);
  }
  const entry=await load(new URL('../dist/app.js',import.meta.url).href);
  await entry.link((specifier,ref)=>load(new URL(specifier,ref.identifier).href));
  await entry.evaluate();await entry.namespace.ready;
  const {context:app,actions:appActions}=entry.namespace;
  t.after(()=>{for(const timer of timers)clearTimeout(timer);});
  return {waveCanvases,enhancements:app.enhancements,ui:app.ui,offline:app.offline,state:app.state,actions:appActions,importEntries:app.importer.importEntries,savePlaylistForm:app.playlists.savePlaylistForm,saveTrackDetails:app.playlists.saveTrackDetails,addToPlaylist:app.playlists.addToPlaylist,saveSession:app.playback.saveSession,render:app.ui.render,readRoute:app.ui.readRoute,db,element,mediaActions:actions,mediaSession,registrations,positions,playback:app.playback,emitDocument:(name,event)=>events['doc:'+name]?.forEach(fn=>fn(event))};
}
test('empty library starts with working folder and file input alternatives',async t=>{
  const app=await harness(t);assert.match(app.element('#main').innerHTML,/Your music belongs here/);
  await app.actions['choose-folder']();assert.equal(app.element('#folderInput').clicks,1);
  app.actions['choose-files']();assert.equal(app.element('#fileInput').clicks,1);
});
test('equalizer settings apply through input events, persist across reopening, and reset',async t=>{
 const app=await harness(t);app.state.view='settings';app.render();
 assert.match(app.element('#main').innerHTML,/Live equalizer preview/);
 assert.match(app.element('#main').innerHTML,/id="eq-edgeFade"/);
 const slider=app.element('#eq-edgeFade');slider.dataset.eq='edgeFade';slider.value='45';
 app.emitDocument('input',{target:slider});
 assert.equal(app.element('#eq-value-edgeFade').textContent,'45%');
 app.enhancements.updateEqualizer('activeWidth',100);app.enhancements.updateEqualizer('height',400);
 await app.enhancements.saveSettings();
 assert.equal(app.db.stores.settings.get('equalizer').value.edgeFade,45);
 const again=await harness(t,app.db);again.state.view='settings';again.render();
 assert.match(again.element('#main').innerHTML,/id="eq-edgeFade"[^>]*value="45"/);
 assert.match(again.element('#main').innerHTML,/id="eq-activeWidth"[^>]*value="100"/);
 assert.match(again.element('#main').innerHTML,/id="eq-height"[^>]*value="400"/);
 await again.actions['reset-equalizer']();
 assert.equal(app.db.stores.settings.get('equalizer').value.edgeFade,30);
 assert.equal(again.element('#eq-edgeFade').value,30);
 assert.equal(app.db.stores.settings.get('equalizer').value.activeWidth,60);
 assert.equal(app.db.stores.settings.get('equalizer').value.height,100);
});
test('settings demo draws without music while the real player stays quiet, including paused-preview tuning',async t=>{
 const app=await harness(t);app.state.view='settings';
 const make=preview=>{
  const ys=[],ctx={clearRect(){ys.length=0;},setTransform(){},createLinearGradient(){return{addColorStop(){}};},beginPath(){},moveTo(x,y){ys.push(y);},bezierCurveTo(x1,y1,x2,y2,x3,y3){ys.push(y1,y2,y3);},lineTo(){},closePath(){},fill(){},stroke(){}};
  const canvas={width:390,height:70,classList:{contains:name=>preview&&name==='eq-preview-wave'},getContext:()=>ctx,getBoundingClientRect:()=>({width:390,height:70}),setAttribute(){}};
  app.waveCanvases.push(canvas);return ys;
 };
 const demo=make(true),player=make(false);
 const button=new Element();app.actions['pause-equalizer-preview'](button);
 app.enhancements.drawWave();assert.ok(demo.some(y=>y<66));assert.ok(player.every(y=>y===67));
 const tall=Math.min(...demo);app.enhancements.updateEqualizer('height',10);
 assert.ok(Math.min(...demo)>tall,'paused preview still reflects shape edits');
 assert.equal(button.attrs['aria-pressed'],'true');
 app.actions['pause-equalizer-preview'](button);assert.match(app.element('[data-eq-source]').textContent,/Demo signal/);
});
test('opening files keeps the import dialog and input alive until selection or cancellation',async t=>{
  const app=await harness(t);app.actions['add-music']();const input=app.element('#fileInput'),dialog=app.element('#modal');
  assert.equal(dialog.open,true);assert.equal(app.element('#filePickerSlot').children[0],input);
  app.actions['choose-files']();assert.equal(dialog.open,true,'opening a native picker must not close the parent dialog');assert.equal(app.state.pickerOpen,true);
  app.element('#main').innerHTML='unchanged while native picker is open';app.render();app.emitDocument('visibilitychange',{});
  assert.equal(app.element('#main').innerHTML,'unchanged while native picker is open');
  app.emitDocument('cancel',{target:input});assert.equal(app.state.pickerOpen,false);assert.equal(dialog.open,true);
  assert.match(app.element('#main').innerHTML,/Your music belongs here/);
});
test('native file control clicks retain default picker behavior, not delegated button actions',async t=>{
  const app=await harness(t);let prevented=false;
  app.emitDocument('click',{target:app.element('#fileInput'),preventDefault(){prevented=true;}});
  assert.equal(prevented,false);assert.equal(app.state.pickerOpen,true);
  app.emitDocument('cancel',{target:app.element('#fileInput')});assert.equal(app.state.pickerOpen,false);
});
test('import, duplicate detection, playlist edits, restored queue and reload stay consistent',async t=>{
  const app=await harness(t);
  const one=musicFile('One'),two=musicFile('Two');await app.importEntries([{file:one},{file:two},{file:one}]);
  assert.equal(app.state.tracks.size,2);assert.equal(app.db.stores.media.size,2);assert.equal(app.element('#audio').paused,true);
  const ids=[...app.state.tracks.keys()];app.element('#playlistName').value='Night listening';
  await app.savePlaylistForm({dataset:{id:'',track:ids[0]}});const p=app.state.playlists[0];
  await app.addToPlaylist(p.id,ids[1]);await app.addToPlaylist(p.id,ids[1]);assert.equal(p.trackIds.length,2);
  app.state.view='playlist';app.state.detail=p.id;
  await app.actions['move-playlist-track']({dataset:{id:ids[1],delta:'-1'}});assert.equal(p.trackIds[0],ids[1]);
  await app.actions['remove-playlist-track']({dataset:{id:ids[0]}});assert.equal(p.trackIds.length,1);assert.equal(app.state.tracks.size,2);
  await app.actions['toggle-play']();assert.equal(app.element('#audio').paused,false);
  app.mediaActions.play();assert.equal(app.element('#audio').paused,false,'play command must not toggle into pause');
  app.element('#audio').currentTime=24;app.saveSession(true);
  const reopened=await harness(t,app.db);assert.equal(reopened.state.tracks.size,2);assert.equal(reopened.state.playlists[0].name,'Night listening');assert.equal(reopened.state.playlists[0].trackIds[0],ids[1]);
  assert.equal(reopened.element('#audio').paused,true);assert.equal(reopened.element('#audio').currentTime,24);assert.equal(reopened.state.queue.current,app.state.queue.current);
});
test('failed playlist save keeps the previous state; a quota failure leaves no half-imported song',async t=>{
  const app=await harness(t);app.element('#playlistName').value='Keep this name';app.db.fail(new Error('Disk unavailable'));
  await assert.rejects(app.savePlaylistForm({dataset:{}}));assert.equal(app.state.playlists.length,0);assert.equal(app.element('#playlistName').value,'Keep this name');
  app.db.fail(Object.assign(new Error('Quota exceeded'),{name:'QuotaExceededError'}));await app.importEntries([{file:musicFile('Full storage')}]);
  assert.equal(app.state.tracks.size,0);assert.equal(app.db.stores.media.size,0);assert.match(app.element('#toast').textContent,/storage is full/);
});
test('deleting a song removes saved bytes and playlist references; deleting a playlist keeps songs',async t=>{
  const app=await harness(t);await app.importEntries([{file:musicFile('One')},{file:musicFile('Two')}]);const ids=[...app.state.tracks.keys()];
  app.element('#playlistName').value='Playlist';await app.savePlaylistForm({dataset:{track:ids[0]}});const p=app.state.playlists[0];await app.addToPlaylist(p.id,ids[1]);
  await app.actions['remove-track']({dataset:{id:ids[0]}});assert.equal(app.db.stores.media.size,1);assert.equal(app.state.playlists[0].trackIds.length,1);assert.equal(app.state.queue.current,null);
  await app.actions['delete-playlist']({dataset:{id:p.id}});assert.equal(app.state.playlists.length,0);assert.equal(app.db.stores.media.size,1);assert.equal(app.state.tracks.size,1);
});
test('local metadata is escaped before it reaches the music list',async t=>{
  const app=await harness(t);await app.importEntries([{file:musicFile('<img src=x onerror=alert(1)>')}]);
  assert.doesNotMatch(app.element('#main').innerHTML,/<img src=x/);assert.match(app.element('#main').innerHTML,/&lt;img src=x/);
});

test('pre-refactor saved records restore without migration or re-import',async t=>{
  const db=memoryStore();
  const track={id:'legacy-track',title:'Saved song',artist:'Artist',album:'Album',name:'saved.mp3',path:'Music/saved.mp3',folderId:'legacy-folder',size:3,mime:'audio/mpeg',duration:120,addedAt:123,liked:true};
  const playlist={id:'legacy-playlist',name:'Existing playlist',trackIds:[track.id],color:'lime',createdAt:124};
  await db.saveTrack(track,new Blob(['old'],{type:'audio/mpeg'}));
  await db.put('playlists',playlist);
  await db.put('folders',{id:'legacy-folder',name:'Music',handle:{kind:'directory',name:'Music'}});
  await db.setSetting('session',{queue:{source:[track.id],order:[track.id],index:0,shuffle:true,repeat:'all',context:playlist.name},time:42,volume:0.4,muted:true,sort:'artist'});
  const app=await harness(t,db);
  assert.equal(app.state.tracks.get(track.id).liked,true);
  assert.equal(app.state.playlists[0].id,playlist.id);
  assert.equal(app.state.folders[0].handle.name,'Music');
  assert.equal(app.state.queue.current,track.id);
  assert.equal(app.state.queue.shuffle,true);assert.equal(app.state.queue.repeat,'all');
  assert.equal(app.state.sort,'artist');
  assert.equal(app.element('#audio').paused,true);assert.equal(app.element('#audio').currentTime,42);
  assert.equal(app.element('#audio').volume,0.4);assert.equal(app.element('#audio').muted,true);
  assert.equal(await db.stores.media.get(track.id).blob.text(),'old');
});


test('playlist order and song-detail edits persist without changing audio',async t=>{
  const app=await harness(t);await app.importEntries([{file:musicFile('One')}]);const id=[...app.state.tracks.keys()][0];
  for(const name of ['First','Second']){app.element('#playlistName').value=name;await app.savePlaylistForm({dataset:{track:id}});}
  const second=app.state.playlists[1];await app.actions['move-playlist']({dataset:{id:second.id,delta:'-1'}});
  app.element('#track-title').value='Renamed';app.element('#track-artist').value='New Artist';app.element('#track-album').value='New Album';
  await app.saveTrackDetails({dataset:{id}});
  const reopened=await harness(t,app.db);assert.equal(reopened.state.playlists[0].id,second.id);
  assert.equal(reopened.state.tracks.get(id).title,'Renamed');assert.equal(app.db.stores.media.size,1);
  reopened.state.view='library';reopened.render();const html=reopened.element('#main').innerHTML;
  assert.ok(html.indexOf('library-playlists')<html.indexOf('track-table'));
  assert.doesNotMatch(html,/Take it offline|A better kind of shuffle|Keep it on your Home Screen/);
});


test('installed-update toast is shown once, only for the running ready release',async t=>{
  const app=await harness(t);
  await app.offline.announceInstalled('squidify-shell-v5',true);
  assert.equal(app.element('#toast').hidden,true);
  assert.equal(app.db.stores.settings.has('installedShellVersion'),false);
  await Promise.all([app.offline.announceInstalled('squidify-shell-v19',true),app.offline.announceInstalled('squidify-shell-v19',true)]);
  assert.match(app.element('#toast').textContent,/Squidify updated/);
  assert.equal(app.db.stores.settings.get('installedShellVersion').value,'squidify-shell-v19');
  const reopened=await harness(t,app.db);await reopened.offline.announceInstalled('squidify-shell-v19',true);
  assert.equal(reopened.element('#toast').hidden,true);
});
test('a first install records its release without claiming an update',async t=>{
  const app=await harness(t);await app.offline.announceInstalled('squidify-shell-v19',false);
  assert.equal(app.element('#toast').hidden,true);
  assert.equal(app.db.stores.settings.get('installedShellVersion').value,'squidify-shell-v19');
});


test('mixed import preserves valid songs and reports duplicates and unsupported files separately',async t=>{
 const app=await harness(t),file=musicFile('Valid');
 await app.importEntries([{file},{file:new File(['x'],'notes.txt',{type:'text/plain'})},{file}]);
 assert.equal(app.state.tracks.size,1);assert.equal(app.state.importReport.files.length,2);
 assert.match(app.state.importReport.summary,/1 song saved.*1 duplicate.*1 unsupported/);
 assert.match(app.state.importReport.files[0].reason,/Unsupported/);
});
test('playlist search stays scoped and playing a playlist retains its artwork context on reload',async t=>{
 const app=await harness(t);await app.importEntries([{file:musicFile('One')},{file:musicFile('Two')}]);
 const ids=[...app.state.tracks.keys()];app.element('#playlistName').value='One only';await app.savePlaylistForm({dataset:{track:ids[0]}});
 app.state.view='playlist';app.state.detail=app.state.playlists[0].id;app.state.search='Two';assert.equal(app.ui.currentList().length,0);
 app.state.search='';await app.actions['play-view']();app.saveSession(true);
 assert.equal(app.state.queue.playlistId,app.state.detail);
 const again=await harness(t,app.db);assert.equal(again.state.queue.playlistId,app.state.detail);
});
test('photo cover save persists and failed replacement retains the old cover',async t=>{
 const app=await harness(t);app.element('#playlistName').value='Photos';await app.savePlaylistForm({dataset:{}});
 const p=app.state.playlists[0];app.enhancements.coverDialog('playlist',p.id);
 await app.enhancements.saveCover(new Blob(['first'],{type:'image/jpeg'}));assert.equal(await p.artwork.text(),'first');
 app.db.fail(Object.assign(new Error('Full'),{name:'QuotaExceededError'}));
 await assert.rejects(app.enhancements.saveCover(new Blob(['second'],{type:'image/jpeg'})));
 assert.equal(await p.artwork.text(),'first');assert.equal(await app.db.stores.playlists.get(p.id).artwork.text(),'first');
});

test('Create Playlist click does not inherit navigation from body data-view; submit saves and closes',async t=>{
 const app=await harness(t);app.actions['new-playlist']({dataset:{}});app.element('#playlistName').value='Created by form';
 let prevented=false;
 const body={dataset:{view:'library'}};
 const submit={closest(selector){return selector==='[data-action],[data-view]'?body:null;}};
 app.emitDocument('click',{target:submit,preventDefault(){prevented=true;}});
 assert.equal(prevented,false,'submit must retain its native form action');
 const form={id:'playlistForm',dataset:{}};
 app.emitDocument('submit',{target:form,preventDefault(){prevented=true;}});
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(prevented,true);assert.equal(app.state.playlists.length,1);assert.equal(app.state.playlists[0].name,'Created by form');assert.equal(app.element('#modal').open,false);
 const again=await harness(t,app.db);assert.equal(again.state.playlists[0].name,'Created by form');
});

test('collection play toggles pause and resume without rebuilding or restarting the queue',async t=>{
 const app=await harness(t);await app.importEntries([{file:musicFile('One')},{file:musicFile('Two')}]);
 await app.actions['play-view']();await new Promise(r=>setTimeout(r,10));
 const audio=app.element('#audio'),id=app.state.queue.current,order=[...app.state.queue.order];audio.currentTime=32;
 await app.actions['play-view']();assert.equal(audio.paused,true);assert.equal(audio.currentTime,32);
 await app.actions['play-view']();assert.equal(audio.paused,false);assert.equal(audio.currentTime,32);assert.equal(app.state.queue.current,id);assert.deepEqual([...app.state.queue.order],order);
 app.element('#playlistName').value='Another collection';await app.savePlaylistForm({dataset:{track:order[1]}});await new Promise(r=>setTimeout(r,10));
 await app.actions['play-view']();await new Promise(r=>setTimeout(r,10));assert.equal(app.state.queue.current,order[1]);assert.equal(app.state.queue.playlistId,app.state.playlists[0].id);
});

test('paused hidden-player canvas remains transparent and redraws as a baseline on reopening',async t=>{
 const app=await harness(t);let width=0,height=0,clears=0,curves=[];
 const ctx={clearRect(){clears++;},setTransform(){},createLinearGradient(){return{addColorStop(){}};},beginPath(){},moveTo(x,y){curves.push(y);},bezierCurveTo(x1,y1,x2,y2,x3,y3){curves.push(y1,y2,y3);},lineTo(){},closePath(){},fill(){},stroke(){}};
 const canvas={width:780,height:140,getContext:()=>ctx,getBoundingClientRect:()=>({width,height}),setAttribute(){}};app.waveCanvases.push(canvas);
 app.enhancements.drawWave();assert.equal(canvas.height,140,'hidden canvas must not become a one-pixel filled image');assert.equal(curves.length,0);assert.ok(clears>0);
 width=390;height=85;app.enhancements.drawWave();assert.equal(canvas.height,85);assert.ok(curves.length>0);assert.ok(curves.every(y=>y===82),'paused wave stays within three pixels of bottom');
 width=0;height=0;curves=[];app.enhancements.drawWave();assert.equal(curves.length,0);width=390;height=85;app.enhancements.drawWave();assert.ok(curves.every(y=>y===82));
});
