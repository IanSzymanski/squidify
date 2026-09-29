import * as db from './storage.js';
import { formatTime } from './core.js';
import { icon } from './icons.js';

export function createPlayback(context) {
  const { $, $$, audio, modal, nowDialog, state, byId } = context;
  const ui = context.ui;
  const toast = (...args) => context.ui.toast(...args);
  const report = (...args) => context.ui.report(...args);
  const currentList = (...args) => context.ui.currentList(...args);
  const contextName = (...args) => context.ui.contextName(...args);
  const render = (...args) => context.ui.render(...args);
  const addMusicDialog = (...args) => context.ui.addMusicDialog(...args);
  const highlightCurrent = (...args) => context.ui.highlightCurrent(...args);
  const renderPlayer = (...args) => context.ui.renderPlayer(...args);
  const updateProgress = (...args) => context.ui.updateProgress(...args);
  const renderNowPlaying = (...args) => context.ui.renderNowPlaying(...args);
  const renderQueue = (...args) => context.ui.renderQueue(...args);
  const mediaURLs = new Map(), mediaPromises = new Map();
  let activeId = null, playGeneration = 0, playIntent = false, priming = false, audioUnlocked = false, stateTimer, lastSavedAt = 0;

  async function mediaURL(id) {
    if(mediaURLs.has(id))return mediaURLs.get(id);
    if(mediaPromises.has(id))return mediaPromises.get(id);
    const promise=(async()=>{
      const item=await db.get('media',id);
      if(!item?.blob)throw new Error('This song is no longer saved on this device. Import the file again.');
      const url=URL.createObjectURL(item.blob);mediaURLs.set(id,url);
      for(const [key,value] of mediaURLs){if(mediaURLs.size<=4)break;if(key!==id&&key!==activeId&&key!==state.queue.order[state.queue.index+1]){URL.revokeObjectURL(value);mediaURLs.delete(key);}}
      return url;
    })();
    mediaPromises.set(id,promise);
    try{return await promise;}finally{mediaPromises.delete(id);}
  }
  function primeAudio() {
    if(audioUnlocked || priming)return;
    // Start the same media element within the tap so WebKit can continue after the disk read.
    const buffer=new ArrayBuffer(2044),v=new DataView(buffer);const write=(p,s)=>[...s].forEach((c,i)=>v.setUint8(p+i,c.charCodeAt(0)));
    write(0,'RIFF');v.setUint32(4,2036,true);write(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);write(36,'data');v.setUint32(40,2000,true);
    const url=URL.createObjectURL(new Blob([buffer],{type:'audio/wav'}));priming=true;audio.src=url;audio.play().then(()=>{audioUnlocked=true;}).catch(()=>{});setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  async function loadTrack(id,autoplay=true,restoreTime=0) {
    if(!byId(id))return;
    const generation=++playGeneration;playIntent=autoplay;
    if(autoplay)primeAudio();
    try {
      const url=await mediaURL(id);if(generation!==playGeneration||!byId(id)||state.queue.current!==id)return;
      priming=false;activeId=id;audio.src=url;
      const restore=()=>{if(generation===playGeneration&&restoreTime>0&&Number.isFinite(audio.duration))audio.currentTime=Math.min(restoreTime,Math.max(0,audio.duration-0.5));};
      audio.addEventListener('loadedmetadata',restore,{once:true});
      audio.load();renderPlayer();if(nowDialog.open)renderNowPlaying();highlightCurrent();if(!$('#queuePanel').hidden)renderQueue();updateMediaSession();saveSession();
      if(playIntent){try{await audio.play();}catch(e){if(generation===playGeneration&&e.name!=='AbortError'){playIntent=false;toast(e.name==='NotAllowedError'?'Tap Play to start listening.':'This browser could not play this audio format. Try MP3 or AAC/M4A.',true);}}}
      const next=state.queue.order[state.queue.index+1];if(next)mediaURL(next).catch(()=>{});
    }catch(e){if(generation!==playGeneration)return;priming=false;playIntent=false;audio.pause();toast(e.message||'Could not load this song. Import it again.',true);}
    renderPlayer();
  }
  function startView(startId=null,shuffle=false) {
    const list=currentList();if(!list.length)return addMusicDialog();
    if(shuffle)state.queue.shuffle=true;
    const id=startId || (state.queue.shuffle?list[Math.floor(Math.random()*list.length)].id:list[0].id);
    state.queue.start(list.map(t=>t.id),id,state.tracks,contextName());loadTrack(id,true);
  }
  async function togglePlay() {
    if(!state.tracks.size)return addMusicDialog();
    if(playIntent||!audio.paused){playIntent=false;audio.pause();return;}
    if(!state.queue.current)return startView();
    if(activeId!==state.queue.current||!audio.src)return loadTrack(state.queue.current,true);
    playIntent=true;
    try{await audio.play();}catch(e){playIntent=false;report(e,'Unable to play. Tap a song or try a different audio format.');}
  }
  function nextTrack(manual=true) {
    const id=state.queue.next(state.tracks,manual);
    if(!id){playIntent=false;audio.pause();renderPlayer();saveSession();return;}
    loadTrack(id,true);
  }
  function previousTrack() {
    if(audio.currentTime>3){audio.currentTime=0;updateProgress();return;}
    const id=state.queue.previous();if(id)loadTrack(id,true);
  }
  function toggleShuffle() {
    state.queue.setShuffle(!state.queue.shuffle,state.tracks);saveSession();renderPlayer();if(!$('#queuePanel').hidden)renderQueue();
    toast(state.queue.shuffle?'Balanced shuffle on. Every song once, artists spread out.':'Shuffle off.');
  }
  function cycleRepeat() {
    state.queue.repeat={off:'all',all:'one',one:'off'}[state.queue.repeat];saveSession();renderPlayer();toast({off:'Repeat off.',all:'Repeat queue on.',one:'Repeat song on.'}[state.queue.repeat]);
  }
  function updateMediaSession() {
    if(!('mediaSession' in navigator))return;
    const t=byId(state.queue.current);if(!t)return;
    try{
      const art=ui.artworkURL(t);
      navigator.mediaSession.metadata=new MediaMetadata({title:t.title,artist:t.artist,album:t.album,artwork:art?[{src:art,type:t.artwork.type}]:[{src:new URL('./icon-512.png',location.href).href,sizes:'512x512',type:'image/png'}]});
    }catch{}
  }
  function updatePositionState() {
    if(!navigator.mediaSession?.setPositionState||priming)return;
    if(Number.isFinite(audio.duration)&&audio.duration>0){try{navigator.mediaSession.setPositionState({duration:audio.duration,playbackRate:audio.playbackRate,position:Math.min(audio.currentTime,audio.duration)});}catch{}}
  }
  function saveSession(immediate=false) {
    clearTimeout(stateTimer);
    const write=()=>db.setSetting('session',{queue:state.queue.toJSON(),time:activeId===state.queue.current?audio.currentTime||0:0,volume:audio.volume,muted:audio.muted,sort:state.sort}).catch(()=>{});
    if(immediate)write();else stateTimer=setTimeout(write,250);
  }


  function bindEvents() {
  window.addEventListener('pagehide',()=>saveSession(true));
  audio.addEventListener('play',()=>{audioUnlocked=true;if(priming)return;playIntent=true;renderPlayer();if(navigator.mediaSession)navigator.mediaSession.playbackState='playing';});
  audio.addEventListener('pause',()=>{if(priming)return;playIntent=false;renderPlayer();saveSession();if(navigator.mediaSession)navigator.mediaSession.playbackState='paused';});
  audio.addEventListener('ended',()=>{if(!priming)nextTrack(false);});
  audio.addEventListener('timeupdate',()=>{if(priming)return;updateProgress();if(Date.now()-lastSavedAt>5000){lastSavedAt=Date.now();saveSession();}});
  audio.addEventListener('loadedmetadata',()=>{if(priming)return;const t=byId(activeId);if(t&&Number.isFinite(audio.duration)&&audio.duration>0){t.duration=audio.duration;db.put('tracks',t).catch(()=>{});$$(`[data-duration-id="${t.id}"]`).forEach(el=>el.textContent=formatTime(t.duration));}updateProgress();});
  audio.addEventListener('error',()=>{if(priming||!audio.getAttribute('src'))return;playIntent=false;renderPlayer();toast('This file cannot be played in this browser. Try another song or an MP3/AAC copy.',true);});
  audio.addEventListener('volumechange',()=>{renderPlayer();saveSession();});
  }

  function activeTrackId() { return activeId; }
  function isPriming() { return priming; }
  function setupMediaSession() {
      if('mediaSession' in navigator){const handlers={play:()=>{if(audio.paused)togglePlay();},pause:()=>{playIntent=false;audio.pause();},previoustrack:()=>previousTrack(),nexttrack:()=>nextTrack(),seekto:d=>{if(Number.isFinite(audio.duration))audio.currentTime=Math.min(audio.duration,Math.max(0,d.seekTime));},seekbackward:d=>{audio.currentTime=Math.max(0,audio.currentTime-(d.seekOffset||10));},seekforward:d=>{if(Number.isFinite(audio.duration))audio.currentTime=Math.min(audio.duration,audio.currentTime+(d.seekOffset||10));},stop:()=>{audio.pause();audio.currentTime=0;}};for(const [name,handler]of Object.entries(handlers))try{navigator.mediaSession.setActionHandler(name,handler);}catch{}}
  }

  const actions = {
  'play-track':b=>{if(state.queue.current===b.dataset.id)togglePlay();else startView(b.dataset.id);},
  'play-view':()=>startView(),
  'shuffle-view':()=>startView(null,true),
  'toggle-play':()=>togglePlay(),
  'previous':()=>previousTrack(),
  'next':()=>nextTrack(),
  'shuffle':()=>toggleShuffle(),
  'repeat':()=>cycleRepeat(),
  'mute':()=>{audio.muted=!audio.muted;renderPlayer();saveSession();},
  'play-next':b=>{state.queue.add(b.dataset.id,true);modal.close();saveSession();if(!$('#queuePanel').hidden)renderQueue();toast('Added to play next.');},
  'add-queue':b=>{state.queue.add(b.dataset.id);modal.close();saveSession();if(!$('#queuePanel').hidden)renderQueue();toast('Added to queue.');},
  'queue-jump':b=>{const i=Number(b.dataset.index);if(!Number.isInteger(i)||!byId(state.queue.order[i]))return;state.queue.index=i;loadTrack(state.queue.current,true);},
  'queue-remove':b=>{state.queue.removeAt(Number(b.dataset.index));saveSession();renderQueue();},
  'queue-up':b=>{const i=Number(b.dataset.index),q=state.queue;if(i<=q.index+1||i>=q.order.length)return;[q.order[i-1],q.order[i]]=[q.order[i],q.order[i-1]];saveSession();renderQueue();},
  'clear-queue':()=>{state.queue.order=state.queue.order.slice(0,state.queue.index+1);state.queue.source=[...new Set(state.queue.order)];saveSession();renderQueue();},
  'remove-track':async b=>{const id=b.dataset.id;await db.deleteTrack(id);if(id===activeId){playGeneration++;playIntent=false;audio.pause();audio.removeAttribute('src');audio.load();activeId=null;}state.tracks.delete(id);state.playlists.forEach(p=>{p.trackIds=p.trackIds.filter(x=>x!==id);});state.queue.prune(new Set(state.tracks.keys()));if(mediaURLs.has(id)){URL.revokeObjectURL(mediaURLs.get(id));mediaURLs.delete(id);}ui.releaseArtwork(id);modal.close();render();saveSession();toast('Song removed from this device.');}
  };

  return { loadTrack, togglePlay, nextTrack, previousTrack, toggleShuffle, updatePositionState, saveSession, activeTrackId, isPriming, setupMediaSession, bindEvents, actions };
}
