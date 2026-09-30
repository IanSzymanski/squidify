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
  constructor(){super();this.src='';this.paused=true;this.currentTime=0;this.duration=120;this.volume=1;this.muted=false;this.playbackRate=1;}
  async play(){this.paused=false;this.emit('play');}pause(){const old=this.paused;this.paused=true;if(!old)this.emit('pause');}load(){this.currentTime=0;if(this.src){this.emit('loadedmetadata');this.onloadedmetadata?.();}}
}
async function harness(t,db=memoryStore()){
  const elements=new Map(),events={},timers=new Set(),waveCanvases=[];
  const element=s=>{if(!elements.has(s)){const el=s==='#audio'?new FakeAudio():new Element();if(['#queuePanel','#toast','#importBanner'].includes(s))el.hidden=true;elements.set(s,el);}return elements.get(s);};
  const document={querySelector:element,querySelectorAll:selector=>selector==='.audio-wave'?waveCanvases:[],addEventListener:(name,f)=>{(events['doc:'+name]||=[]).push(f);},createElement:()=>new Element(),body:Object.assign(new Element(),{append(){}}),hidden:false};
  const window={addEventListener:(name,f)=>{events[name]=f;},scrollTo(){}};
  let hash='#library';const location={href:'https://squidify.example/',get hash(){return hash;},set hash(v){hash=v;queueMicrotask(()=>events.hashchange?.());}};
  const actions={};const navigator={userAgent:'Test',platform:'Test',maxTouchPoints:0,onLine:true,storage:{persist:async()=>true},mediaSession:{setActionHandler:(name,f)=>actions[name]=f,setPositionState(){}}};
  const context=vm.createContext({document,window,navigator,location,URL,Blob,File,TextEncoder,DataView,Uint8Array,ArrayBuffer,crypto:{subtle:webcrypto.subtle,randomUUID},Audio:FakeAudio,MediaMetadata:class{constructor(value){Object.assign(this,value);}},AbortController,FormData,matchMedia:()=>({matches:false}),console:{error(){}},setTimeout:(f,ms)=>{const timer=setTimeout(f,ms);timers.add(timer);return timer;},clearTimeout:id=>{clearTimeout(id);timers.delete(id);}});
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
  return {waveCanvases,enhancements:app.enhancements,ui:app.ui,offline:app.offline,state:app.state,actions:appActions,importEntries:app.importer.importEntries,savePlaylistForm:app.playlists.savePlaylistForm,saveTrackDetails:app.playlists.saveTrackDetails,addToPlaylist:app.playlists.addToPlaylist,saveSession:app.playback.saveSession,render:app.ui.render,readRoute:app.ui.readRoute,db,element,mediaActions:actions,emitDocument:(name,event)=>events['doc:'+name]?.forEach(fn=>fn(event))};
}
test('empty library starts with working folder and file input alternatives',async t=>{
  const app=await harness(t);assert.match(app.element('#main').innerHTML,/Your music belongs here/);
  await app.actions['choose-folder']();assert.equal(app.element('#folderInput').clicks,1);
  app.actions['choose-files']();assert.equal(app.element('#fileInput').clicks,1);
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
  await Promise.all([app.offline.announceInstalled('squidify-shell-v11',true),app.offline.announceInstalled('squidify-shell-v11',true)]);
  assert.match(app.element('#toast').textContent,/Squidify updated/);
  assert.equal(app.db.stores.settings.get('installedShellVersion').value,'squidify-shell-v11');
  const reopened=await harness(t,app.db);await reopened.offline.announceInstalled('squidify-shell-v11',true);
  assert.equal(reopened.element('#toast').hidden,true);
});
test('a first install records its release without claiming an update',async t=>{
  const app=await harness(t);await app.offline.announceInstalled('squidify-shell-v11',false);
  assert.equal(app.element('#toast').hidden,true);
  assert.equal(app.db.stores.settings.get('installedShellVersion').value,'squidify-shell-v11');
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
