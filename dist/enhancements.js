import * as db from './storage.js';
import { escapeHTML as esc } from './core.js';

export function createEnhancements(context) {
  const { $, $$, state, audio, byId, playlist, modal, nowDialog } = context;
  let coverTarget, coverBusy=false, waveGeneration=0, samples=null, sampleDuration=0, frame=0;
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
  async function chooseOutput(){
    try{
      if(navigator.mediaDevices?.selectAudioOutput && audio.setSinkId){
        const device=await navigator.mediaDevices.selectAudioOutput();await audio.setSinkId(device.deviceId);
        $$('.output-control').forEach(b=>{b.title=device.label||'Selected audio output';b.setAttribute('aria-label',b.title);b.classList.add('active');});
        context.ui.toast(`Audio output: ${device.label||'selected device'}.`);
      }else if(audio.webkitShowPlaybackTargetPicker){audio.webkitShowPlaybackTargetPicker();}
      else context.ui.toast('Choose Bluetooth headphones or a speaker in your device’s audio controls. This browser does not report the active Bluetooth connection.');
    }catch(error){if(error.name!=='NotAllowedError'&&error.name!=='AbortError')context.ui.toast('Could not change output. Use your device’s audio controls.',true);}
  }
  audio.addEventListener('webkitcurrentplaybacktargetiswirelesschanged',()=>{
    $$('.output-control').forEach(b=>{b.classList.toggle('active',!!audio.webkitCurrentPlaybackTargetIsWireless);b.setAttribute('aria-label',audio.webkitCurrentPlaybackTargetIsWireless?'Wireless audio output active':'Audio output — managed by your device');});
  });
  // Decode a bounded copy to sample its real waveform. Do not reroute the media
  // element through Web Audio: iOS background and lock-screen playback stay native.
  async function loadWave(id){
    const generation=++waveGeneration;samples=null;drawWave();
    const t=byId(id);if(!t||t.size>40*1024*1024||t.duration>900)return;
    const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext;if(!Offline)return;
    try{
      const item=await db.get('media',id);if(generation!==waveGeneration||!item?.blob)return;
      const decoder=new Offline(1,1,8000),buffer=await decoder.decodeAudioData(await item.blob.arrayBuffer());
      if(generation!==waveGeneration)return;
      const channel=buffer.getChannelData(0),count=Math.min(90000,Math.ceil(buffer.duration*60)),result=new Float32Array(count),step=Math.max(1,Math.floor(channel.length/count));
      for(let i=0;i<count;i++){let sum=0,n=0;for(let j=i*step;j<Math.min(channel.length,(i+1)*step);j+=4){sum+=channel[j]*channel[j];n++;}result[i]=Math.min(1,Math.sqrt(sum/Math.max(1,n))*4);}
      samples=result;sampleDuration=buffer.duration;drawWave();
    }catch{/* Decoding support can differ from playback. Keep a quiet baseline. */}
  }
  function drawWave(){
    if(frame && typeof cancelAnimationFrame==='function')cancelAnimationFrame(frame);frame=0;
    if(document.hidden)return;
    const playing=!audio.paused&&!context.playback.isPriming();
    $$('.audio-wave').forEach(canvas=>{
      const ctx=canvas.getContext('2d');if(!ctx)return;const w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.fillStyle='#0eedb5';
      canvas.setAttribute('aria-label',samples?'Audio waveform':'Audio waveform unavailable for this file');
      for(let x=0;x<w;x+=5){const at=Math.floor((audio.currentTime+(x/w-.5)*.45)/Math.max(1,sampleDuration)*(samples?.length||0));const level=playing&&samples?samples[Math.max(0,Math.min(samples.length-1,at))]:0;const height=Math.max(2,(level||0)*(h-2));ctx.fillRect(x,(h-height)/2,2,height);}
    });
    if(playing && typeof requestAnimationFrame==='function' && !matchMedia('(prefers-reduced-motion: reduce)').matches)frame=requestAnimationFrame(drawWave);
  }
  audio.addEventListener('play',drawWave);audio.addEventListener('pause',drawWave);audio.addEventListener('timeupdate',()=>{if(!frame)drawWave();});document.addEventListener('visibilitychange',drawWave);
  function importResults(){const report=state.importReport;if(!report)return;context.ui.setModal(context.ui.modalHead('Import results')+`<p>${esc(report.summary)}</p><ul class="import-results">${report.files.map(f=>`<li><strong>${esc(f.name)}</strong><span>${esc(f.reason)}</span></li>`).join('')}</ul>`);}
  return {coverDialog,chooseCover,saveCover,playlistMediaArt,chooseOutput,loadWave,importResults};
}
