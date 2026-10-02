import * as db from './storage.js';

export const MIX_DEFAULTS=Object.freeze({enabled:false,duration:4,curve:'equal-power'});
export function normalizeMixing(value={}) {
  const v=value&&typeof value==='object'?value:{};
  const duration=typeof v.duration==='number'&&Number.isFinite(v.duration)?v.duration:MIX_DEFAULTS.duration;
  return {enabled:v.enabled===true,duration:Math.round(Math.max(0,Math.min(12,duration))*10)/10,curve:['linear','equal-power','smooth'].includes(v.curve)?v.curve:MIX_DEFAULTS.curve};
}
export function fadeValues(curve,position) {
  const t=Math.max(0,Math.min(1,position));
  if(curve==='equal-power')return [Math.cos(t*Math.PI/2),Math.sin(t*Math.PI/2)];
  const incoming=curve==='smooth'?t*t*(3-2*t):t;
  return [1-incoming,incoming];
}
export function overlapSeconds(requested,outgoing,incoming,rate=1) {
  if(![requested,outgoing,incoming,rate].every(Number.isFinite)||rate<=0)return 0;
  // Half of each track leaves room for its neighboring overlap without a
  // third live source. Durations here are output-clock seconds, not samples.
  return Math.max(0,Math.min(requested,outgoing/(2*rate),incoming/(2*rate)));
}

