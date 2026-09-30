import { BAND_COUNT, spectrumAt, followLevel, equalizerPoints, equalizerTangents, equalizerMotionBounds, equalizerCanvasHeight, EQ_CONTROLS, EQ_DEFAULTS, normalizeEqualizerSettings } from './spectrum.js';
import { icon } from './icons.js';
import * as db from './storage.js';
import { escapeHTML as esc } from './core.js';

export function createEnhancements(context) {
  const { $, $$, state, audio, byId, playlist, modal, nowDialog } = context;
  let coverTarget, coverBusy=false, waveGeneration=0, samples=null, sampleDuration=0, frame=0;
  let equalizer=normalizeEqualizerSettings(),saveTimer=0,saveChain=Promise.resolve(),previewPaused=false,previewTargets=null,lastFrame=0,settingsRevision=0;
  const valueLabel=(control,value)=>`${value}${control.unit}`;
  async function loadSettings(){equalizer=normalizeEqualizerSettings(await db.setting('equalizer',EQ_DEFAULTS));}
  function settingsPanel(){
    return `<section class="settings-card equalizer-settings" aria-labelledby="equalizerTitle"><div class="eq-heading"><div><h2 id="equalizerTitle">Equalizer</h2><p>Tune the motion and shape. Changes apply to both players.</p></div><button class="button" data-action="reset-equalizer">Reset defaults</button></div><div class="eq-preview"><div class="eq-preview-heading"><span data-eq-source>Demo signal</span><button class="button quiet" data-action="pause-equalizer-preview" aria-pressed="${previewPaused}">${previewPaused?'Resume preview':'Pause preview'}</button></div><canvas class="audio-wave eq-preview-wave" width="780" height="240" aria-label="Live equalizer preview"></canvas><div class="eq-mini-row"><span>Mini player</span><canvas class="audio-wave eq-preview-mini" width="44" height="44" aria-label="Mini equalizer preview"></canvas></div></div><div class="eq-controls">${EQ_CONTROLS.map(c=>`<label class="eq-control" for="eq-${c.key}"><span>${c.label}<output id="eq-value-${c.key}" for="eq-${c.key}">${valueLabel(c,equalizer[c.key])}</output></span><input id="eq-${c.key}" data-eq="${c.key}" type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${equalizer[c.key]}" aria-describedby="eq-hint-${c.key}" aria-valuetext="${valueLabel(c,equalizer[c.key])}"><small id="eq-hint-${c.key}">${c.hint}</small></label>`).join('')}</div><p class="eq-save-status" data-eq-save role="status">Saved on this device.</p></section>`;
  }
  function saveStatus(message){const el=$('[data-eq-save]');if(el)el.textContent=message;}
  function saveSettings(){
    clearTimeout(saveTimer);saveTimer=0;const snapshot={...equalizer},revision=settingsRevision;
    saveChain=saveChain.then(()=>db.setSetting('equalizer',snapshot)).then(()=>{if(revision===settingsRevision)saveStatus('Saved on this device.');}).catch(()=>{if(revision===settingsRevision){saveStatus('Could not save. Your changes apply for this session.');context.ui.toast('Could not save equalizer settings on this device.',true);}});
    return saveChain;
  }
  function updateEqualizer(key,value){
    const control=EQ_CONTROLS.find(c=>c.key===key);if(!control)return;
    equalizer=normalizeEqualizerSettings({...equalizer,[key]:Number(value)});
    settingsRevision++;
    const output=$(`#eq-value-${key}`),input=$(`#eq-${key}`);
    if(output)output.textContent=valueLabel(control,equalizer[key]);
    if(input){input.value=equalizer[key];input.setAttribute('aria-valuetext',valueLabel(control,equalizer[key]));}
    saveStatus('Saving…');clearTimeout(saveTimer);saveTimer=setTimeout(saveSettings,180);drawWave();
  }
  function resetEqualizer(){
    equalizer=normalizeEqualizerSettings();settingsRevision++;
    EQ_CONTROLS.forEach(c=>{const input=$(`#eq-${c.key}`),output=$(`#eq-value-${c.key}`);if(input){input.value=equalizer[c.key];input.setAttribute('aria-valuetext',valueLabel(c,equalizer[c.key]));}if(output)output.textContent=valueLabel(c,equalizer[c.key]);});
    drawWave();return saveSettings();
  }
  function pausePreview(button){previewPaused=!previewPaused;button.textContent=previewPaused?'Resume preview':'Pause preview';button.setAttribute('aria-pressed',String(previewPaused));drawWave();}
  window.addEventListener('pagehide',()=>{if(saveTimer)saveSettings();});
  const mediaArt=new Map();
  const input=document.createElement('input');input.type='file';input.accept='image/jpeg,image/png,image/webp,image/avif';input.hidden=true;
  document.body.append(input);
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];input.value='';state.pickerOpen=false;if(!file)return;
    try {await saveCover(await normalizeImage(file));}
    catch(error){context.ui.toast(error.name==='ImageSizeError'?error.message:error.name==='QuotaExceededError'?'Storage is full. The previous cover was kept.':'Could not read this photo. Choose a JPEG, PNG, WebP or AVIF image.',true);}
  });
  input.addEventListener('cancel',()=>{state.pickerOpen=false;});
  async function normalizeImage(file){
    if(file.size>25*1024*1024)throw Object.assign(new Error('Choose a photo smaller than 25 MB.'),{name:'ImageSizeError'});
    const url=URL.createObjectURL(file);
    try {
      const img=new Image();img.src=url;await img.decode();
      if(!img.naturalWidth||!img.naturalHeight)throw new Error('Empty image');
      const size=Math.min(1024,img.naturalWidth,img.naturalHeight),canvas=document.createElement('canvas');canvas.width=canvas.height=size;
      const ctx=canvas.getContext('2d');const crop=Math.min(img.naturalWidth,img.naturalHeight);
      ctx.drawImage(img,(img.naturalWidth-crop)/2,(img.naturalHeight-crop)/2,crop,crop,0,0,size,size);
      return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Image failed')),'image/jpeg',.86));
    }finally{URL.revokeObjectURL(url);}
  }
  function coverDialog(kind,id){
    coverTarget={kind,id};
    context.ui.setModal(context.ui.modalHead('Cover photo')+`<p>Choose a photo for this ${kind}. It will be cropped to a square.</p><p class="small-note">JPEG, PNG, WebP or AVIF · up to 25 MB. Saved at up to 1024 × 1024 pixels and counted in the same device storage as your music.</p><div class="modal-actions"><button class="button" data-action="remove-cover">Use default artwork</button><button class="button primary" data-action="choose-cover">Choose photo</button></div>`);
  }
  function chooseCover(){if(coverBusy)return;state.pickerOpen=true;input.click();}
  async function saveCover(blob){
    if(!coverTarget||coverBusy)return;coverBusy=true;
    try{
      const {kind,id}=coverTarget;
      if(kind==='playlist'){
        const p=playlist(id);if(!p)throw new Error('Playlist removed');
        const next={...p,artwork:blob};await db.put('playlists',next);Object.assign(p,next);
        context.ui.releaseArtwork('playlist:'+id);mediaArt.delete(id);
      }else{
        const tracks=[...state.tracks.values()].filter(t=>`${t.album}\u241f${t.artist}`===id);
        const next=tracks.map(t=>({...t,originalArtwork:t.originalArtwork===undefined?t.artwork:t.originalArtwork,artwork:blob||(t.originalArtwork===undefined?t.artwork:t.originalArtwork)||null}));
        await db.putTracks(next);
        for(const t of next){state.tracks.set(t.id,t);context.ui.releaseArtwork(t.id);}
      }
      state.storage=await db.storageInfo();modal.close();context.ui.render();if(nowDialog.open)context.ui.renderNowPlaying();context.playback.updateMediaSession();context.ui.toast(blob?'Cover photo saved.':'Default artwork restored.');
    }finally{coverBusy=false;}
  }
  function playlistMediaArt(p){
    if(p.artwork)return {src:context.ui.artworkURL({...p,id:'playlist:'+p.id}),type:p.artwork.type};
    if(!mediaArt.has(p.id)){
      let seed=0;for(const c of p.id)seed=(Math.imul(seed,31)+c.charCodeAt(0))>>>0;
      const canvas=document.createElement('canvas');canvas.width=canvas.height=512;const ctx=canvas.getContext('2d');if(!ctx)return null;
      const angle=(seed%360)*Math.PI/180;ctx.translate(256,256);ctx.rotate(angle);const grad=ctx.createLinearGradient(-360,-240,360,240);
      [[0,'#070914'],[.16,'#12352f'],[.3,'#0eedb5'],[.32,'#d3fff1'],[.34,'#219882'],[.45,'#0d182f'],[.62,'#ae00ff'],[.65,'#ebc8ff'],[.67,'#510b76'],[.85,'#4497af'],[1,'#070914']].forEach(([at,color])=>grad.addColorStop(at,color));
      ctx.fillStyle=grad;ctx.fillRect(-370,-370,740,740);mediaArt.set(p.id,canvas.toDataURL('image/png'));
    }
    return {src:mediaArt.get(p.id),type:'image/png'};
  }
  let selectedOutput=null,outputRevision=0;
  const isHeadphones=label=>/headphones?|headsets?|earphones?|earbuds?|airpods|buds|WH-|WF-|QC[ -]?\d|QuietComfort/i.test(label||'');
  function renderOutput(){
    const headphones=isHeadphones(selectedOutput?.label),wireless=!!audio.webkitCurrentPlaybackTargetIsWireless;
    const label=selectedOutput?.label || (wireless?'Wireless audio output':'Audio output — managed by your device');
    $$('.output-control').forEach(b=>{b.innerHTML=icon(headphones?'headphones':'bluetooth');b.title=label;b.setAttribute('aria-label',label);b.classList.toggle('active',headphones||!!selectedOutput||wireless);});
  }
  async function refreshOutput(){
    const revision=++outputRevision,sink=audio.sinkId;
    try{
      // Inspect only the active sink (including a named system default), never
      // infer that a listed/connected headset is the selected playback route.
      if(typeof sink!=='string'||!navigator.mediaDevices?.enumerateDevices){selectedOutput=null;return renderOutput();}
      const devices=await navigator.mediaDevices?.enumerateDevices?.();
      if(revision!==outputRevision||audio.sinkId!==sink)return;
      selectedOutput=devices?.find(d=>d.kind==='audiooutput' && d.deviceId===(sink||'default'))||null;
    }catch{if(revision!==outputRevision)return;selectedOutput=null;}
    renderOutput();
  }
  async function chooseOutput(){
    try{
      if(navigator.mediaDevices?.selectAudioOutput && audio.setSinkId){
        const device=await navigator.mediaDevices.selectAudioOutput();await audio.setSinkId(device.deviceId);outputRevision++;selectedOutput=device;renderOutput();
        context.ui.toast(`Audio output: ${device.label||'selected device'}.`);
      }else if(audio.webkitShowPlaybackTargetPicker){audio.webkitShowPlaybackTargetPicker();}
      else context.ui.toast('Choose headphones or a speaker in your device’s audio controls. This browser does not report the active Bluetooth connection.');
    }catch(error){if(error.name!=='NotAllowedError'&&error.name!=='AbortError')context.ui.toast('Could not change output. Use your device’s audio controls.',true);}
  }
  navigator.mediaDevices?.addEventListener?.('devicechange',refreshOutput);
  audio.addEventListener('sinkchange',refreshOutput);
  audio.addEventListener('webkitcurrentplaybacktargetiswirelesschanged',renderOutput);
  audio.addEventListener('play',refreshOutput);
  window.addEventListener('focus',refreshOutput);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshOutput();});
  refreshOutput();
  // Decode a bounded copy to sample its real waveform. Do not reroute the media
  // element through Web Audio: iOS background and lock-screen playback stay native.
  async function loadWave(id){
    const generation=++waveGeneration;samples=null;drawWave();
    const t=byId(id);if(!t||t.size>40*1024*1024||t.duration>900)return;
    const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext;if(!Offline)return;
    try{
      const item=await db.get('media',id);if(generation!==waveGeneration||!item?.blob)return;
      const decoder=new Offline(1,1,8000),buffer=await decoder.decodeAudioData(await item.blob.arrayBuffer());
      if(generation!==waveGeneration||buffer.duration>900)return;
      const channel=buffer.getChannelData(0),count=Math.ceil(buffer.duration*30),result=new Float32Array(count*BAND_COUNT);
      for(let i=0;i<count;i++){
        result.set(spectrumAt(channel,i/30*buffer.sampleRate,buffer.sampleRate),i*BAND_COUNT);
        if(i%256===0){await new Promise(resolve=>setTimeout(resolve,0));if(generation!==waveGeneration)return;}
      }
      samples=result;sampleDuration=buffer.duration;drawWave();
    }catch{/* Decoding support can differ from playback. Keep a quiet baseline. */}
  }
  const envelopes=new WeakMap();
  function drawWave(){
    if(frame && typeof cancelAnimationFrame==='function')cancelAnimationFrame(frame);frame=0;
    if(document.hidden)return;
    const playing=!audio.paused&&!context.playback.isPriming(),reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    const now=Date.now(),elapsed=lastFrame?now-lastFrame:1000/60;lastFrame=now;
    let settling=false,previewAnimating=false;
    const demo=!(playing&&samples),demoTime=reduced?0:now/1000;
    const sampleIndex=Math.min(Math.max(0,Math.floor(audio.currentTime*30)),Math.max(0,(samples?.length||0)/BAND_COUNT-1));
    if(state.view==='settings'&&(!previewPaused||!previewTargets))previewTargets=Array.from({length:BAND_COUNT},(_,i)=>demo?Math.min(1,.2+.75*Math.exp(-.5*((i-(7+4*Math.sin(demoTime*.65)))/2.2)**2)*(.6+.4*Math.sin(demoTime*3)**2)+.13*Math.sin(i*.8+demoTime*2)**2):(samples[sampleIndex*BAND_COUNT+i]||0));
    const source=$('[data-eq-source]');if(source&&state.view==='settings')source.textContent=previewPaused?'Preview paused':reduced?'Static preview · reduced motion':demo?'Demo signal · play a supported song to preview its audio':'Live · current song';
    $$('.audio-wave').forEach(canvas=>{
      const ctx=canvas.getContext('2d');if(!ctx)return;
      const full=canvas.classList?.contains('full-wave'),largePreview=canvas.classList?.contains('eq-preview-wave');
      if(full&&canvas.style){const height=`${equalizerCanvasHeight(equalizer.height)}px`;if(canvas.style.height!==height)canvas.style.height=height;}
      const rect=canvas.getBoundingClientRect(),ratio=Math.min(2,window.devicePixelRatio||1),w=rect.width,h=rect.height;
      if(w<2||h<2){ctx.clearRect(0,0,canvas.width,canvas.height);return;}
      const preview=canvas.classList?.contains('eq-preview-wave')||canvas.classList?.contains('eq-preview-mini');
      const [motionStart,motionEnd]=equalizerMotionBounds(w,equalizer.activeWidth);
      if(canvas.width!==Math.round(w*ratio)||canvas.height!==Math.round(h*ratio)){canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);}
      ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);
      canvas.setAttribute('aria-label',preview?(demo?'Demo equalizer preview':'Live audio equalizer preview'):samples?'Audio equalizer':'Equalizer unavailable for this file');
      let levels=envelopes.get(canvas);if(!levels){levels=Array(BAND_COUNT).fill(0);envelopes.set(canvas,levels);}
      levels.forEach((level,i)=>{
        const target=preview?(previewTargets?.[i]||0):playing&&samples&&!reduced?(samples[sampleIndex*BAND_COUNT+i]||0):0;
        const shaped=Math.pow(target,3.2/equalizer.sensitivity);
        levels[i]=preview&&(reduced||previewPaused)?shaped:followLevel(level,shaped,equalizer,elapsed);if(levels[i]>.002){if(!preview)settling=true;}else levels[i]=0;

      });
      if(preview&&!previewPaused&&!reduced)previewAnimating=true;
      // Keep the preview's footprint fixed while showing the full 4× height
      // range; dragging a slider never moves that slider beneath the finger.
      const referenceHeight=full?70:largePreview?8+(h-8)/4:h;
      const points=equalizerPoints(levels,w,h,motionStart,motionEnd,equalizer,referenceHeight);
      const tangents=equalizerTangents(points);
      const gradient=ctx.createLinearGradient(0,0,w,0);gradient.addColorStop(0,'#0eedb5');gradient.addColorStop(.5,'#63a4ef');gradient.addColorStop(1,'#ae00ff');
      const curve=()=>{ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);for(let i=0;i<points.length-1;i++){const a=points[i],b=points[i+1],third=(b.x-a.x)/3;ctx.bezierCurveTo(a.x+third,a.y+tangents[i]*third,b.x-third,b.y-tangents[i+1]*third,b.x,b.y);}};
      curve();ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();ctx.fillStyle=gradient;ctx.globalAlpha=equalizer.fill/100;ctx.fill();ctx.globalAlpha=1;
      curve();ctx.strokeStyle=gradient;ctx.lineWidth=equalizer.stroke;ctx.lineCap='round';ctx.shadowColor='#24dfb980';ctx.shadowBlur=equalizer.glow;ctx.shadowOffsetY=equalizer.glow?4:0;ctx.stroke();ctx.shadowBlur=0;ctx.shadowOffsetY=0;
    });
    if((playing||settling||previewAnimating) && typeof requestAnimationFrame==='function' && !reduced)frame=requestAnimationFrame(drawWave);
  }
  window.addEventListener('resize',drawWave);
  audio.addEventListener('play',drawWave);audio.addEventListener('pause',drawWave);audio.addEventListener('timeupdate',()=>{if(!frame)drawWave();});document.addEventListener('visibilitychange',drawWave);
  function importResults(){const report=state.importReport;if(!report)return;context.ui.setModal(context.ui.modalHead('Import results')+`<p>${esc(report.summary)}</p><ul class="import-results">${report.files.map(f=>`<li><strong>${esc(f.name)}</strong><span>${esc(f.reason)}</span></li>`).join('')}</ul>`);}
  return {coverDialog,chooseCover,saveCover,playlistMediaArt,chooseOutput,renderOutput,drawWave,loadWave,importResults,loadSettings,settingsPanel,updateEqualizer,saveSettings,resetEqualizer,pausePreview};
}
