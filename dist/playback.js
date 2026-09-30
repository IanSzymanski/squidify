import * as db from './storage.js';
import { formatTime } from './core.js';
import { icon } from './icons.js';
import { createPlaybackReport } from './playback-report.js';

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
  let metadataReady = false, restorePosition = 0, playbackStarted = false;
  const playbackReport=createPlaybackReport(context);

  function musicSession() {
    try{
      const session=navigator.audioSession;if(!session)return;
      // Keep one music category for the entire session. Ambient is silenced
      // by screen lock on iOS; restoring it in a timer can lose audio focus.
      if(session.type!=='playback')session.type='playback';
    }catch{}
  }
  function requestAudioPlay() {
    musicSession();updatePlaybackState();playbackReport.record('play-request');
    return audio.play();
  }

  async function mediaURL(id) {
    if(mediaURLs.has(id))return mediaURLs.get(id);
    if(mediaPromises.has(id))return mediaPromises.get(id);
    const promise=(async()=>{
      const item=await db.get('media',id);
      if(!item?.blob)throw new Error('This song is no longer saved on this device. Import the file again.');
      const url=URL.createObjectURL(item.blob);mediaURLs.set(id,url);
      for(const [key,value] of mediaURLs){if(mediaURLs.size<=5)break;if(key!==id&&key!==activeId&&key!==state.queue.order[state.queue.index+1]&&key!==state.queue.order[state.queue.index-1]&&key!==state.queue.preparedPass?.order[0]){URL.revokeObjectURL(value);mediaURLs.delete(key);}}
      return url;
    })();
    mediaPromises.set(id,promise);
    try{return await promise;}finally{mediaPromises.delete(id);}
  }
  function prepareNeighbors() {
    const q=state.queue;
    const restartId=q.prepareNextPass(state.tracks)[0];
    const ids=[q.order[q.index-1],q.order[q.index+1],restartId];
    for(const id of new Set(ids))if(id&&byId(id))mediaURL(id).catch(()=>{});
    if(audio.prepareRestart){
      if(!restartId){audio.clearRestart();return;}
      const prepare=url=>{if(byId(restartId)&&state.queue.prepareNextPass(state.tracks)[0]===restartId)try{audio.prepareRestart(url);}catch{playbackReport.record('restart-prepare-failed');}};
      if(mediaURLs.has(restartId))prepare(mediaURLs.get(restartId));else mediaURL(restartId).then(prepare).catch(()=>{});
    }
  }
  function primeAudio() {
    if(audioUnlocked || priming)return;
    musicSession();
    // Start the same media element within the tap so WebKit can continue after the disk read.
    const buffer=new ArrayBuffer(2044),v=new DataView(buffer);const write=(p,s)=>[...s].forEach((c,i)=>v.setUint8(p+i,c.charCodeAt(0)));
    write(0,'RIFF');v.setUint32(4,2036,true);write(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);write(36,'data');v.setUint32(40,2000,true);
    const url=URL.createObjectURL(new Blob([buffer],{type:'audio/wav'}));priming=true;audio.src=url;audio.play().then(()=>{audioUnlocked=true;}).catch(()=>{});setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  async function loadTrack(id,autoplay=true,restoreTime=0) {
    if(!byId(id))return;
    const sourceEnded=audio.ended;
    const wasPlaying=playbackStarted&&!audio.paused&&!audio.ended;
    const generation=++playGeneration;playIntent=autoplay;
    // Keep the native session alive while disk access finishes. Only its
    // position is cleared; ending the session here can suspend a locked page.
    metadataReady=false;playbackStarted=false;updatePlaybackState();updatePositionState();playbackReport.record('load-track');
    if(autoplay)primeAudio();
    try {
      // Cached neighbors must set the source and call play inside the media
      // action itself, without an await that gives WebKit a suspension point.
      const url=mediaURLs.get(id)||await mediaURL(id);if(generation!==playGeneration||!byId(id)||state.queue.current!==id)return;
      const prepared=autoplay&&sourceEnded&&!!audio.activateRestart?.(url);
      if(sourceEnded)playbackReport.record(prepared?'restart-prepared':'restart-source-load');
      const sameSource=prepared||(activeId===id&&audio.currentSrc===url&&audio.readyState>=1);
      priming=false;activeId=id;restorePosition=restoreTime;
      if(sameSource){
        // Reuse an already loaded source for single-song/repeat-one restarts.
        metadataReady=true;playbackStarted=wasPlaying;audio.currentTime=restoreTime>0&&Number.isFinite(audio.duration)?Math.min(restoreTime,Math.max(0,audio.duration-0.5)):0;restorePosition=0;
      }else{
        // Assigning src already selects the new resource. An extra load()
        // tears down the native player again during a lock-screen handoff.
        audio.src=url;
      }
      if(prepared)refreshMetadata();
      const started=playIntent?requestAudioPlay().catch(e=>{
        if(generation===playGeneration&&e.name!=='AbortError'){
          playIntent=false;playbackStarted=false;updatePlaybackState();updatePositionState();
          playbackReport.record('play-rejected',{error:e.name});
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
    // Resume cannot reliably revive an ended WebKit source. A completed queue
    // starts a fresh pass through the same load-and-play path as manual Next.
    if(audio.ended&&loadedTrack()&&state.queue.index===state.queue.order.length-1)return nextTrack(true);
    if(playIntent||!audio.paused)return pausePlayback();
    return resumePlayback();
  }
  async function resumePlayback() {
    if(!state.tracks.size)return addMusicDialog();
    if(audio.ended&&loadedTrack()&&state.queue.index===state.queue.order.length-1)return nextTrack(true);
    if(!state.queue.current)return startView();
    // External Play is idempotent, including while a source read is pending.
    if(playIntent&&!loadedTrack()){musicSession();updatePlaybackState();return;}
    if(activeId!==state.queue.current||!audio.src)return loadTrack(state.queue.current,true);
    playIntent=true;const generation=playGeneration;
    try{await requestAudioPlay();}catch(e){
      if(generation!==playGeneration||!playIntent||e.name==='AbortError')return;
      playIntent=false;playbackStarted=false;updatePlaybackState();updatePositionState();playbackReport.record('play-rejected',{error:e.name});report(e,'Unable to play. Tap a song or try a different audio format.');
    }
  }
  function nextTrack(manual=true) {
    const id=state.queue.next(state.tracks,manual);
    if(!id){pausePlayback();renderPlayer();return;}
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
    const t=loadedTrack();if(!t){
      if(playIntent&&byId(state.queue.current)){updatePlaybackState();updatePositionState();return;}
      clearMediaSession();return;
    }
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
    // Declared state expresses the user's transport intent. Buffering and
    // source selection are part of playing; only position waits for samples.
    const hasSession=!!loadedTrack()||(playIntent&&!!byId(state.queue.current));
    try{navigator.mediaSession.playbackState=hasSession?(playIntent||(!audio.paused&&!audio.ended)?'playing':'paused'):'none';}catch{}
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
      if(hasCurrentMetadata()&&(!playIntent||playbackStarted)&&Number.isFinite(duration)&&duration>0&&Number.isFinite(currentTime)&&Number.isFinite(playbackRate)&&playbackRate>0)
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
    playIntent=false;playbackStarted=false;audio.pause();updatePlaybackState();updatePositionState();saveSession();playbackReport.record('pause-request');
  }
  function unloadAudio() {
    playGeneration++;playIntent=false;priming=false;activeId=null;metadataReady=false;restorePosition=0;playbackStarted=false;
    audio.pause();audio.removeAttribute('src');audio.load();audio.clearRestart?.();clearMediaSession();
  }
  function saveSession(immediate=false) {
    clearTimeout(stateTimer);
    const write=()=>db.setSetting('session',{queue:state.queue.toJSON(),time:hasCurrentMetadata()?audio.currentTime||0:0,volume:audio.volume,muted:audio.muted,sort:state.sort}).catch(()=>{});
    if(immediate)write();else stateTimer=setTimeout(write,250);
  }
  function refreshMetadata(){
    if(!loadedTrack()||audio.readyState<1||audio.currentSrc!==mediaURLs.get(activeId))return;
    metadataReady=true;
    if(restorePosition>0&&Number.isFinite(audio.duration))audio.currentTime=Math.min(restorePosition,Math.max(0,audio.duration-0.5));
    restorePosition=0;
    const t=byId(activeId);if(t&&Number.isFinite(audio.duration)&&audio.duration>0){t.duration=audio.duration;db.put('tracks',t).catch(()=>{});$$(`[data-duration-id="${t.id}"]`).forEach(el=>el.textContent=formatTime(t.duration));}updateProgress();updateMediaSession();
  }


  function bindEvents() {
  if(eventsBound)return;eventsBound=true;
  function syncLifecycle(event){
    // Refresh the existing session without replaying, resetting, or taking
    // focus back from a phone call/another app after a genuine interruption.
    if(playIntent)musicSession();updateMediaSession();playbackReport.record(event);saveSession(true);
  }
  window.addEventListener('pagehide',()=>syncLifecycle('pagehide'));
  window.addEventListener('pageshow',()=>syncLifecycle('pageshow'));
  document.addEventListener('visibilitychange',()=>syncLifecycle(document.hidden?'hidden':'visible'));
  audio.addEventListener('play',()=>{audioUnlocked=true;if(priming||audio.paused||!loadedTrack())return;playIntent=true;renderPlayer();updatePlaybackState();updatePositionState();});
  audio.addEventListener('playing',()=>{if(!hasCurrentMetadata()||audio.paused||audio.ended)return;playbackStarted=true;renderPlayer();updatePlaybackState();updatePositionState();});
  audio.addEventListener('waiting',()=>{if(!loadedTrack())return;playbackStarted=false;updatePlaybackState();updatePositionState();});
  audio.addEventListener('pause',()=>{if(priming||!audio.paused||!hasCurrentMetadata())return;playIntent=false;playbackStarted=false;renderPlayer();saveSession();updatePlaybackState();updatePositionState();});
  audio.addEventListener('ended',()=>{if(!priming)nextTrack(false);});
  audio.addEventListener('timeupdate',()=>{if(!hasCurrentMetadata())return;updateProgress();updatePositionState();if(Date.now()-lastSavedAt>5000){lastSavedAt=Date.now();saveSession();}});
  audio.addEventListener('loadedmetadata',refreshMetadata);
  for(const name of ['seeking','seeked','durationchange','ratechange'])audio.addEventListener(name,()=>{if(priming)return;updateProgress();updatePositionState();if(name==='seeked')saveSession();});
  audio.addEventListener('emptied',()=>{if(audio.readyState>=1)return;metadataReady=false;if(activeId)updatePositionState();else clearMediaSession();});
  audio.addEventListener('error',()=>{if(priming||!audio.getAttribute('src'))return;unloadAudio();renderPlayer();toast('This file cannot be played in this browser. Try another song or an MP3/AAC copy.',true);});
  audio.addEventListener('volumechange',()=>{renderPlayer();saveSession();});
  for(const event of ['play','playing','pause','waiting','stalled','ended','emptied','loadedmetadata','error'])audio.addEventListener(event,()=>playbackReport.record(event));
  try{navigator.audioSession?.addEventListener?.('statechange',()=>playbackReport.record('audio-session-state'));}catch{}
  }

  function activeTrackId() { return activeId; }
  function isPriming() { return priming; }
  function setupMediaSession() {
    const session=navigator.mediaSession;
    if(mediaSessionBound||typeof session?.setActionHandler!=='function')return;
    mediaSessionBound=true;
    const handlers={
      play:()=>resumePlayback(),
      pause:()=>pausePlayback(),
      previoustrack:()=>previousTrack(),
      nexttrack:()=>nextTrack(),
      seekto:details=>seekTo(details?.seekTime),
      // Advertise music controls; never turn a seek command into a song skip.
      seekbackward:null,
      seekforward:null,
      stop:()=>{pausePlayback();seekTo(0);}
    };
    for(const [name,handler]of Object.entries(handlers))try{session.setActionHandler(name,handler?details=>{playbackReport.record('remote-'+name);return handler(details);}:null);}catch{}
    updateMediaSession();
  }

  const actions = {
  'playback-report':()=>playbackReport.show(),
  'copy-playback-report':()=>playbackReport.copy(),
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
  'queue-remove':b=>{state.queue.removeAt(Number(b.dataset.index));prepareNeighbors();saveSession();renderQueue();},
  'queue-up':b=>{const i=Number(b.dataset.index),q=state.queue;if(i<=q.index+1||i>=q.order.length)return;[q.order[i-1],q.order[i]]=[q.order[i],q.order[i-1]];saveSession();renderQueue();},
  'clear-queue':()=>{state.queue.order=state.queue.order.slice(0,state.queue.index+1);state.queue.source=[...new Set(state.queue.order)];prepareNeighbors();saveSession();renderQueue();},
  'remove-track':async b=>{const id=b.dataset.id;await db.deleteTrack(id);if(id===activeId||id===state.queue.current)unloadAudio();state.tracks.delete(id);state.playlists.forEach(p=>{p.trackIds=p.trackIds.filter(x=>x!==id);});state.queue.prune(new Set(state.tracks.keys()));prepareNeighbors();if(mediaURLs.has(id)){URL.revokeObjectURL(mediaURLs.get(id));mediaURLs.delete(id);}ui.releaseArtwork(id);modal.close();render();saveSession();toast('Song removed from this device.');}
  };

  return { isCurrentView, loadTrack, togglePlay, nextTrack, previousTrack, toggleShuffle, progress, updatePositionState, updateMediaSession, saveSession, activeTrackId, isPriming, setupMediaSession, bindEvents, reportPanel:playbackReport.panel, actions };
}