export function createStandardMixing(context,onIdle) {
  const {audio,$,$$}=context;
  let settings={...MIX_DEFAULTS},engine=null,master=null,unlocking=null;
  let transition=null,pending=null,serial=0,timer=null,blockedSource=null;
  let saveTimer=null,writeChain=Promise.resolve(),saveSerial=0,unavailable=false;
  const nodes=new Map();
  const busy=()=>!!(transition||pending);
  const enabled=()=>settings.enabled&&settings.duration>0;
  function setGain(node,value){
    if(!node||!engine)return;node.gain.cancelScheduledValues(engine.currentTime);node.gain.setValueAtTime(value,engine.currentTime);
  }
  function route(element,initial=1){
    if(nodes.has(element))return nodes.get(element);
    const gain=engine.createGain();gain.gain.value=initial;gain.connect(master);
    const source=engine.createMediaElementSource(element);source.connect(gain);
    nodes.set(element,gain);return gain;
  }
  function note(){
    const el=$('#mixingNote');if(el)el.textContent=unavailable?'Crossfades are unavailable right now. Songs will change normally.':'Automatic song changes only. Background mixing depends on your browser.';
  }
  function unlock(){
    if(!enabled()||unavailable)return Promise.resolve(false);
    if(unlocking)return unlocking;
    try{
      // Keep browser-selected remote outputs on their native path. The OS's
      // normal Bluetooth/default route remains usable for optional mixing.
      if(audio.webkitCurrentPlaybackTargetIsWireless||(audio.sinkId&&audio.sinkId!=='default'))throw new Error('Native output selected');
      if(!engine){
        const AudioContext=globalThis.AudioContext||globalThis.webkitAudioContext;
        if(!AudioContext)throw new Error('Web Audio unavailable');
        engine=new AudioContext();master=engine.createGain();master.gain.value=.7;master.connect(engine.destination);
        const created=engine;engine.addEventListener('statechange',()=>{
          // Do not replay or reclaim audio after a system interruption.
          if(engine===created&&nodes.size&&engine.state!=='running'){
            unavailable=true;cancel();context.playback.pauseForMixingInterruption();releaseGraph();note();
          }
        });
      }
      // Resume is invoked in the user's action, without delaying native play.
      unlocking=Promise.resolve(engine.state==='running'?undefined:engine.resume()).then(()=>{
        if(!enabled())return false;
        if(engine?.state!=='running')throw new Error('Audio processing suspended');
        route(audio.currentElement);unavailable=false;note();return true;
      }).catch(()=>{unavailable=true;cancel();releaseGraph();note();return false;}).finally(()=>{unlocking=null;});
      return unlocking;
    }catch{unavailable=true;cancel();releaseGraph();note();return Promise.resolve(false);}
  }
  function cancel(){
    serial++;clearTimeout(timer);timer=null;
    const preparing=pending;pending=null;transition=null;
    audio.finishMix();
    if(preparing&&preparing.element!==audio.currentElement){preparing.element.muted=true;preparing.element.pause();}
    for(const [element,gain]of nodes)setGain(gain,element===audio.currentElement?1:0);
  }
  function finish(){
    if(!transition)return;cancel();onIdle();
  }
  function tick(){if(transition&&engine.currentTime>=transition.end-.01)finish();}
  function reset(){cancel();blockedSource=null;}
  function releaseGraph(){
    const oldEngine=engine;if(!oldEngine)return;
    const routed=nodes.size;engine=null;master=null;nodes.clear();
    if(routed){
      const restored=audio.restoreNative();
      restored.ready.then(()=>{if(restored.wasPlaying)context.playback.resumeAfterMixing();}).catch(()=>context.ui.toast('Choose your audio output again, then tap Play.',true));
    }
    oldEngine.close().catch(()=>{});
  }
  function beginTrack(){
    const gain=nodes.get(audio.currentElement);
    if(!gain)return;
    if(!enabled()||engine?.state!=='running'){setGain(gain,1);return;}
    setGain(gain,0);gain.gain.linearRampToValueAtTime(1,engine.currentTime+.015);
  }
  function tryTransition(source,duration,validate,commit){
    const incoming=audio.preparedElement(source),outgoing=audio.currentElement;
    if(!enabled()||busy()||source===blockedSource||engine?.state!=='running'||!nodes.has(outgoing)||!incoming||duration<.08)return;
    const operation={serial:++serial,element:incoming};pending=operation;
    let inGain;
    try{
      inGain=route(incoming,0);setGain(inGain,0);
      incoming.volume=audio.volume;if(incoming.playbackRate!==audio.playbackRate)incoming.playbackRate=audio.playbackRate;incoming.muted=audio.muted;
      // An incoming source stays at zero gain until playable startup succeeds.
      const play=incoming.play();
      Promise.resolve(play).then(()=>{
        if(pending!==operation||operation.serial!==serial)return;
        if(!validate()||outgoing.paused||outgoing.ended||incoming.paused||incoming.readyState<3||engine.state!=='running'){
          blockedSource=source;cancel();onIdle();return;
        }
        const length=Math.min(duration,(outgoing.duration-outgoing.currentTime)/outgoing.playbackRate);
        if(length<.08){blockedSource=source;cancel();return;}
        // Commit advances the existing queue and adopts the already playing
        // element atomically. Never reload its source or reset its clock.
        if(!commit()){blockedSource=source;cancel();onIdle();return;}
        operation.committed=true;
        pending=null;
        const start=engine.currentTime,outGain=nodes.get(outgoing),a=new Float32Array(129),b=new Float32Array(129);
        for(let i=0;i<a.length;i++){const values=fadeValues(settings.curve,i/(a.length-1));a[i]=values[0];b[i]=values[1];}
        setGain(outGain,1);setGain(inGain,0);
        outGain.gain.setValueCurveAtTime(a,start,length);inGain.gain.setValueCurveAtTime(b,start,length);
        transition={end:start+length};
        // The audio clock owns the fades; this timer only releases the silent
        // tail and prepares the next source. Late background timers are safe.
        timer=setTimeout(finish,Math.ceil(length*1000)+30);
      }).catch(()=>{
        if(pending!==operation&&!(operation.committed&&serial===operation.serial))return;blockedSource=source;cancel();onIdle();
      });
    }catch{blockedSource=source;cancel();}
  }
  async function loadSettings(){settings=normalizeMixing(await db.setting('mixing',MIX_DEFAULTS));}
  function status(text){const el=$('#mixingSaveStatus');if(el)el.textContent=text;}
  function saveSettings(){
    clearTimeout(saveTimer);saveTimer=null;const revision=++saveSerial,value={...settings};
    // Serialize writes so a delayed earlier preference cannot overwrite a newer one.
    writeChain=writeChain.catch(()=>{}).then(()=>db.setSetting('mixing',value));
    return writeChain.then(()=>{if(revision===saveSerial)status('Saved on this device');},()=>{if(revision===saveSerial)status('Could not save. Change a control to retry.');});
  }
  function update(key,value){
    if(!['enabled','duration','curve'].includes(key))return;
    if(key==='duration'&&(value===''||!Number.isFinite(Number(value))))return;
    settings=normalizeMixing({...settings,[key]:key==='duration'?Number(value):value});
    reset();unavailable=false;
    if(!enabled())releaseGraph();
    // Mixing headroom bounds the equal-power overlap's summed peak.
    if(master){master.gain.cancelScheduledValues(engine.currentTime);master.gain.setTargetAtTime(enabled()?.7:1,engine.currentTime,.01);}
    const fields=$('#mixingFields');if(fields)fields.disabled=!settings.enabled;
    for(const el of $$('[data-mixing="duration"]')){el.value=String(settings.duration);el.style?.setProperty('--pct',`${settings.duration/12*100}%`);}
    const toggle=$('[data-mixing="enabled"]');if(toggle)toggle.checked=settings.enabled;
    const label=$('#mixingDurationLabel');if(label)label.textContent=settings.duration===0?'No overlap':`${settings.duration.toFixed(1)} seconds`;
    status('Saving…');clearTimeout(saveTimer);saveTimer=setTimeout(saveSettings,180);
    unlock().then(onIdle);onIdle();
  }
  function panel(){
    const disabled=settings.enabled?'':' disabled';
    return `<section class="settings-card mixing-card" aria-labelledby="mixingHeading"><p class="eyebrow">Playback</p><div class="mixing-heading"><h2 id="mixingHeading">Standard mixing</h2><label class="mixing-toggle"><input type="checkbox" data-mixing="enabled"${settings.enabled?' checked':''}><span>Crossfade</span></label></div><fieldset id="mixingFields"${disabled}><legend class="sr-only">Crossfade settings</legend><div class="mixing-label"><label for="mixingDuration">Duration</label><span id="mixingDurationLabel">${settings.duration===0?'No overlap':settings.duration.toFixed(1)+' seconds'}</span></div><div class="mixing-duration"><input id="mixingDuration" data-mixing="duration" type="range" min="0" max="12" step="0.1" value="${settings.duration}" style="--pct:${settings.duration/12*100}%"><label class="mixing-number"><input data-mixing="duration" type="number" min="0" max="12" step="0.1" value="${settings.duration}" inputmode="decimal" aria-label="Crossfade duration in seconds"><span>sec</span></label></div><label class="mixing-curve" for="mixingCurve">Fade shape<select id="mixingCurve" data-mixing="curve"><option value="linear"${settings.curve==='linear'?' selected':''}>Linear</option><option value="equal-power"${settings.curve==='equal-power'?' selected':''}>Equal power</option><option value="smooth"${settings.curve==='smooth'?' selected':''}>Smooth S-curve</option></select></label></fieldset><p id="mixingNote" class="small-note">${unavailable?'Crossfades are unavailable right now. Songs will change normally.':'Automatic song changes only. Background mixing depends on your browser.'}</p><p id="mixingSaveStatus" class="small-note" role="status" aria-live="polite">Saved on this device</p></section>`;
  }
  window.addEventListener('pagehide',()=>{if(saveTimer)saveSettings();});
  function releaseForOutput(){const wasEnabled=settings.enabled;if(wasEnabled)update('enabled',false);return wasEnabled;}
  return {get settings(){return settings;},get busy(){return busy();},get enabled(){return enabled();},get failedSource(){return blockedSource;},unlock,reset,cancel,tick,tryTransition,beginTrack,loadSettings,saveSettings,update,panel,releaseForOutput};
}
