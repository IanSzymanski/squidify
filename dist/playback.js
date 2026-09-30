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
  let eventsBound = false, mediaSessionBound = false;
  let metadataReady = false, restorePosition = 0;

  async function mediaURL(id) {
    if(mediaURLs.has(id))return mediaURLs.get(id);
    if(mediaPromises.has(id))return mediaPromises.get(id);
    const promise=(async()=>{
      const item=await db.get('media',id);
      if(!item?.blob)throw new Error('This song is no longer saved on this device. Import the file again.');
      const url=URL.createObjectURL(item.blob);mediaURLs.set(id,url);
      for(const [key,value] of mediaURLs){if(mediaURLs.size<=4)break;if(key!==id&&key!==activeId&&key!==state.queue.order[state.queue.index+1]&&key!==state.queue.order[state.queue.index-1]){URL.revokeObjectURL(value);mediaURLs.delete(key);}}
      return url;
    })();
    mediaPromises.set(id,promise);
    try{return await promise;}finally{mediaPromises.delete(id);}
  }
  function prepareNeighbors() {
    const q=state.queue;
    const ids=[q.order[q.index-1],q.order[q.index+1],q.source[0]];
    for(const id of new Set(ids))if(id&&byId(id))mediaURL(id).catch(()=>{});
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
    // Keep the native session alive while disk access finishes. Only its
    // position is cleared; ending the session here can suspend a locked page.
    metadataReady=false;updatePositionState();
    if(autoplay)primeAudio();
    try {
      // Cached neighbors must set the source and call play inside the media
      // action itself, without an await that gives WebKit a suspension point.
      const url=mediaURLs.get(id)||await mediaURL(id);if(generation!==playGeneration||!byId(id)||state.queue.current!==id)return;
      priming=false;activeId=id;restorePosition=restoreTime;audio.src=url;
      audio.load();
      const started=playIntent?audio.play().catch(e=>{
        if(generation===playGeneration&&e.name!=='AbortError'){
          playIntent=false;updatePlaybackState();updatePositionState();
          toast(e.name==='NotAllowedError'?'Tap Play to start listening.':'This browser could not play this audio format. Try MP3 or AAC/M4A.',true);
        }
      }):null;
      prepareNeighbors();context.enhancements?.loadWave(id);renderPlayer();if(nowDialog.open)renderNowPlaying();highlightCurrent();if(!$('#queuePanel').hidden)renderQueue();updateMediaSession();saveSession();
      if(started)await started;
    }catch(e){if(generation!==playGeneration)return;unloadAudio();toast(e.message||'Could not load this song. Import it again.',true);}
    renderPlayer();
  }
  function isCurrentView(){return !!state.queue.current && (state.queue.viewKey===ui.viewKey() || (!state.queue.viewKey && state.queue.context===contextName() && currentList().some(t=>t.id===state.queue.current)));}
  function startView(startId=null,shuffle=false) {
    const list=currentList();if(!list.length)return addMusicDialog();
    if(shuffle)state.queue.shuffle=true;
    const id=startId || (state.queue.shuffle?list[Math.floor(Math.random()*list.length)].id:list[0].id);
    state.queue.start(list.map(t=>t.id),id,state.tracks,contextName());state.queue.playlistId=state.view==='playlist'?state.detail:null;state.queue.viewKey=ui.viewKey();loadTrack(id,true);
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
    if(!id){playIntent=false;audio.pause();renderPlayer();updatePlaybackState();updatePositionState();saveSession();return;}
    return loadTrack(id,true);
  }
  function previousTrack(restart=true) {
    if(restart&&hasCurrentMetadata()&&audio.currentTime>3){seekTo(0);return;}
    const id=state.queue.previous();if(id){return loadTrack(id,true);}
  }
  function toggleShuffle() {
    state.queue.setShuffle(!state.queue.shuffle,state.tracks);prepareNeighbors();saveSession();renderPlayer();if(!$('#queuePanel').hidden)renderQueue();
    toast(state.queue.shuffle?'Balanced shuffle on. Every song once, artists spread out.':'Shuffle off.');
  }
  function cycleRepeat() {
    state.queue.repeat={off:'all',all:'one',one:'off'}[state.queue.repeat];saveSession();renderPlayer();toast({off:'Repeat off.',all:'Repeat queue on.',one:'Repeat song on.'}[state.queue.repeat]);
  }
  function updateMediaSession() {
    if(!navigator.mediaSession)return;
    const t=loadedTrack();if(!t){clearMediaSession();return;}
    try{
      const cover=ui.mediaArtwork?.();
      const art=cover?.src||ui.artworkURL(t);
      navigator.mediaSession.metadata=new MediaMetadata({title:t.title,artist:t.artist,album:t.album,artwork:art?[{src:art,type:cover?.type||t.artwork?.type}]:[{src:new URL('./icon-512-v9.png',location.href).href,sizes:'512x512',type:'image/png'}]});
    }catch{}
    updatePlaybackState();updatePositionState();
  }
  function loadedTrack() {
    return !priming&&audio.getAttribute('src')&&activeId===state.queue.current?byId(activeId):null;
  }
  function hasCurrentMetadata() {
    return !!loadedTrack()&&metadataReady&&audio.readyState>=1&&audio.currentSrc===mediaURLs.get(activeId);
  }
  function progress() {
    const ready=hasCurrentMetadata();
    return {ready,duration:ready&&Number.isFinite(audio.duration)?audio.duration:byId(state.queue.current)?.duration||0,time:ready&&Number.isFinite(audio.currentTime)?audio.currentTime:0};
  }
  function updatePlaybackState() {
    if(!navigator.mediaSession)return;
    try{navigator.mediaSession.playbackState=loadedTrack()?(!audio.paused&&!audio.ended?'playing':'paused'):'none';}catch{}
  }
  function clearMediaSession() {
    const session=navigator.mediaSession;if(!session)return;
    try{session.metadata=null;}catch{}
    try{session.playbackState='none';}catch{}
    try{session.setPositionState?.();}catch{}
  }
  function updatePositionState() {
    const session=navigator.mediaSession;if(!session?.setPositionState)return;
    const {duration,currentTime,playbackRate}=audio;
    try{
      if(hasCurrentMetadata()&&Number.isFinite(duration)&&duration>0&&Number.isFinite(currentTime)&&Number.isFinite(playbackRate)&&playbackRate>0)
        session.setPositionState({duration,playbackRate,position:Math.min(duration,Math.max(0,currentTime))});
      else session.setPositionState();
    }catch{}
  }
  function seekTo(time) {
    if(!hasCurrentMetadata()||!Number.isFinite(time)||!Number.isFinite(audio.duration)||audio.duration<=0)return;
    audio.currentTime=Math.min(audio.duration,Math.max(0,time));
    updateProgress();updatePositionState();saveSession();
  }
  function pausePlayback() {
    playIntent=false;audio.pause();updatePlaybackState();updatePositionState();saveSession();
  }
  function unloadAudio() {
    playGeneration++;playIntent=false;priming=false;activeId=null;metadataReady=false;restorePosition=0;
    audio.pause();audio.removeAttribute('src');audio.load();clearMediaSession();
  }
  function saveSession(immediate=false) {
    clearTimeout(stateTimer);
    const write=()=>db.setSetting('session',{queue:state.queue.toJSON(),time:activeId===state.queue.current?audio.currentTime||0:0,volume:audio.volume,muted:audio.muted,sort:state.sort}).catch(()=>{});
    if(immediate)write();else stateTimer=setTimeout(write,250);
  }


  function bindEvents() {
  if(eventsBound)return;eventsBound=true;
  window.addEventListener('pagehide',()=>saveSession(true));
  audio.addEventListener('play',()=>{audioUnlocked=true;if(priming)return;playIntent=true;renderPlayer();updatePlaybackState();updatePositionState();});
  audio.addEventListener('pause',()=>{if(priming||!audio.paused||!hasCurrentMetadata())return;playIntent=false;renderPlayer();saveSession();updatePlaybackState();updatePositionState();});
  audio.addEventListener('ended',()=>{if(!priming)nextTrack(false);});
  audio.addEventListener('timeupdate',()=>{if(!hasCurrentMetadata())return;updateProgress();updatePositionState();if(Date.now()-lastSavedAt>5000){lastSavedAt=Date.now();saveSession();}});
  audio.addEventListener('loadedmetadata',()=>{
    if(!loadedTrack()||audio.readyState<1||audio.currentSrc!==mediaURLs.get(activeId))return;
    metadataReady=true;
    if(restorePosition>0&&Number.isFinite(audio.duration))audio.currentTime=Math.min(restorePosition,Math.max(0,audio.duration-0.5));
    restorePosition=0;
    const t=byId(activeId);if(t&&Number.isFinite(audio.duration)&&audio.duration>0){t.duration=audio.duration;db.put('tracks',t).catch(()=>{});$$(`[data-duration-id="${t.id}"]`).forEach(el=>el.textContent=formatTime(t.duration));}updateProgress();updateMediaSession();
  });
  for(const name of ['seeking','seeked','durationchange','ratechange'])audio.addEventListener(name,()=>{if(priming)return;updateProgress();updatePositionState();if(name==='seeked')saveSession();});
  audio.addEventListener('emptied',()=>{if(audio.readyState>=1)return;metadataReady=false;if(activeId)updatePositionState();else clearMediaSession();});
  audio.addEventListener('error',()=>{if(priming||!audio.getAttribute('src'))return;unloadAudio();renderPlayer();toast('This file cannot be played in this browser. Try another song or an MP3/AAC copy.',true);});
  audio.addEventListener('volumechange',()=>{renderPlayer();saveSession();});
  }

  function activeTrackId() { return activeId; }
  function isPriming() { return priming; }
  function setupMediaSession() {
    const session=navigator.mediaSession;
    if(mediaSessionBound||typeof session?.setActionHandler!=='function')return;
    mediaSessionBound=true;
    const handlers={
      play:()=>{if(audio.paused&&!playIntent)return togglePlay();},
      pause:()=>pausePlayback(),
      previoustrack:()=>previousTrack(),
      nexttrack:()=>nextTrack(),
      seekto:details=>seekTo(details?.seekTime),
      // Advertise music controls; never turn a seek command into a song skip.
      seekbackward:null,
      seekforward:null,
      stop:()=>{pausePlayback();seekTo(0);}
    };
    for(const [name,handler]of Object.entries(handlers))try{session.setActionHandler(name,handler);}catch{}
    updateMediaSession();
  }

  const actions = {
  'play-track':b=>{if(state.queue.current===b.dataset.id)togglePlay();else startView(b.dataset.id);},
  'play-view':()=>isCurrentView()?togglePlay():startView(),
  'shuffle-view':()=>startView(null,true),
  'toggle-play':()=>togglePlay(),
  'previous':()=>previousTrack(),
  'next':()=>nextTrack(),
  'shuffle':()=>toggleShuffle(),
  'repeat':()=>cycleRepeat(),
  'mute':()=>{audio.muted=!audio.muted;renderPlayer();saveSession();},
  'play-next':b=>{state.queue.add(b.dataset.id,true);prepareNeighbors();modal.close();saveSession();if(!$('#queuePanel').hidden)renderQueue();toast('Added to play next.');},
  'add-queue':b=>{state.queue.add(b.dataset.id);prepareNeighbors();modal.close();saveSession();if(!$('#queuePanel').hidden)renderQueue();toast('Added to queue.');},
  'queue-jump':b=>{const i=Number(b.dataset.index);if(!Number.isInteger(i)||!byId(state.queue.order[i]))return;state.queue.index=i;loadTrack(state.queue.current,true);},
  'queue-remove':b=>{state.queue.removeAt(Number(b.dataset.index));saveSession();renderQueue();},
  'queue-up':b=>{const i=Number(b.dataset.index),q=state.queue;if(i<=q.index+1||i>=q.order.length)return;[q.order[i-1],q.order[i]]=[q.order[i],q.order[i-1]];saveSession();renderQueue();},
  'clear-queue':()=>{state.queue.order=state.queue.order.slice(0,state.queue.index+1);state.queue.source=[...new Set(state.queue.order)];saveSession();renderQueue();},
  'remove-track':async b=>{const id=b.dataset.id;await db.deleteTrack(id);if(id===activeId||id===state.queue.current)unloadAudio();state.tracks.delete(id);state.playlists.forEach(p=>{p.trackIds=p.trackIds.filter(x=>x!==id);});state.queue.prune(new Set(state.tracks.keys()));if(mediaURLs.has(id)){URL.revokeObjectURL(mediaURLs.get(id));mediaURLs.delete(id);}ui.releaseArtwork(id);modal.close();render();saveSession();toast('Song removed from this device.');}
  };

  return { isCurrentView, loadTrack, togglePlay, nextTrack, previousTrack, toggleShuffle, progress, updatePositionState, updateMediaSession, saveSession, activeTrackId, isPriming, setupMediaSession, bindEvents, actions };
}
