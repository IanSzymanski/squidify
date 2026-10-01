import { RELEASE_LABEL } from './release.js';
import { escapeHTML } from './core.js';

// A bounded local event history for physical-device investigation. No audio,
// file URLs, track IDs, names or library contents are collected or transmitted.
export function createPlaybackReport(context) {
  const key='squidify-playback-events',limit=80;
  let events=[];
  try{const saved=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(saved))events=saved.slice(-limit);}catch{}
  function record(event,detail={}){
    try{
      const {audio,state}=context,session=navigator.audioSession;
      events.push({at:new Date().toISOString(),release:RELEASE_LABEL,event,hidden:document.hidden,
        paused:audio.paused,ended:audio.ended,seeking:!!audio.seeking,ready:audio.readyState,network:audio.networkState??null,restartReady:audio.restartReadyState??null,
        muted:audio.muted,volume:audio.volume,rate:audio.playbackRate,
        position:Number.isFinite(audio.currentTime)?Math.round(audio.currentTime*10)/10:null,
        duration:Number.isFinite(audio.duration)?Math.round(audio.duration*10)/10:null,
        queueIndex:state.queue.index,queueLength:state.queue.order.length,
        pastPasses:state.queue.pastPasses.length,futurePasses:state.queue.futurePasses.length,hasPrevious:!!state.queue.previousId,standby:audio.standbyState??null,
        audioSessionType:session?.type??'unsupported',audioSessionState:session?.state??'unavailable',
        mediaState:navigator.mediaSession?.playbackState??'unsupported',mediaError:audio.error?.code??null,...detail});
      events=events.slice(-limit);
      try{localStorage.setItem(key,JSON.stringify(events));}catch{}
    }catch{/* Diagnostics must never interrupt playback. */}
  }
  function text(){return JSON.stringify({app:'Squidify',release:RELEASE_LABEL,browser:navigator.userAgent,
    installed:!!context.standalone(),events},null,2);}
  function panel(){return '<section class="settings-card"><h2>Playback help</h2><p>If sound stops or lock-screen controls disappear, this report helps trace what happened. It stays on this device and excludes song names and audio.</p><button class="button" data-action="playback-report">View playback report</button></section>';}
  function show(){
    context.ui.setModal(context.ui.modalHead('Playback report')+'<p>Includes app and browser versions, playback events, and background state. Copy it to share when reporting a playback problem.</p><label class="field">Recent playback events<textarea id="playbackReport" rows="12" readonly>'+escapeHTML(text())+'</textarea></label><button class="button primary" data-action="copy-playback-report">Copy report</button>');
  }
  async function copy(){
    try{await navigator.clipboard.writeText(text());context.ui.toast('Playback report copied.');}
    catch{const field=context.$('#playbackReport');field?.focus();field?.select?.();context.ui.toast('Select and copy the report text above.');}
  }
  record('app-open');
  return {record,panel,show,copy};
}
