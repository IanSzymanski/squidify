import * as db from './storage.js';
import { escapeHTML as esc } from './core.js';
import { icon } from './icons.js';
import { bindDragOrder } from './drag-order.js';
import { createMixAudio } from './mix-audio.js';
import { clamp, copy, pairKey, defaultEffects, cleanClip, reconcileMix, buildTimeline, moveOrder, timeLabel, parseTime } from './mix-model.js';

const FX = [
  ['gain','Volume',-24,6,.1,'dB'],['bass','Bass',-12,12,.1,'dB'],['treble','Treble',-12,12,.1,'dB'],
  ['pan','Stereo position',-1,1,.01,'pan'],['reverb','Reverb',0,1,.01,'%'],['delay','Echo',0,1,.01,'%'],['distortion','Distortion',0,1,.01,'%']
];
const fxLabel = (value,unit) => unit==='%' ? `${Math.round(value*100)}%` : unit==='pan' ? value===0?'Center':`${Math.round(Math.abs(value)*100)}% ${value<0?'L':'R'}` : `${Number(value).toFixed(1)} ${unit}`;

export function createMixEditor(context) {
  let root, engine, playlistId, order=[], mix, timeline, selected, pane='clip', mobileTab='arrange', zoom=4, history=[], future=[], editBefore=null;
  let revision=0, savedRevision=0, saveTimer, saveChain=Promise.resolve(), saveError='', opened=false, closing=false, dragCleanup, restoreFocus;
  let previewMode='full', loop=false, bypass=false, playPosition=0, waveRequest=0, trimGesture=null;
  const waves=new Map();
  const $ = selector => root?.querySelector(selector);
  const snapshot = () => ({order:[...order],mix:copy(mix)});
  const entry = () => timeline?.entries.find(e=>e.trackId===selected);
  const clip = () => mix.clips[selected];
  function remember(before) {if(JSON.stringify(before)===JSON.stringify(snapshot()))return;history.push(before);if(history.length>50)history.shift();future=[];updateHistory();}
  function beginEdit(){if(!editBefore)editBefore=snapshot();}
  function commitEdit(){if(editBefore){remember(editBefore);editBefore=null;}}
  function updateHistory(){if(!root)return;$('[data-mix-action="undo"]').disabled=!history.length;$('[data-mix-action="redo"]').disabled=!future.length;}
  function saveStatus(){const node=$('.mix-save');if(node)node.textContent=saveError?'Retry save':savedRevision===revision?'Saved on device':'Saving…';if(node)node.classList.toggle('save-failed',!!saveError);}
  function changed(){revision++;saveError='';saveStatus();clearTimeout(saveTimer);saveTimer=setTimeout(()=>void flush().catch(()=>{}),400);}
  function flush(){
    clearTimeout(saveTimer);
    saveChain=saveChain.catch(()=>{}).then(async()=>{
      if(savedRevision===revision)return;
      const current=context.playlist(playlistId);if(!current)throw new Error('This playlist is no longer available.');
      const target=revision,updated={...current,trackIds:[...order],mix:copy(mix),mixUpdatedAt:Date.now()};
      try{await db.put('playlists',updated);context.state.playlists=context.state.playlists.map(p=>p.id===playlistId?updated:p);savedRevision=target;saveError='';saveStatus();}
      catch(error){saveError='Your changes could not be saved. Free some device storage, then choose Retry save.';saveStatus();message(saveError,true);throw error;}
    });return saveChain;
  }
  function message(text,error=false){const node=$('.mix-message');if(node){node.textContent=text;node.classList.toggle('error',error);}}
  function bounds(){
    if(previewMode==='song'){const e=entry();return {start:e.start,end:e.end,loop,soloId:selected};}
    if(previewMode==='transition'){
      const i=timeline.entries.findIndex(e=>e.trackId===selected),next=timeline.entries[i+1];
      if(!next)return null;
      return {start:Math.max(0,next.start-3),end:Math.min(timeline.duration,next.start+next.incoming+3),loop};
    }
    return {start:0,end:timeline.duration,loop};
  }
  async function play(){
    if(engine.playing||engine.loading){engine.pause();return;}
    const range=bounds();if(!range)return message('Select a song with another song after it to preview their transition.');
    const position=playPosition>=range.start&&playPosition<range.end?playPosition:range.start;
    await engine.play(position,range);
  }
  function refreshTiming(){
    const playing=engine.playing||engine.loading,at=engine.currentTime();timeline=buildTimeline(mix,order);engine.setTimeline(timeline);
    if(playing){const range=bounds();if(range)void engine.play(clamp(at,range.start,Math.max(range.start,range.end-.01)),range);}
    renderTimeline();renderInspector();tick(Math.min(at,timeline.duration));
  }
  function edit(change,{timing=true}={}){
    commitEdit();const before=snapshot();change();remember(before);changed();if(timing)refreshTiming();else renderInspector();
  }
  function reorder(id,target,after){
    const next=moveOrder(order,id,target,after);if(JSON.stringify(next)===JSON.stringify(order))return;
    edit(()=>{order=next;});message('Playlist order updated. New neighbors begin with a cut.');
  }
  function moveSelected(delta){const i=order.indexOf(selected),target=order[i+delta];if(target)reorder(selected,target,delta>0);}
  function undo(redo=false){
    commitEdit();const source=redo?future:history,target=redo?history:future;if(!source.length)return;
    target.push(snapshot());const previous=source.pop();order=previous.order;mix=previous.mix;
    if(!mix.clips[selected])selected=order.find(id=>mix.clips[id]);changed();refreshTiming();updateHistory();message(redo?'Change restored.':'Change undone.');
  }
  function tick(time){
    playPosition=time;
    const scrub=$('[data-mix-seek]');if(scrub){scrub.max=timeline.duration;scrub.value=time;}
    const clock=$('.mix-clock');if(clock)clock.textContent=`${timeLabel(time)} / ${timeLabel(timeline.duration)}`;
    const cursor=$('.mix-playhead');if(cursor)cursor.style.left=`${160+time*zoom}px`;
    root?.querySelectorAll('[data-mix-row]').forEach(row=>{const e=timeline.entries.find(item=>item.trackId===row.dataset.mixRow);row.classList.toggle('mix-playing',!!engine?.playing&&time>=e.start&&time<e.end);});
    const e=entry(),sourceCursor=$('.mix-source-cursor');if(sourceCursor&&e){sourceCursor.hidden=time<e.start||time>e.end;sourceCursor.style.left=`${(e.in+(time-e.start)*e.rate)/(context.byId(selected).duration||1)*100}%`;}
  }
  function engineState(state){
    const button=$('[data-mix-action="play"]');if(button){button.innerHTML=icon(state.playing?'pause':state.loading?'close':'play');button.setAttribute('aria-label',state.playing?'Pause preview':state.loading?'Cancel audio preparation':'Play preview');}
    const light=$('.mix-live');if(light){light.textContent=state.playing?'LIVE PREVIEW':state.loading?'LOADING AUDIO':'PREVIEW READY';light.classList.toggle('is-live',state.playing);}
    if(state.message)message(state.message);else if(!saveError)message(state.playing?'Adjust effects while the audio plays.':'Hold a song to reorder. Originals stay untouched.');
    tick(state.position);
  }
  function waveSVG(id,from=0,to){
    const data=waves.get(id);if(!data)return '<span class="mix-wave-placeholder">Waveform loads when you select a song</span>';
    const peaks=data.peaks.slice(Math.floor(from/data.duration*data.peaks.length),Math.max(1,Math.ceil((to??data.duration)/data.duration*data.peaks.length)));
    const path=peaks.map((v,i)=>`M${(i*600/peaks.length).toFixed(1)} ${(50-v*43).toFixed(1)}v${Math.max(1,v*86).toFixed(1)}`).join('');
    return `<svg viewBox="0 0 600 100" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`;
  }
  function renderTimeline(){
    const scroller=$('.mix-timeline-scroll'),scrollLeft=scroller?.scrollLeft||0,scrollTop=scroller?.scrollTop||0;
    const width=Math.max(420,timeline.duration*zoom),step=zoom<2?60:zoom<6?30:10;
    $('.mix-total').textContent=`${timeline.entries.length} songs · ${timeLabel(timeline.duration)} mix`;
    $('.mix-sequence').style.width=`${width+160}px`;
    $('.mix-sequence').innerHTML=`<div class="mix-ruler"><span class="mix-ruler-label">PLAYLIST ORDER</span><div style="width:${width}px">${Array.from({length:Math.ceil(timeline.duration/step)+1},(_,i)=>`<span style="left:${i*step*zoom}px">${timeLabel(i*step)}</span>`).join('')}</div></div><div class="mix-lanes">${timeline.entries.map((e,i)=>{
      const track=context.byId(e.trackId),fx=Object.values(e.effects).some(Boolean),next=timeline.entries[i+1];
      return `<div class="mix-lane ${e.trackId===selected?'selected':''}" data-mix-row="${esc(e.trackId)}"><div class="mix-lane-label"><button class="mix-grip" data-drag-grip aria-label="Drag ${esc(track.title)} to reorder" title="Hold and drag to reorder; use Move up or down in song controls">⠿</button><button data-mix-select="${esc(e.trackId)}"><span class="mix-song-number">${String(i+1).padStart(2,'0')}</span><strong class="mix-song-title">${esc(track.title)}</strong><small>${esc(track.artist)}</small></button></div><div class="mix-lane-track" style="width:${width}px"><button class="mix-clip ${i%2?'violet':'mint'}" data-mix-select="${esc(e.trackId)}" aria-label="Edit ${esc(track.title)}, ${timeLabel(e.in)} to ${timeLabel(e.out)}" style="left:${e.start*zoom}px;width:${Math.max(4,e.length*zoom)}px"><span class="mix-clip-wave">${waves.has(e.trackId)?waveSVG(e.trackId,e.in,e.out):''}</span><span class="mix-clip-title">${esc(track.title)}${fx?' · FX':''}</span><span class="mix-clip-times">${timeLabel(e.in,true)} → ${timeLabel(e.out,true)}${e.rate!==1?` · ${e.rate}×`:''}</span>${e.incoming?`<span class="mix-fade in" style="width:${e.incoming*zoom}px"></span>`:''}${e.outgoing?`<span class="mix-fade out" style="width:${e.outgoing*zoom}px"></span>`:''}</button>${next?`<button class="mix-join" data-mix-transition="${esc(e.trackId)}" style="left:${(e.end-e.outgoing)*zoom}px" title="Edit transition after ${esc(track.title)}">${e.outgoing?`${e.outgoing.toFixed(1)}s fade`:'Cut'}</button>`:''}</div></div>`;
    }).join('')}</div><div class="mix-playhead" aria-hidden="true"></div>`;
    if(scroller){scroller.scrollLeft=scrollLeft;scroller.scrollTop=scrollTop;}tick(playPosition);
  }
  function select(id){
    if(!mix.clips[id])return;commitEdit();selected=id;
    if(previewMode!=='full'&&(engine.playing||engine.loading)){engine.pause();message('Selected a new song. Tap Play to preview it.');}
    renderTimeline();renderInspector();void loadWave(id);
  }
  async function loadWave(id){
    const token=++waveRequest;if(waves.has(id))return;
    const status=$('.mix-wave-status');if(status)status.textContent='Loading waveform…';
    try{const data=await engine.waveform(id);if(!opened)return;waves.set(id,data);if(token===waveRequest&&selected===id){const source=$('.mix-source-wave');if(source)source.innerHTML=waveSVG(id);const note=$('.mix-wave-status');if(note)note.textContent='Drag the handles or enter exact source times.';root.querySelectorAll('.mix-clip').forEach(node=>{if(node.dataset.mixSelect===id)node.querySelector('.mix-clip-wave').innerHTML=waveSVG(id,mix.clips[id].in,mix.clips[id].out);});}}
    catch(error){if(opened&&token===waveRequest){const node=$('.mix-wave-status');if(node)node.textContent=error.message;}}
  }
  function setPane(name){commitEdit();pane=name;mobileTab=name;root.dataset.mobileTab=mobileTab;renderInspector();updateTabs();}
  function updateTabs(){root.querySelectorAll('[data-mix-pane]').forEach(b=>{const active=b.dataset.mixPane===pane;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});root.querySelectorAll('[data-mix-tab]').forEach(b=>{const active=b.dataset.mixTab===mobileTab;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});}
  function sourcePanel(){
    const c=clip(),duration=context.byId(selected).duration||1;
    return `<div class="mix-source" aria-label="Source waveform and trim handles"><div class="mix-source-wave">${waveSVG(selected)}</div><div class="mix-window" style="left:${c.in/duration*100}%;right:${(1-c.out/duration)*100}%"></div><button class="mix-trim" data-trim="in" style="left:${c.in/duration*100}%" aria-label="Drag source In point" title="Drag In point"></button><button class="mix-trim out" data-trim="out" style="left:${c.out/duration*100}%" aria-label="Drag source Out point" title="Drag Out point"></button><i class="mix-source-cursor" hidden></i></div><div class="mix-source-scale"><span>0:00</span><span>ORIGINAL AUDIO</span><span>${timeLabel(duration)}</span></div><p class="mix-wave-status">${waves.has(selected)?'Drag the handles or enter exact source times.':'Loading waveform…'}</p><div class="mix-time-fields"><label>In <input data-clip-time="in" type="text" inputmode="decimal" value="${timeLabel(c.in,true)}" aria-label="Source In time, minutes colon seconds"></label><label>Out <input data-clip-time="out" type="text" inputmode="decimal" value="${timeLabel(c.out,true)}" aria-label="Source Out time, minutes colon seconds"></label></div>`;
  }
  function renderInspector(){
    if(!selected)return;const e=entry(),c=clip(),index=timeline.entries.indexOf(e),track=context.byId(selected),next=timeline.entries[index+1];
    $('.mix-inspector-head').innerHTML=`<p class="mix-kicker">SONG ${String(index+1).padStart(2,'0')} / ${timeline.entries.length}</p><h3>${esc(track.title)}</h3><p>${esc(track.artist)}</p><div class="mix-song-switch"><button data-mix-select="${esc(timeline.entries[index-1]?.trackId||'')}" ${index===0?'disabled':''} aria-label="Select previous song">${icon('previous')}</button><span>${index+1} of ${timeline.entries.length}</span><button data-mix-select="${esc(next?.trackId||'')}" ${!next?'disabled':''} aria-label="Select next song">${icon('next')}</button></div>`;
    let html='';
    if(pane==='clip')html=`${sourcePanel()}<div class="mix-readout"><span>In the mix</span><strong>${timeLabel(e.start,true)} — ${timeLabel(e.end,true)}</strong></div><label class="mix-control"><span>Speed <output data-speed-value>${c.rate.toFixed(2)}×</output></span><input data-clip-rate type="range" min="0.5" max="2" step="0.01" value="${c.rate}" aria-label="Song speed"></label><p class="mix-note">Speed also changes pitch. Trim and speed changes update the preview when you release.</p><div class="mix-button-pair"><button data-mix-action="move-up" ${index===0?'disabled':''}>${icon('up')}Move up</button><button data-mix-action="move-down" ${!next?'disabled':''}>${icon('down')}Move down</button></div><button class="mix-text-button" data-mix-action="reset-clip">Use the full song at normal speed</button>`;
    if(pane==='transition'){
      const key=next&&pairKey(selected,next.trackId),transition=key&&mix.transitions[key],duration=e.outgoing,limit=next?Math.min(30,e.length/2,next.length/2):0;
      html=next?`<div class="mix-transition-card"><span>FROM</span><strong>${esc(track.title)}</strong><span class="mix-transition-arrow">↓</span><span>TO</span><strong>${esc(context.byId(next.trackId).title)}</strong></div><div class="mix-button-pair mix-transition-type"><button data-mix-action="cut" class="${!duration?'active':''}" aria-pressed="${!duration}">Hard cut</button><button data-mix-action="crossfade" class="${duration?'active':''}" aria-pressed="${!!duration}">Crossfade</button></div><label class="mix-number-control">Overlap <span><input data-transition-duration type="number" min="0" max="${limit}" step="0.1" value="${Number(duration.toFixed(3))}" aria-label="Transition overlap in seconds"> sec</span></label><label class="mix-select-control">Fade curve <select data-transition-curve ${!duration?'disabled':''}>${[['equal-power','Equal power'],['linear','Linear'],['smooth','Smooth']].map(([value,label])=>`<option value="${value}" ${value===(transition?.curve||'equal-power')?'selected':''}>${label}</option>`).join('')}</select></label><p class="mix-note">${duration?`${timeLabel(duration,true)} overlap. The next song starts at ${timeLabel(next.start,true)} in the mix.`:'The next song starts immediately when this one ends.'} Maximum overlap: ${limit.toFixed(1)} sec for these clips.</p><button class="mix-audition" data-mix-action="audition-transition">${icon('play')}Preview this transition</button><p class="mix-note">Preview includes three seconds on either side. Turn on Loop to keep tuning.</p>`:'<div class="mix-end"><span>END OF THE MIX</span><h4>One last note.</h4><p>This is the final song. Select an earlier song to shape its transition.</p></div>';
    }
    if(pane==='effects')html=`<div class="mix-effects-intro"><span class="mix-kicker">LIVE EFFECTS</span><button data-mix-action="bypass" class="mix-bypass ${bypass?'active':''}" aria-pressed="${bypass}">${bypass?'Effects bypassed':'Bypass FX'}</button></div>${FX.map(([key,label,min,max,step,unit])=>`<label class="mix-control"><span>${label}<output data-fx-value="${key}">${fxLabel(c.effects[key],unit)}</output></span><input data-mix-fx="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${c.effects[key]}" aria-label="${label}"></label>`).join('')}<button class="mix-audition" data-mix-action="audition-song">${icon('play')}Preview this song</button><button class="mix-text-button" data-mix-action="reset-fx">Reset this song’s effects</button><p class="mix-note">Effects are saved with this playlist mix. Use Bypass to compare while audio keeps playing.</p>`;
    $('.mix-inspector-content').innerHTML=html;updateTabs();tick(playPosition);
  }
  function changeTransition(values){const i=timeline.entries.findIndex(e=>e.trackId===selected),next=timeline.entries[i+1];if(!next)return;const key=pairKey(selected,next.trackId);mix.transitions[key]={duration:entry().outgoing,curve:mix.transitions[key]?.curve||'equal-power',...values};}
  function input(event){
    const el=event.target;
    if(el.matches('[data-mix-seek]')){void engine.seek(Number(el.value));return;}
    if(el.matches('[data-mix-zoom]')){zoom=Number(el.value);renderTimeline();return;}
    if(el.dataset.mixFx){beginEdit();const key=el.dataset.mixFx;clip().effects[key]=Number(el.value);engine.updateEffects(selected,clip().effects);$(`[data-fx-value="${key}"]`).textContent=fxLabel(Number(el.value),FX.find(f=>f[0]===key)[5]);changed();}
    if(el.matches('[data-clip-rate]')){beginEdit();clip().rate=Number(el.value);$('[data-speed-value]').textContent=`${clip().rate.toFixed(2)}×`;changed();}
  }
  function change(event){
    const el=event.target;
    if(el.matches('[data-preview-mode]')){previewMode=el.value;engine.pause();const range=bounds();if(range)engine.seek(range.start);return;}
    if(el.dataset.clipTime){const value=parseTime(el.value);if(!Number.isFinite(value)){message('Enter a time such as 1:23.50 or a number of seconds.',true);el.value=timeLabel(clip()[el.dataset.clipTime],true);return;}edit(()=>{const c=clip(),duration=context.byId(selected).duration||1;c[el.dataset.clipTime]=el.dataset.clipTime==='in'?clamp(value,0,c.out-.05):clamp(value,c.in+.05,duration);});}
    if(el.matches('[data-transition-duration]'))edit(()=>changeTransition({duration:clamp(el.value,0,Number(el.max))}));
    if(el.matches('[data-transition-curve]'))edit(()=>changeTransition({curve:el.value}));
    if(el.dataset.mixFx){commitEdit();renderTimeline();}
    if(el.matches('[data-clip-rate]')){commitEdit();refreshTiming();}
  }
  function beginTrim(event){
    const handle=event.target.closest('[data-trim]');if(!handle||event.button!==0)return;
    event.preventDefault();beginEdit();trimGesture={key:handle.dataset.trim,rect:handle.parentElement.getBoundingClientRect(),pointer:event.pointerId,handle};handle.setPointerCapture(event.pointerId);
  }
  function moveTrim(event){
    if(!trimGesture||trimGesture.pointer!==event.pointerId)return;event.preventDefault();
    const {rect,key}=trimGesture,c=clip(),duration=context.byId(selected).duration||1,value=clamp((event.clientX-rect.left)/rect.width,0,1)*duration;
    c[key]=key==='in'?clamp(value,0,c.out-.05):clamp(value,c.in+.05,duration);
    $('[data-trim="in"]').style.left=`${c.in/duration*100}%`;$('[data-trim="out"]').style.left=`${c.out/duration*100}%`;
    $('.mix-window').style.left=`${c.in/duration*100}%`;$('.mix-window').style.right=`${(1-c.out/duration)*100}%`;
    $(`[data-clip-time="${key}"]`).value=timeLabel(c[key],true);
  }
  function endTrim(event,cancel=false){if(!trimGesture||trimGesture.pointer!==event.pointerId)return;trimGesture=null;if(cancel&&editBefore){mix=editBefore.mix;order=editBefore.order;editBefore=null;renderInspector();return;}commitEdit();changed();refreshTiming();}
  async function action(name){
    if(name==='close')return close();
    if(name==='play')return play();
    if(name==='restart'){const range=bounds();if(range){engine.pause();engine.seek(range.start);}return;}
    if(name==='loop'){loop=!loop;$('[data-mix-action="loop"]').setAttribute('aria-pressed',String(loop));$('[data-mix-action="loop"]').classList.toggle('active',loop);if(engine.playing)void engine.play(engine.currentTime(),bounds());return;}
    if(name==='undo'||name==='redo')return undo(name==='redo');
    if(name==='retry')return flush();
    if(name==='move-up'||name==='move-down')return moveSelected(name==='move-up'?-1:1);
    if(name==='reset-clip')return edit(()=>{const c=clip();mix.clips[selected]=cleanClip({...c,in:0,out:context.byId(selected).duration,rate:1},context.byId(selected));});
    if(name==='cut'||name==='crossfade')return edit(()=>changeTransition({duration:name==='cut'?0:Math.min(2,entry().length/2,(timeline.entries[timeline.entries.indexOf(entry())+1]?.length||0)/2)}));
    if(name==='reset-fx')return edit(()=>{clip().effects=defaultEffects();engine.updateEffects(selected,clip().effects);},{timing:false});
    if(name==='bypass'){bypass=!bypass;engine.setBypass(bypass);renderInspector();return;}
    if(name==='audition-song'||name==='audition-transition'){previewMode=name==='audition-song'?'song':'transition';$('[data-preview-mode]').value=previewMode;const range=bounds();if(range)await engine.play(range.start,range);}
  }
  async function close(){
    if(closing)return;closing=true;commitEdit();engine.pause();
    try{await flush();}catch{closing=false;return;}
    opened=false;waveRequest++;dragCleanup?.();await engine.close();root.close();root.remove();root=null;waves.clear();context.state.mixEditing=false;document.body.classList.remove('mix-editing');context.ui.render();context.playback.updateMediaSession();restoreFocus?.focus?.();closing=false;
  }
  function onHide(){if(opened){commitEdit();engine.pause();void flush().catch(()=>{});}}
  function bindEvents(){document.addEventListener('visibilitychange',()=>{if(document.hidden)onHide();});window.addEventListener('pagehide',onHide);}
  async function open(id){
    if(opened)return;const playlist=context.playlist(id);if(!playlist)return;
    order=[...playlist.trackIds];mix=reconcileMix(playlist.mix,order,context.state.tracks);timeline=buildTimeline(mix,order);
    if(!timeline.entries.length)return context.ui.toast('Add songs to this playlist before opening Mix studio.');
    playlistId=id;selected=timeline.entries[0].trackId;pane='clip';mobileTab='arrange';history=[];future=[];editBefore=null;revision=0;savedRevision=0;saveError='';saveChain=Promise.resolve();previewMode='full';loop=false;bypass=false;playPosition=0;closing=false;
    context.playback.pausePlayback();context.playback.clearMediaSession();context.state.mixEditing=true;context.modal.close();context.nowDialog.close();restoreFocus=document.activeElement;document.body.classList.add('mix-editing');
    root=document.createElement('dialog');root.className='mix-editor';root.setAttribute('aria-labelledby','mixEditorTitle');root.dataset.mobileTab=mobileTab;
    root.innerHTML=`<header class="mix-head"><button class="mix-back" data-mix-action="close" aria-label="Save and return to playlist">${icon('close')}</button><div class="mix-heading"><p>MIX STUDIO</p><h2 id="mixEditorTitle">${esc(playlist.name)}</h2></div><button class="mix-save" data-mix-action="retry" aria-live="polite">Saved on device</button><div class="mix-history"><button data-mix-action="undo" aria-label="Undo" title="Undo (Ctrl/⌘ Z)">↶</button><button data-mix-action="redo" aria-label="Redo" title="Redo (Ctrl/⌘ Shift Z)">↷</button></div></header><div class="mix-workspace"><section class="mix-arrange" aria-label="Mix timeline"><div class="mix-timeline-toolbar"><div><span class="mix-kicker">THE ARRANGEMENT</span><h3 class="mix-total"></h3></div><label class="mix-zoom">Zoom<input data-mix-zoom type="range" min="0.5" max="16" step="0.5" value="${zoom}" aria-label="Timeline zoom"></label></div><div class="mix-timeline-scroll"><div class="mix-sequence"></div></div><p class="mix-arrange-note">Hold and drag a song to change playlist order. Select a clip to shape its sound.</p></section><aside class="mix-inspector" aria-label="Selected song controls"><nav class="mix-pane-nav" aria-label="Mix inspector"><button data-mix-pane="clip">Clip</button><button data-mix-pane="transition">Transition</button><button data-mix-pane="effects">Effects</button></nav><div class="mix-inspector-scroll"><div class="mix-inspector-head"></div><div class="mix-inspector-content"></div></div></aside></div><footer class="mix-transport"><div class="mix-progress"><span class="mix-live">PREVIEW READY</span><input data-mix-seek type="range" min="0" max="${timeline.duration}" step="0.01" value="0" aria-label="Mix playhead"><span class="mix-clock"></span></div><div class="mix-transport-row"><div class="mix-preview-select"><label for="mixPreviewMode">PREVIEW</label><select id="mixPreviewMode" data-preview-mode aria-label="Preview mode"><option value="full">Full mix</option><option value="song">Selected song</option><option value="transition">Transition</option></select></div><div class="mix-transport-buttons"><button data-mix-action="restart" aria-label="Return to preview start">${icon('previous')}</button><button class="mix-play" data-mix-action="play" aria-label="Play preview">${icon('play')}</button><button data-mix-action="loop" aria-label="Loop preview" aria-pressed="false" title="Loop preview">${icon('repeat')}</button></div><p class="mix-message" role="status">Hold a song to reorder. Originals stay untouched.</p></div><nav class="mix-mobile-nav" aria-label="Mix studio navigation"><button data-mix-tab="arrange">${icon('queue')}<span>Arrange</span></button><button data-mix-tab="clip">${icon('edit')}<span>Clip</span></button><button data-mix-tab="transition">${icon('next')}<span>Transition</span></button><button data-mix-tab="effects">${icon('settings')}<span>Effects</span></button></nav></footer>`;
    document.body.append(root);opened=true;
    engine=createMixAudio({onState:engineState,onTick:tick,onError:error=>message(error.message,true)});engine.setTimeline(timeline);
    root.addEventListener('cancel',e=>{e.preventDefault();void close();});
    root.addEventListener('click',e=>{
      const button=e.target.closest('button');if(!button||button.disabled)return;
      if(button.dataset.mixSelect){select(button.dataset.mixSelect);if(window.innerWidth<760&&button.closest('.mix-arrange'))setPane('clip');return;}
      if(button.dataset.mixTransition){select(button.dataset.mixTransition);setPane('transition');return;}
      if(button.dataset.mixPane)return setPane(button.dataset.mixPane);
      if(button.dataset.mixTab){if(button.dataset.mixTab==='arrange'){mobileTab='arrange';root.dataset.mobileTab=mobileTab;updateTabs();}else setPane(button.dataset.mixTab);return;}
      if(button.dataset.mixAction)void action(button.dataset.mixAction).catch(error=>message(error.message,true));
    });
    root.addEventListener('input',input);root.addEventListener('change',change);
    root.addEventListener('pointerdown',beginTrim);root.addEventListener('pointermove',moveTrim);root.addEventListener('pointerup',e=>endTrim(e));root.addEventListener('pointercancel',e=>endTrim(e,true));
    root.addEventListener('keydown',e=>{
      const typing=e.target.matches('input,select,textarea');
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!typing){e.preventDefault();undo(e.shiftKey);}
      if(e.code==='Space'&&!typing&&!e.target.closest('button')){e.preventDefault();void play();}
    });
    dragCleanup=bindDragOrder({root,selector:'[data-mix-row]',getScroller:()=>$('.mix-timeline-scroll'),onDrop:(row,target,after)=>reorder(row.dataset.mixRow,target.dataset.mixRow,after),onError:error=>message(error.message,true)});
    renderTimeline();renderInspector();updateHistory();root.showModal();void loadWave(selected);
  }
  return {open,close,bindEvents,get isOpen(){return opened;},actions:{'open-mix':button=>open(button.dataset.id)}};
}
