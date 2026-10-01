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
  removeEventListener(n,f){this.events[n]=(this.events[n]||[]).filter(entry=>entry.f!==f);}
  emit(n){const callbacks=[...(this.events[n]||[])];this.events[n]=(this.events[n]||[]).filter(x=>!x.once);for(const {f}of callbacks)f({target:this});}
  showModal(){this.open=true;}close(){this.open=false;}focus(){}click(){this.clicks=(this.clicks||0)+1;}append(...children){this.children=children;}querySelectorAll(){return [];}querySelector(){return new Element();}
}
class FakeAudio extends Element {
  constructor(){super();this._src='';this.currentSrc='';this.readyState=0;this.paused=true;this.ended=false;this.currentTime=0;this.duration=NaN;this.volume=1;this.muted=false;this.playbackRate=1;this.playCalls=[];this.loadCalls=0;}
  get src(){return this._src;}set src(value){this._src=value;this.selectSource();}
  get currentTime(){return this._time;}set currentTime(value){this._time=value;if(Number.isFinite(this.duration)&&value<this.duration)this.ended=false;}
  get soundActive(){return !this.paused&&this.readyState>=3&&(!this.nativeOutput||this.nativeOutput.category==='playback');}
  async play(){this.beforePlay?.();this.playCalls.push(this.src);this.paused=false;this.ended=false;this.emit('play');if(this.readyState>=3&&!this.deferPlaying)this.emit('playing');}
  pause(){const old=this.paused;this.paused=true;if(!old)this.emit('pause');}
  load(){this.loadCalls++;this.selectSource();}
  selectSource(){const blocked=this.blockFreshLoad?.();this.sourceSelections=(this.sourceSelections||0)+1;this.readyState=0;this.currentTime=0;this.ended=false;this.pause();this.currentSrc='';this.duration=NaN;this.emit('emptied');if(this.src&&!this.deferMetadata)this.finishMetadata(this.nextDuration??120,blocked?1:4);}
  finishMetadata(duration,ready=4){this.currentSrc=this.src;this.readyState=ready;this.duration=duration;this.emit('loadedmetadata');this.onloadedmetadata?.();if(this.readyState>=3&&!this.paused&&!this.deferPlaying)this.emit('playing');}
}

async function mediaFixture(t,options={}) {
  const db=memoryStore();
  for(const id of ['a','b','c','d'])await db.saveTrack({id,title:`Song ${id}`,artist:`Artist ${id}`,album:`Album ${id}`,duration:120},new Blob([id],{type:'audio/mpeg'}));
  await db.setSetting('session',{queue:{source:['a','b','c'],order:['a','b','c'],index:0},time:24});
  return harness(t,db,{random:()=>0.5,...options});
}
const settlePlayback=()=>new Promise(resolve=>setImmediate(resolve));

function musicSessionFixture(){
  const changes=[];let type='auto';
  const audioSession={get type(){return type;},set type(value){changes.push(value);type=value;}};
  return {changes,audioSession};
}

