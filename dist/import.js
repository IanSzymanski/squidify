import * as db from './storage.js';
import { formatTime } from './core.js';
import { isAudio, mimeFor, fingerprint, readMetadata } from './metadata.js';

export function createImport(context) {
  const { $, $$, audio, modal, fileInput, folderInput, state, trackArray, byId, idToken, plural } = context;
  const toast = (...args) => context.ui.toast(...args);
  const report = (...args) => context.ui.report(...args);
  const render = (...args) => context.ui.render(...args);
  const loadTrack = (...args) => context.playback.loadTrack(...args);
  const saveSession = (...args) => context.playback.saveSession(...args);
  let metadataJobs = [], probing = false;

  async function* walkFolder(handle,path='') {
    for await(const entry of handle.values()) {
      const next=path?`${path}/${entry.name}`:entry.name;
      if(entry.kind==='directory')yield*walkFolder(entry,next);
      else yield{file:await entry.getFile(),path:next};
    }
  }
  async function chooseFolder() {
    if(state.busy)return toast('Finish the current import first.');
    if(!('showDirectoryPicker' in window)){openFilePicker(folderInput);return;}
    state.pickerOpen=true;
    try {
      const handle=await window.showDirectoryPicker({mode:'read',id:'squidify-music'});
      state.pickerOpen=false;
      let existing;
      for(const f of state.folders){try{if(await handle.isSameEntry(f.handle))existing=f;}catch{}}
      const folder=existing||{id:idToken(),name:handle.name,handle};
      try {await db.put('folders',folder);if(!existing)state.folders.push(folder);}catch{toast('Music can be imported, but this browser could not remember the folder connection.');}
      await importEntries(walkFolder(handle,handle.name),folder.id);
    } catch(error){if(error.name!=='AbortError')report(error,'Could not read that folder. Try Choose files instead.');}
    finally {state.pickerOpen=false;render();}
  }
  async function rescanFolder(id) {
    if(state.busy)return toast('Finish the current import first.');
    const f=state.folders.find(x=>x.id===id);if(!f)return;
    try{
      const permission=await f.handle.requestPermission({mode:'read'});
      if(permission!=='granted')return toast('Folder access was not granted. Saved music is still available.',true);
      await importEntries(walkFolder(f.handle,f.name),f.id);
    }catch(e){report(e,'Reconnect this folder using Add music. Existing songs are still saved.');}
  }
  function openFilePicker(input) {
    if(state.busy)return toast('Finish the current import first.');
    state.pickerOpen=true;
    // Stay within the user gesture, without closing dialogs or restoring focus.
    try {if(typeof input.showPicker==='function')input.showPicker();else input.click();}
    catch {try{input.click();}catch(e){state.pickerOpen=false;report(e,'Use Add music to choose files directly.');}}
  }
  function selectFiles() {openFilePicker(fileInput);}
  async function importEntries(entries,folderId=null) {
    state.pickerOpen=false;
    if(state.busy)return;
    state.busy=true;state.stopImport=false;modal.close();
    const banner=$('#importBanner'),progress=$('#importProgress'),text=$('#importText');banner.hidden=false;progress.removeAttribute('value');
    text.textContent='Reading your music…';
    let added=0,skipped=0,unsupported=0,failed=0,total=0,quota=false,firstTrack=null;const files=[];
    try {
      // A persistence request is advisory; only successful IndexedDB commits count as saved songs.
      navigator.storage?.persist?.().catch(()=>false);
      for await(const entry of entries) {
        if(state.stopImport)break;
        const file=entry.file||entry;
        if(!isAudio(file)){unsupported++;files.push({name:file.name,reason:'Unsupported file type'});continue;}
        total++;text.textContent=`Saving ${file.name} · ${added} added`;
        try {
          const id=await fingerprint(file);
          if(state.tracks.has(id)){skipped++;files.push({name:file.name,reason:'Duplicate — already in your library'});continue;}
          if(audio.canPlayType && !audio.canPlayType(mimeFor(file))){unsupported++;files.push({name:file.name,reason:'Audio format is not supported by this browser'});continue;}
          const check=await validateAudio(file);
          if(!check.ok){failed++;files.push({name:file.name,reason:check.reason});continue;}
          const path=entry.path||file.webkitRelativePath||file.name;
          const tags=await readMetadata(file,path);
          const track={...tags,duration:check.duration||tags.duration,id,name:file.name,path,folderId,size:file.size,mime:mimeFor(file),addedAt:Date.now(),liked:false};
          const blob=new Blob([file],{type:track.mime});
          await db.saveTrack(track,blob);
          state.tracks.set(id,track);added++;firstTrack ||= id;
          if(!track.duration)metadataJobs.push({id,blob});
          if(added%8===0){render();await new Promise(resolve=>setTimeout(resolve,0));}
        } catch(e){if(e.name==='QuotaExceededError'){quota=true;files.push({name:file.name,reason:'Storage is full — this file and remaining files were not saved'});break;}failed++;files.push({name:file.name,reason:'Could not read or save this file'});console.error('Import failed',file.name,e);}
      }
    }catch(e){failed++;files.push({name:'Folder import',reason:'Folder access was interrupted. Files already saved were kept; remaining files were not read.'});console.error('Folder read interrupted',e);}
    finally{
      state.busy=false;banner.hidden=true;state.storage=await db.storageInfo();render();
      if(firstTrack&&!state.queue.current){state.queue.start(trackArray().map(t=>t.id),firstTrack,state.tracks,'Your library');await loadTrack(firstTrack,false);}
      let message=`${plural(added,'song')} saved`;
      if(skipped)message+=` · ${skipped} duplicate${skipped===1?'':'s'} skipped`;
      if(unsupported)message+=` · ${unsupported} unsupported`;
      if(failed)message+=` · ${failed} could not be read`;
      if(state.stopImport)message+=' · import stopped';
      if(quota)message+=' · storage is full';
      state.importReport={summary:message+'.',files};
      toast(message+'.'+(files.length?' See Import results in Add music.':''),quota||!!failed||!!unsupported,7000);
      if(!total&&!added&&!failed&&!skipped)toast('No audio files found in that folder.');
      runDurationJobs();saveSession();
    }
  }
  async function validateAudio(file) {
    // Metadata decoding catches corrupt/unsupported codecs before committing a copy.
    return new Promise(resolve=>{
      const probe=new Audio(),url=URL.createObjectURL(file);let done=false;
      const finish=result=>{if(done)return;done=true;clearTimeout(timer);probe.onloadedmetadata=null;probe.onerror=null;probe.removeAttribute('src');probe.load();URL.revokeObjectURL(url);resolve(result);};
      const timer=setTimeout(()=>finish({ok:false,reason:'Audio validation timed out — try importing this file again'}),5000);
      probe.preload='metadata';probe.onloadedmetadata=()=>finish({ok:true,duration:Number.isFinite(probe.duration)?probe.duration:undefined});
      probe.onerror=()=>finish({ok:false,reason:'Unreadable audio or a codec this browser cannot play'});probe.src=url;probe.load();
    });
  }
  async function probeDuration(blob) {
    return new Promise(resolve=>{
      const probe=new Audio(); const url=URL.createObjectURL(blob);let timer;
      const done=value=>{clearTimeout(timer);probe.onloadedmetadata=null;probe.onerror=null;probe.removeAttribute('src');probe.load();URL.revokeObjectURL(url);resolve(value);};
      probe.preload='metadata';probe.onloadedmetadata=()=>done(Number.isFinite(probe.duration)&&probe.duration>0?probe.duration:undefined);probe.onerror=()=>done(undefined);
      timer=setTimeout(()=>done(undefined),1800);probe.src=url;
    });
  }
  async function runDurationJobs() {
    if(probing)return;probing=true;
    let consecutiveTimeouts=0;
    while(metadataJobs.length){
      const {id,blob}=metadataJobs.shift();if(!byId(id))continue;
      const duration=await probeDuration(blob);
      if(duration){const t=byId(id);if(t){t.duration=duration;await db.put('tracks',t).catch(()=>{});$$(`[data-duration-id="${id}"]`).forEach(el=>el.textContent=formatTime(duration));}consecutiveTimeouts=0;}
      else consecutiveTimeouts++;
      if(consecutiveTimeouts>=3){metadataJobs=[];break;}
    }
    probing=false;
  }


  function bindEvents() {
  document.addEventListener('change',event=>{
    const el=event.target;
    if(el.id==='sortSelect'){state.sort=el.value;render();saveSession();}
    if(el===fileInput||el===folderInput){state.pickerOpen=false;const files=[...el.files];el.value='';if(files.length)importEntries(files.map(file=>({file,path:file.webkitRelativePath||file.name}))).catch(e=>report(e));else render();}
  });
  document.addEventListener('cancel',event=>{if(event.target===fileInput||event.target===folderInput){state.pickerOpen=false;render();}});
  // Older browsers may omit the file-input cancel event. The next page interaction
  // safely ends that pending state; blur/focus alone must not dismiss a live picker.
  document.addEventListener('pointerdown',event=>{if(state.pickerOpen&&event.target!==fileInput&&event.target!==folderInput){state.pickerOpen=false;}});
  // File drops stay local and use exactly the same import path as the file picker.
  let dragDepth=0;
  document.addEventListener('dragenter',e=>{if(!e.dataTransfer?.types.includes('Files'))return;e.preventDefault();dragDepth++;if(!$('.drag-overlay')){const overlay=document.createElement('div');overlay.className='drag-overlay';overlay.textContent='Drop your music here';document.body.append(overlay);}});
  document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault();});
  document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('.drag-overlay')?.remove();}});
  document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('.drag-overlay')?.remove();if(state.busy)return toast('Finish the current import first.');const files=[...(e.dataTransfer?.files||[])];if(files.length)importEntries(files.map(file=>({file}))).catch(report);});
  }

  const actions = {
  'rescan':b=>rescanFolder(b.dataset.id),
  'forget-folder':async b=>{await db.remove('folders',b.dataset.id);state.folders=state.folders.filter(f=>f.id!==b.dataset.id);render();toast('Folder connection forgotten. Saved songs are unchanged.');}
  };

  return { chooseFolder, selectFiles, importEntries, bindEvents, actions };
}