test('hidden iOS playlist restarts retain playback category before any timer can run',async t=>{
  for(const action of ['play','nexttrack']){
    const native=musicSessionFixture(),app=await mediaFixture(t,{isIOS:true,audioSession:native.audioSession}),audio=app.audio;
    app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();
    audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await settlePlayback();
    app.setHidden(true);
    let inAction=false;audio.beforePlay=()=>assert.equal(inAction,true,'play remains synchronous in the native action');
    inAction=true;const started=app.mediaActions[action]();inAction=false;
    assert.equal(native.audioSession.type,'playback','background ownership cannot depend on a later timer');
    await started;
    assert.equal(app.state.queue.current,'a');assert.equal(audio.paused,false);
    assert.ok(native.changes.every(type=>type==='playback'),'music never changes to a category silenced by screen lock');assert.equal(audio.loadCalls,0);
  }
});
test('Home Screen, lock and return preserve playing metadata; explicit Pause stays paused',async t=>{
  const native=musicSessionFixture(),app=await mediaFixture(t,{isIOS:true,audioSession:native.audioSession}),audio=app.element('#audio');
  await app.mediaActions.play();audio.currentTime=19;const source=audio.src,calls=audio.playCalls.length;
  app.setHidden(true);app.emitDocument('visibilitychange',{});app.emitWindow('pagehide');
  assert.equal(audio.paused,false);assert.equal(audio.src,source);assert.equal(audio.currentTime,19);assert.equal(audio.playCalls.length,calls);
  assert.equal(native.audioSession.type,'playback');assert.equal(app.mediaSession.metadata.title,'Song a');assert.equal(app.mediaSession.playbackState,'playing');
  audio.emit('waiting');assert.equal(app.mediaSession.playbackState,'playing','buffering is not a user pause');
  app.setHidden(false);app.emitDocument('visibilitychange',{});app.emitWindow('pageshow');
  assert.equal(audio.playCalls.length,calls);assert.equal(app.mediaSession.metadata.title,'Song a');
  app.mediaActions.pause();app.setHidden(true);app.emitDocument('visibilitychange',{});app.setHidden(false);app.emitWindow('pageshow');
  assert.equal(audio.paused,true);assert.equal(audio.playCalls.length,calls);assert.equal(app.mediaSession.playbackState,'paused');
});
test('unsupported and throwing Audio Session APIs retain hidden playback behavior',async t=>{
  for(const audioSession of [undefined,{set type(value){throw new Error('unsupported category');}}]){
    const app=await mediaFixture(t,{isIOS:true,audioSession}),audio=app.element('#audio');app.setHidden(true);
    await app.mediaActions.play();await app.mediaActions.nexttrack();await settlePlayback();
    assert.equal(app.state.queue.current,'b');assert.equal(audio.paused,false);assert.equal(app.mediaSession.playbackState,'playing');
  }
});
test('buffering preserves Play intent while lock-screen position waits for actual playing',async t=>{
  const app=await mediaFixture(t),audio=app.element('#audio');audio.deferPlaying=true;
  await app.mediaActions.play();
  assert.equal(audio.paused,false);assert.equal(app.mediaSession.playbackState,'playing');assert.equal(app.positions.at(-1),undefined);
  audio.emit('playing');assert.equal(app.mediaSession.playbackState,'playing');assert.equal(app.positions.at(-1).position,24);
  audio.emit('waiting');audio.emit('timeupdate');assert.equal(app.mediaSession.playbackState,'playing');assert.equal(app.positions.at(-1),undefined);
  audio.emit('playing');assert.equal(app.mediaSession.playbackState,'playing');assert.equal(app.positions.at(-1).duration,120);
  app.mediaActions.pause();assert.equal(app.mediaSession.playbackState,'paused');assert.equal(app.positions.at(-1).position,24);
});
test('slow source loading and repeated Play preserve the session across visibility changes',async t=>{
  let release;
  const db=memoryStore();for(const id of ['a','b','c','d'])await db.saveTrack({id,title:`Song ${id}`,duration:120},new Blob([id]));
  await db.setSetting('session',{queue:{source:['a','b','c','d'],order:['a','b','c','d'],index:0}});
  const original=db.get;db.get=async(store,id)=>{if(store==='media'&&id==='d')await new Promise(resolve=>{release=resolve;});return original(store,id);};
  const slow=await harness(t,db),player=slow.element('#audio');await slow.mediaActions.play();await settlePlayback();
  slow.state.queue.index=3;const loading=slow.playback.loadTrack('d',true);
  slow.setHidden(true);slow.emitDocument('visibilitychange',{});slow.playback.updateMediaSession();await slow.mediaActions.play();
  assert.equal(slow.mediaSession.playbackState,'playing');assert.ok(slow.mediaSession.metadata,'pending source must not erase the native session');
  release();await loading;assert.equal(slow.mediaSession.metadata.title,'Song d');assert.equal(player.paused,false);
});
test('a rejected old Play request cannot pause a newer song or override explicit Pause',async t=>{
  const app=await mediaFixture(t),audio=app.element('#audio');await settlePlayback();
  const play=audio.play.bind(audio);let reject;
  audio.play=()=>new Promise((resolve,fail)=>{reject=fail;});
  const previous=app.mediaActions.play();audio.play=play;await app.mediaActions.nexttrack();
  reject(Object.assign(new Error('interrupted old request'),{name:'NotAllowedError'}));await previous;
  assert.equal(app.state.queue.current,'b');assert.equal(audio.paused,false);assert.equal(app.mediaSession.playbackState,'playing');
  app.mediaActions.pause();audio.play=()=>new Promise((resolve,fail)=>{reject=fail;});
  const pending=app.mediaActions.play();app.mediaActions.pause();reject(Object.assign(new Error('paused'),{name:'AbortError'}));await pending;
  assert.equal(app.mediaSession.playbackState,'paused');assert.equal(audio.paused,true);
});
test('playback reports retain background events locally with bounded history and no song identifiers',async t=>{
  const values=new Map(),localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  let copied;const app=await mediaFixture(t,{localStorage,clipboard:{writeText:async value=>{copied=value;}}}),audio=app.element('#audio');
  await app.mediaActions.play();app.setHidden(true);app.emitDocument('visibilitychange',{});audio.pause();
  app.setHidden(false);app.emitDocument('visibilitychange',{});app.actions['playback-report']();await app.actions['copy-playback-report']();
  const report=JSON.parse(copied);assert.ok(report.events.some(x=>x.event==='hidden'));assert.ok(report.events.some(x=>x.event==='pause'&&x.hidden));
  assert.doesNotMatch(copied,/Song a|Artist a|blob:|"trackId"/);assert.equal(report.release,'v27');
  for(let i=0;i<100;i++)audio.emit('stalled');await app.actions['copy-playback-report']();assert.equal(JSON.parse(copied).events.length,80);
  const reopened=await mediaFixture(t,{localStorage,clipboard:{writeText:async value=>{copied=value;}}});await reopened.actions['copy-playback-report']();
  assert.ok(JSON.parse(copied).events.some(x=>x.event==='stalled'));assert.ok(values.size);
});
test('a long shuffled playlist preloads the exact next pass for synchronous lock-screen restart',async t=>{
  const db=memoryStore(),ids=Array.from({length:10},(_,i)=>String(i));
  for(const id of ids)await db.saveTrack({id,title:`Song ${id}`,artist:`Artist ${Number(id)%3}`,album:`Album ${id}`,duration:120},new Blob([id],{type:'audio/mpeg'}));
  await db.setSetting('session',{queue:{source:ids,order:ids,index:0,shuffle:true},time:0});
  const app=await harness(t,db,{random:()=>0.5}),audio=app.element('#audio');
  await app.mediaActions.play();await settlePlayback();
  for(let i=1;i<ids.length;i++){await app.mediaActions.nexttrack();await settlePlayback();}
  const prepared=[...app.state.queue.prepareNextPass(app.state.tracks)];
  audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await settlePlayback();
  let inAction=false;audio.beforePlay=()=>assert.equal(inAction,true,'the shuffled restart file stays cached beyond the five-source limit');
  inAction=true;const restarted=app.mediaActions.play();inAction=false;await restarted;
  assert.deepEqual([...app.state.queue.order],prepared);assert.equal(app.state.queue.current,prepared[0]);assert.equal(audio.paused,false);assert.equal(audio.loadCalls,0);
});
test('completed iOS playlists use prepared samples when fresh background loads stall at metadata',async t=>{
  for(const control of ['play','nexttrack']){
    const app=await mediaFixture(t,{isIOS:true,stallFreshLoadsWhenHidden:true,standbyDuration:77}),audio=app.audio;
    for(let pass=0;pass<2;pass++){
      app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();
      assert.equal(app.mediaSession.metadata.title,'Song c','standby metadata cannot overwrite the active song');
      app.setHidden(true);audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('pause');audio.emit('ended');
      await app.mediaActions[control]();
      assert.ok(audio.readyState>=3,'restart must not enter the reported HAVE_METADATA stall');
      assert.equal(audio.paused,false);assert.equal(app.mediaSession.playbackState,'playing');assert.equal(app.state.queue.current,'a');
      assert.equal(audio.currentTime,0);assert.equal(app.positions.at(-1),undefined);
      audio.currentTime=.2;audio.emit('timeupdate');assert.equal(app.positions.at(-1).duration,audio.duration);assert.equal(app.state.tracks.get('a').duration,audio.duration);
    }
    assert.equal(app.nativeAudios.length,2,'restarts reuse a bounded pair of native players');
  }
});
test('completion survives WebKit revising duration and clearing ended before Play or Next',async t=>{
  for(const control of ['play','nexttrack']){
    const app=await mediaFixture(t,{isIOS:true,stallFreshLoadsWhenHidden:true}),audio=app.audio;
    app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();app.setHidden(true);
    audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('pause');audio.emit('ended');
    audio.duration+=2.3;audio.ended=false;audio.emit('durationchange');
    await app.mediaActions[control]();
    assert.equal(app.state.queue.current,'a','a recorded completion, not the mutable ended property, starts the next pass');
    assert.ok(audio.readyState>=3,'Next must still activate the prepared restart');
    assert.equal(audio.currentTime,0);assert.equal(audio.paused,false);
  }
});
test('a prepared restart does not seek unnecessarily and proves clock movement before publishing position',async t=>{
  const app=await mediaFixture(t,{isIOS:true,manualTimers:true}),audio=app.audio;
  app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();app.setHidden(true);
  audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');
  const standby=app.nativeAudios[1];let seeks=0;
  Object.defineProperty(standby,'currentTime',{get(){return this._time;},set(value){seeks++;this._time=value;}});
  await app.mediaActions.play();assert.equal(seeks,0,'preloaded audio is already at zero');
  assert.equal(app.positions.at(-1),undefined,'playing alone cannot prove a completed-source restart advanced');
  audio.currentTime=.4;audio.emit('timeupdate');
  assert.equal(app.positions.at(-1).position,.4);
  const selections=audio.sourceSelections;app.runTimers(2500);
  assert.equal(audio.sourceSelections,selections,'a progressing restart is never reloaded');
});
test('false playing at zero triggers only one same-source restart recovery',async t=>{
  const app=await mediaFixture(t,{isIOS:true,manualTimers:true}),audio=app.audio;
  app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();app.setHidden(true);
  audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await app.mediaActions.play();
  const source=audio.src,selections=audio.sourceSelections;
  app.runTimers(2500);await settlePlayback();
  assert.equal(audio.src,source);assert.equal(app.state.queue.current,'a');assert.equal(audio.sourceSelections,selections+1);
  assert.equal(audio.paused,false);assert.equal(app.mediaSession.metadata.title,'Song a');
  app.runTimers(2500);app.runTimers(8000);await settlePlayback();
  assert.equal(audio.sourceSelections,selections+1,'no retry loop');
  assert.equal(audio.paused,true,'an exhausted frozen restart must not pretend to play forever');
});
test('restart recovery is cancelled by user transport, source changes and interruption',async t=>{
  for(const action of ['pause','seekto','app-seek','native-pause','nexttrack','unload','interruption']){
    let stateChange;const audioSession={type:'playback',state:'active',addEventListener:(name,fn)=>{stateChange=fn;}};
    const app=await mediaFixture(t,{isIOS:true,manualTimers:true,audioSession}),audio=app.audio;
    app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();app.setHidden(true);
    audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await app.mediaActions.play();
    if(action==='seekto')app.mediaActions.seekto({seekTime:25});
    else if(action==='app-seek')app.emitDocument('input',{target:{dataset:{},value:'25',matches:selector=>selector==='[data-seek]'}});
    else if(action==='native-pause')audio.pause();
    else if(action==='unload')await app.actions['remove-track']({dataset:{id:app.state.queue.current}});
    else if(action==='interruption'){audioSession.state='interrupted';stateChange();}
    else await app.mediaActions[action]();
    if(action==='nexttrack'){audio.currentTime=.5;audio.emit('timeupdate');}
    const selections=audio.sourceSelections,calls=audio.playCalls.length;
    app.runTimers(2500);app.runTimers(8000);await settlePlayback();
    assert.equal(audio.sourceSelections,selections,action);assert.equal(audio.playCalls.length,calls,action);
  }
});
test('recovery confirms real movement and preserves the current source and playback preferences',async t=>{
  let copied;const app=await mediaFixture(t,{isIOS:true,manualTimers:true,clipboard:{writeText:async value=>{copied=value;}}}),audio=app.audio;
  app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();app.setHidden(true);
  audio.volume=.65;audio.playbackRate=1.2;audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await app.mediaActions.nexttrack();
  app.runTimers(2500);audio.currentTime=.7;audio.emit('timeupdate');const selections=audio.sourceSelections;
  app.runTimers(2500);app.runTimers(8000);
  assert.equal(audio.sourceSelections,selections);assert.equal(audio.paused,false);assert.equal(audio.volume,.65);assert.equal(audio.playbackRate,1.2);
  assert.equal(app.positions.at(-1).position,.7);await app.actions['copy-playback-report']();
  assert.ok(JSON.parse(copied).events.some(e=>e.event==='restart-progress'&&e.recovered));
});
test('a late background timer or active seek does not trigger a restart reload',async t=>{
  for(const mode of ['late','seeking']){
    const app=await mediaFixture(t,{isIOS:true,manualTimers:true}),audio=app.audio;
    app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();app.setHidden(true);
    audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await app.mediaActions.play();
    if(mode==='buffering'){audio.readyState=1;audio.emit('waiting');}
    if(mode==='late')app.elapse(15000);
    if(mode==='seeking')audio.seeking=true;
    const selections=audio.sourceSelections;app.runTimers(2500);app.runTimers(8000);
    assert.equal(audio.sourceSelections,selections,mode);assert.equal(audio.paused,false,mode);
  }
});
test('seeking after completion clears the completion latch and resumes the selected final song',async t=>{
  const app=await mediaFixture(t,{isIOS:true}),audio=app.audio;
  app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();
  audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');
  app.emitDocument('input',{target:{dataset:{},value:'25',matches:selector=>selector==='[data-seek]'}});
  await app.mediaActions.play();assert.equal(app.state.queue.current,'c');assert.equal(audio.currentTime,25);assert.equal(audio.paused,false);
});
test('a seek cancels recovery without leaving verified playback progress disabled',async t=>{
  const app=await mediaFixture(t,{isIOS:true,manualTimers:true}),audio=app.audio;
  app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();app.setHidden(true);
  audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await app.mediaActions.play();
  app.mediaActions.seekto({seekTime:25});audio.emit('timeupdate');
  assert.equal(app.positions.at(-1),undefined,'the seek is not evidence of audio progress');
  audio.currentTime=25.4;audio.emit('timeupdate');
  assert.equal(app.positions.at(-1).position,25.4,'real advancement re-enables lock-screen position');
  const selections=audio.sourceSelections;app.runTimers(2500);assert.equal(audio.sourceSelections,selections);
});
test('late clock movement is recognized after a delayed recovery timer has been discarded',async t=>{
  const app=await mediaFixture(t,{isIOS:true,manualTimers:true}),audio=app.audio;
  app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();app.setHidden(true);
  audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await app.mediaActions.play();
  app.elapse(15000);const selections=audio.sourceSelections;app.runTimers(2500);
  audio.currentTime=.5;audio.emit('timeupdate');assert.equal(app.positions.at(-1).position,.5);
  assert.equal(audio.sourceSelections,selections);
});
test('a rejected recovery stops cleanly and an obsolete rejection cannot pause a new song',async t=>{
  for(const changeTrack of [false,true]){
    let copied,reject;
    const app=await mediaFixture(t,{isIOS:true,manualTimers:true,clipboard:{writeText:async value=>{copied=value;}}}),audio=app.audio;
    app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();app.setHidden(true);
    audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await app.mediaActions.play();
    const play=audio.play;audio.play=()=>new Promise((resolve,fail)=>{reject=fail;});
    app.runTimers(2500);audio.play=play;
    if(changeTrack)await app.mediaActions.nexttrack();
    reject(Object.assign(new Error('native rejection'),{name:'NotAllowedError'}));await settlePlayback();
    assert.equal(audio.paused,!changeTrack);assert.equal(app.mediaSession.playbackState,changeTrack?'playing':'paused');
    assert.equal(app.state.queue.current,changeTrack?'b':'a');
    if(!changeTrack){await app.actions['copy-playback-report']();assert.ok(JSON.parse(copied).events.some(e=>e.event==='restart-rejected'));}
  }
});
test('iOS skips before completion keep the existing player and inactive events cannot control a restarted queue',async t=>{
  const app=await mediaFixture(t,{isIOS:true,stallFreshLoadsWhenHidden:true}),audio=app.audio,original=app.element('#audio');
  app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();app.setHidden(true);
  await app.mediaActions.nexttrack();assert.equal(original.src,audio.src);assert.equal(original.paused,false);
  app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();
  audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await app.mediaActions.play();
  assert.notEqual(original.src,audio.src);const source=audio.src;
  original.emit('pause');original.emit('ended');original.emit('error');original.emit('loadedmetadata');
  assert.equal(app.state.queue.current,'a');assert.equal(audio.src,source);assert.equal(audio.paused,false);assert.equal(app.mediaSession.metadata.title,'Song a');
  app.mediaActions.pause();assert.equal(audio.paused,true);assert.equal(app.mediaSession.playbackState,'paused');
  await app.mediaActions.play();assert.equal(audio.paused,false);assert.equal(audio.src,source);
});
test('single-song manual restarts reuse an actively playing native source',async t=>{
  const app=await mediaFixture(t),audio=app.element('#audio');app.state.queue.source=['a'];app.state.queue.order=['a'];
  await app.mediaActions.play();audio.currentTime=37;const source=audio.src;
  audio.play=async()=>{audio.playCalls.push(audio.src);};
  await app.mediaActions.nexttrack();
  assert.equal(audio.src,source);assert.equal(audio.currentTime,0);assert.equal(audio.loadCalls,0);assert.equal(app.mediaSession.playbackState,'playing');
});

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
    assert.equal(remote.mediaSession.playbackState,'playing');
  }
});
test('Next restarts a completed playlist through both app and headphone actions with playback, metadata and context intact',async t=>{
  for(const external of [false,true]) {
    const app=await mediaFixture(t),audio=app.element('#audio');
    app.state.queue.playlistId='playlist-test';app.state.queue.context='Test playlist';
    app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();
    audio.currentTime=120;audio.ended=true;audio.paused=true;audio.emit('ended');await settlePlayback();
    assert.equal(app.state.queue.current,'c');assert.equal(audio.paused,true);assert.equal(app.mediaSession.playbackState,'paused');
    await (external?app.mediaActions.nexttrack():app.actions.next());
    assert.equal(app.state.queue.current,'a');assert.equal(audio.paused,false);assert.equal(audio.currentTime,0);
    assert.equal(app.mediaSession.metadata.title,'Song a');assert.equal(app.positions.at(-1).position,0);
    assert.equal(app.state.queue.playlistId,'playlist-test');assert.equal(app.state.queue.context,'Test playlist');assert.equal(app.state.queue.repeat,'off');
  }
});
test('Play after playlist completion reloads the first source for player, collection and external controls',async t=>{
  for(const control of ['toggle-play','play-view','external']) {
    const app=await mediaFixture(t),audio=app.element('#audio');
    app.state.queue.playlistId='playlist-test';app.state.queue.context='Test playlist';app.state.queue.viewKey=app.ui.viewKey();
    app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();
    const finalSrc=audio.src,calls=audio.playCalls.length;
    audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await settlePlayback();
    assert.equal(app.state.queue.current,'c');assert.equal(app.mediaSession.playbackState,'paused');
    audio.beforePlay=()=>{
      assert.equal(app.state.queue.current,'a','Play must restart the playlist instead of resuming its ended last song');
      assert.notEqual(audio.src,finalSrc);assert.equal(audio.ended,false);assert.equal(audio.currentTime,0,'reload resets the media element before play');
    };
    await (control==='external'?app.mediaActions.play():app.actions[control]());
    assert.equal(app.state.queue.current,'a');assert.equal(audio.paused,false);assert.equal(audio.playCalls.length,calls+1);
    assert.equal(app.mediaSession.metadata.title,'Song a');assert.equal(app.mediaSession.playbackState,'playing');assert.equal(app.positions.at(-1).position,0);
    assert.equal(app.state.queue.playlistId,'playlist-test');assert.equal(app.state.queue.context,'Test playlist');assert.equal(app.state.queue.repeat,'off');
    app.saveSession(true);assert.equal(app.db.stores.settings.get('session').value.queue.index,0);assert.equal(app.db.stores.settings.get('session').value.time,0);
  }
});
test('Play after completion reloads a single-song source and restarts a complete shuffled pass without changing modes',async t=>{
  for(const single of [true,false]) {
    const app=await mediaFixture(t),audio=app.element('#audio'),q=app.state.queue;
    if(single){q.source=['a'];q.order=['a'];q.index=0;}else{q.setShuffle(true,app.state.tracks);q.index=q.order.length-1;}
    await app.playback.loadTrack(q.current,true);const lastSrc=audio.src;
    audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await settlePlayback();
    audio.beforePlay=()=>{assert.equal(audio.ended,false);assert.equal(audio.currentTime,0);};
    await app.actions['toggle-play']();
    assert.equal(q.index,0);assert.equal(audio.paused,false);assert.equal(q.shuffle,!single);assert.equal(q.repeat,'off');
    assert.equal(audio.playCalls.at(-1),audio.src);assert.equal(app.positions.at(-1).position,0);
    if(single)assert.equal(audio.src,lastSrc);else assert.deepEqual([...q.order].sort(),['a','b','c']);
    audio.beforePlay=null;audio.currentTime=17;await app.actions['toggle-play']();await app.actions['toggle-play']();
    assert.equal(audio.currentTime,17,'ordinary pause/resume must retain position');assert.equal(q.index,0);
  }
});
test('lock-screen Play starts the first song within the external action after the final song ends',async t=>{
  const app=await mediaFixture(t),audio=app.element('#audio');
  app.state.queue.index=2;await app.playback.loadTrack('c',true);await settlePlayback();
  audio.currentTime=audio.duration;audio.ended=true;audio.paused=true;audio.emit('ended');await settlePlayback();
  let inNativeAction=false;
  audio.beforePlay=()=>assert.equal(inNativeAction,true,'cached restart must play inside the lock-screen action');
  const count=audio.playCalls.length;
  inNativeAction=true;const started=app.mediaActions.play();inNativeAction=false;
  assert.equal(app.state.queue.current,'a');assert.equal(audio.playCalls.length,count+1);assert.equal(audio.paused,false);
  await started;assert.equal(app.mediaSession.playbackState,'playing');assert.equal(app.positions.at(-1).position,0);
});
test('output icon follows the exposed active sink and named system default, never a merely available headset',async t=>{
  let outputs=[{kind:'audiooutput',deviceId:'default',label:'Default - Speakers'},{kind:'audiooutput',deviceId:'buds',label:'AirPods Pro'},{kind:'audiooutput',deviceId:'speaker',label:'Speakers'}],changed,calls=0;
  const mediaDevices={enumerateDevices:async()=>{calls++;return outputs;},addEventListener:(name,f)=>{if(name==='devicechange')changed=f;}};
  const app=await mediaFixture(t,{sinkId:'',mediaDevices}),audio=app.element('#audio'),button=app.outputControls[0];await settlePlayback();
  assert.equal(button.classList.contains('active'),true);assert.match(button.attrs['aria-label'],/Speakers/);assert.doesNotMatch(button.innerHTML,/headphone/i);
  outputs=outputs.map(d=>d.deviceId==='default'?{...d,label:'Default - AirPods Pro'}:d);await changed();
  assert.match(button.attrs['aria-label'],/AirPods/);assert.match(button.innerHTML,/M3 14v-3/,'headphone icon is selected');
  audio.sinkId='speaker';audio.emit('sinkchange');await settlePlayback();assert.equal(button.attrs['aria-label'],'Speakers');
  audio.sinkId='missing';audio.emit('sinkchange');await settlePlayback();assert.equal(button.classList.contains('active'),false);
  const before=calls,unsupported=await mediaFixture(t,{mediaDevices});await unsupported.mediaActions.play();await settlePlayback();
  assert.equal(calls,before,'an unsupported browser never probes device listings or requests permissions');
  assert.equal(unsupported.outputControls[0].classList.contains('active'),false);
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
  const elements=new Map(),events={},timers=new Set(),waveCanvases=[],outputControls=[new Element()];
  const manualTimers=new Map();let timerId=0,clock=Date.now();
  const nativeAudios=[];
  const makeAudio=()=>{const el=new FakeAudio();if(nativeAudios.length&&mediaOptions.standbyDuration)el.nextDuration=mediaOptions.standbyDuration;nativeAudios.push(el);el.blockFreshLoad=()=>mediaOptions.stallFreshLoadsWhenHidden&&document.hidden&&!nativeAudios.some(a=>!a.paused&&!a.ended);return el;};
  const element=s=>{if(!elements.has(s)){const el=s==='#audio'?makeAudio():new Element();if(s==='#audio'){if(mediaOptions.sinkId!==undefined)el.sinkId=mediaOptions.sinkId;el.nativeOutput=mediaOptions.nativeOutput;}if(['#queuePanel','#toast','#importBanner'].includes(s))el.hidden=true;elements.set(s,el);}return elements.get(s);};
  const document={querySelector:element,querySelectorAll:selector=>selector==='.audio-wave'?waveCanvases:selector==='.output-control'?outputControls:[],addEventListener:(name,f)=>{(events['doc:'+name]||=[]).push(f);},createElement:tag=>tag==='audio'?makeAudio():new Element(),body:Object.assign(new Element(),{append(){}}),hidden:false};
  const window={addEventListener:(name,f)=>{events[name]=f;},scrollTo(){}};
  let hash='#library';const location={href:'https://squidify.example/',get hash(){return hash;},set hash(v){hash=v;queueMicrotask(()=>events.hashchange?.());}};
  const actions={},registrations=[],positions=[];
  const mediaSession={setActionHandler:(name,f)=>{registrations.push(name);if(mediaOptions.unsupported?.includes(name))throw new Error('Unsupported action');actions[name]=f;},setPositionState:value=>{if(mediaOptions.positionThrows)throw new Error('Unsupported position');positions.push(value);}};
  const navigator={userAgent:mediaOptions.isIOS?'iPhone':'Test',platform:'Test',maxTouchPoints:0,onLine:true,storage:{persist:async()=>true},mediaSession:mediaOptions.absent?undefined:mediaSession};
  if(mediaOptions.serviceWorker)navigator.serviceWorker=mediaOptions.serviceWorker;
  if(mediaOptions.mediaDevices)navigator.mediaDevices=mediaOptions.mediaDevices;
  if(mediaOptions.audioSession)navigator.audioSession=mediaOptions.audioSession;
  if(mediaOptions.clipboard)navigator.clipboard=mediaOptions.clipboard;
  if(mediaOptions.stateThrows)Object.defineProperty(mediaSession,'playbackState',{set(){throw new Error('Unsupported state');}});
  const context=vm.createContext({document,window,navigator,location,localStorage:mediaOptions.localStorage,URL,Blob,File,TextEncoder,DataView,Uint8Array,ArrayBuffer,crypto:{subtle:webcrypto.subtle,randomUUID},Audio:FakeAudio,MediaMetadata:class{constructor(value){Object.assign(this,value);}},AbortController,FormData,matchMedia:()=>({matches:false}),console:{error(){}},setTimeout:(f,ms)=>{const timer=setTimeout(f,ms);timers.add(timer);return timer;},clearTimeout:id=>{clearTimeout(id);timers.delete(id);}});
  if(mediaOptions.random)context.Math=Object.assign(Object.create(Math),{random:mediaOptions.random});
  if(mediaOptions.manualTimers){context.setTimeout=(fn,ms)=>{const id=++timerId;manualTimers.set(id,{fn,ms});return id;};context.clearTimeout=id=>manualTimers.delete(id);context.Date=class extends Date{static now(){return clock;}};}
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
  return {elapse:ms=>{clock+=ms;},runTimers:ms=>{for(const [id,timer]of [...manualTimers])if(timer.ms===ms){manualTimers.delete(id);timer.fn();}},audio:app.audio,nativeAudios,setHidden:value=>{document.hidden=value;},outputControls,waveCanvases,enhancements:app.enhancements,ui:app.ui,offline:app.offline,state:app.state,actions:appActions,importEntries:app.importer.importEntries,savePlaylistForm:app.playlists.savePlaylistForm,saveTrackDetails:app.playlists.saveTrackDetails,addToPlaylist:app.playlists.addToPlaylist,saveSession:app.playback.saveSession,render:app.ui.render,readRoute:app.ui.readRoute,db,element,mediaActions:actions,mediaSession,registrations,positions,playback:app.playback,emitDocument:(name,event)=>events['doc:'+name]?.forEach(fn=>fn(event)),emitWindow:name=>events[name]?.()};
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
  await Promise.all([app.offline.announceInstalled('squidify-shell-v27',true),app.offline.announceInstalled('squidify-shell-v27',true)]);
  assert.match(app.element('#toast').textContent,/Squidify updated/);
  assert.equal(app.db.stores.settings.get('installedShellVersion').value,'squidify-shell-v27');
  const reopened=await harness(t,app.db);await reopened.offline.announceInstalled('squidify-shell-v27',true);
  assert.equal(reopened.element('#toast').hidden,true);
});
test('a first install records its release without claiming an update',async t=>{
  const app=await harness(t);await app.offline.announceInstalled('squidify-shell-v27',false);
  assert.equal(app.element('#toast').hidden,true);
  assert.equal(app.db.stores.settings.get('installedShellVersion').value,'squidify-shell-v27');
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

test('rapid Previous at the first song avoids repeated native plays and zero seeks',async t=>{
  const app=await mediaFixture(t,{isIOS:true,manualTimers:true}),audio=app.audio;
  await app.mediaActions.play();audio.currentTime=1.4;
  const calls=audio.playCalls.length,selections=audio.sourceSelections;
  let seeks=0;const native=app.nativeAudios[0];
  Object.defineProperty(native,'currentTime',{get(){return this._time;},set(value){seeks++;this._time=value;}});
  for(let i=0;i<30;i++)await app.mediaActions.previoustrack();
  assert.equal(app.state.queue.index,0);assert.equal(seeks,1);
  assert.equal(audio.playCalls.length,calls);assert.equal(audio.sourceSelections,selections);
  app.runTimers(2500);assert.equal(audio.sourceSelections,selections+1,'a frozen ordinary restart is recovered');
});
test('late same-song play failure cannot override a newer Pause then Play',async t=>{
  const app=await mediaFixture(t),audio=app.audio;await settlePlayback();
  const nativePlay=audio.play;let reject;
  audio.play=()=>new Promise((resolve,fail)=>{reject=fail;});
  const old=app.mediaActions.play();app.mediaActions.pause();audio.play=nativePlay;
  await app.mediaActions.play();reject(Object.assign(new Error('old request'),{name:'NotAllowedError'}));await old;
  assert.doesNotMatch(app.element('#toast').textContent,/Unable to play/);
  assert.equal(audio.paused,false);assert.equal(app.mediaSession.playbackState,'playing');
});
test('late native play event after explicit Pause is stopped',async t=>{
  const app=await mediaFixture(t),audio=app.audio;
  await app.mediaActions.play();app.mediaActions.pause();audio.paused=false;audio.emit('play');
  assert.equal(audio.paused,true);assert.equal(app.mediaSession.playbackState,'paused');
});
test('metadata-only stall after ordinary Next gets one bounded recovery and honors Pause',async t=>{
  for(const paused of [false,true]){
    const app=await mediaFixture(t,{isIOS:true,manualTimers:true}),audio=app.audio;
    await app.mediaActions.play();await app.mediaActions.nexttrack();
    audio.readyState=1;audio.emit('waiting');const selections=audio.sourceSelections;
    app.runTimers(2500);assert.equal(audio.sourceSelections,selections,'do not retry normal short buffering');
    if(paused)app.mediaActions.pause();
    app.runTimers(8000);assert.equal(audio.sourceSelections,selections+(paused?0:1));
    if(!paused){app.runTimers(2500);app.runTimers(8000);assert.equal(audio.sourceSelections,selections+1);}
    assert.equal(audio.paused,true);
  }
});
test('frozen resume recovery keeps the listening position',async t=>{
  const app=await mediaFixture(t,{isIOS:true,manualTimers:true}),audio=app.audio;
  await app.mediaActions.play();audio.currentTime=47;audio.emit('timeupdate');app.mediaActions.pause();
  const before=audio.sourceSelections;await app.mediaActions.play();app.runTimers(2500);
  assert.equal(audio.sourceSelections,before+1);
  assert.equal(audio.currentTime,47);assert.equal(app.state.queue.current,'a');
  audio.currentTime=47.5;audio.emit('timeupdate');const selections=audio.sourceSelections;
  app.runTimers(2500);app.runTimers(8000);assert.equal(audio.sourceSelections,selections);assert.equal(audio.paused,false);
});
test('rapid mixed transport bursts retain the final queue selection and pause intent',async t=>{
  const app=await mediaFixture(t,{isIOS:true,manualTimers:true}),audio=app.audio;
  await app.mediaActions.play();await settlePlayback();
  const requests=[];
  for(let i=0;i<20;i++){
    requests.push(app.mediaActions.nexttrack(),app.mediaActions.previoustrack());
    app.mediaActions.seekto({seekTime:0});app.mediaActions.pause();requests.push(app.mediaActions.play());
  }
  app.mediaActions.pause();await Promise.all(requests);await settlePlayback();
  app.runTimers(2500);app.runTimers(8000);
  assert.equal(app.state.queue.current,'a');assert.equal(audio.paused,true);assert.equal(app.mediaSession.playbackState,'paused');
});
test('recovery issues fresh play when the replaced source play promise is still pending',async t=>{
  const app=await mediaFixture(t,{isIOS:true,manualTimers:true}),audio=app.audio;
  await app.mediaActions.play();const nativePlay=audio.play;let reject;
  audio.play=()=>{audio.paused=false;return new Promise((resolve,fail)=>{reject=fail;});};
  const loading=app.mediaActions.nexttrack();audio.readyState=1;audio.emit('waiting');
  audio.play=nativePlay;const calls=audio.playCalls.length;app.runTimers(8000);
  assert.equal(audio.playCalls.length,calls+1);
  reject(Object.assign(new Error('obsolete request'),{name:'NotAllowedError'}));await loading;
  assert.equal(app.mediaSession.playbackState,'playing');assert.equal(audio.paused,false);
});
