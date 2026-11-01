import * as db from './storage.js';
import { escapeHTML as esc, formatBytes } from './core.js';
import { icon } from './icons.js';

// Saves songs from this device's library as audio files, only when asked:
// - Chrome and Edge on a computer: into a folder you pick (a playlist gets its own subfolder).
// - iPhone and Android: through the share sheet's "Save to Files" / "Save", choosing the folder there.
// - Other browsers: as ordinary downloads.
const EXTENSIONS={'audio/mpeg':'mp3','audio/mp4':'m4a','audio/aac':'aac','audio/flac':'flac','audio/wav':'wav','audio/ogg':'ogg','audio/opus':'opus','audio/webm':'webm','audio/aiff':'aiff'};
// The share sheet copies every file it is given, so long playlists are saved in parts.
const SHARE_BATCH=20;
const PICKER_ID='squidify-downloads';
export const safeName=value=>{
  const name=String(value||'').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g,' ').replace(/\s+/g,' ').trim().slice(0,120).replace(/[. ]+$/,'');
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)?`_${name}`:name;
};
// "Artist - Title.ext", keeping the stored file's own format.
export function fileName(track){
  const ext=String(track.name||'').match(/\.([A-Za-z0-9]{1,5})$/)?.[1]?.toLowerCase()||EXTENSIONS[track.mime]||'mp3';
  const artist=/^unknown artist$/i.test(track.artist||'')?'':safeName(track.artist);
  const title=safeName(track.title)||safeName(String(track.name||'').replace(/\.[^.]+$/,''))||'Song';
  return `${artist?`${artist} - `:''}${title}.${ext}`;
}
export function createDownloads(context){
  const {state,byId,playlist,plural,modal}=context;
  const toast=(...args)=>context.ui.toast(...args);
  const setModal=(...args)=>context.ui.setModal(...args);
  const modalHead=(...args)=>context.ui.modalHead(...args);
  let shareQueue=null,saving=null;
  const canPickFolder=()=>typeof window.showDirectoryPicker==='function';
  const canPickFile=()=>typeof window.showSaveFilePicker==='function';
  const canShare=files=>{
    if(!(navigator.maxTouchPoints>0)||typeof navigator.share!=='function'||typeof navigator.canShare!=='function')return false;
    try{return navigator.canShare({files});}catch{return false;}
  };
  // Pickers open in the connected music folder when there is one.
  const startIn=()=>{const handle=state.folders.find(folder=>folder.handle)?.handle;return handle?{startIn:handle}:{};};
  async function pick(open,options){
    try{return await open({id:PICKER_ID,...options,...startIn()});}
    catch(error){
      if(error.name==='AbortError')return null;
      if(!startIn().startIn)throw error;
      // A connected folder that no longer exists can't be a starting point; ask without it.
      try{return await open({id:PICKER_ID,...options});}catch(retry){if(retry.name==='AbortError')return null;throw retry;}
    }
  }
  async function readFiles(ids){
    const items=[],missing=[],used=new Set();
    for(const id of ids){
      const track=byId(id);if(!track)continue;
      const media=await db.get('media',id).catch(()=>null);
      if(!media?.blob){missing.push(track.title);continue;}
      let name=fileName(track);const dot=name.lastIndexOf('.'),base=name.slice(0,dot),ext=name.slice(dot);
      for(let n=2;used.has(name.toLowerCase());n++)name=`${base} (${n})${ext}`;
      used.add(name.toLowerCase());
      items.push({track,file:new File([media.blob],name,{type:track.mime||media.blob.type||'audio/mpeg',lastModified:track.addedAt||Date.now()})});
    }
    return {items,missing};
  }
  async function write(handle,data){
    const writable=await handle.createWritable();
    try{await writable.write(data);await writable.close();}
    catch(error){await writable.abort?.().catch(()=>{});throw error;}
  }
  async function exists(folder,name){try{await folder.getFileHandle(name);return true;}catch{return false;}}
  const missingNote=missing=>missing.length?` · ${plural(missing.length,'song')} not on this device`:'';
  function browserDownload(items,missing){
    items.forEach(({file},index)=>setTimeout(()=>{
      const href=URL.createObjectURL(file),link=document.createElement('a');link.href=href;link.download=file.name;link.click();
      setTimeout(()=>URL.revokeObjectURL(href),60000);
    },index*400));
    toast(`${plural(items.length,'song')} sent to your browser’s downloads${missingNote(missing)}.`,!!missing.length,7000);
  }
  function shareStep(){
    const {label,parts,part,missing}=shareQueue,files=parts[part],size=files.reduce((sum,file)=>sum+file.size,0);
    const heading=parts.length>1?`Save ${label} · part ${part+1} of ${parts.length}`:`Save ${label}`;
    setModal(modalHead(heading)+`<p>${plural(files.length,'song')} · ${formatBytes(size)}. Choose <strong>Save to Files</strong> (or <strong>Save</strong>) in the share sheet, then pick the folder.</p>${missing.length&&!part?`<p class="small-note">${plural(missing.length,'song')} not on this device will be skipped.</p>`:''}<div class="modal-actions"><button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="download-share">${icon('download')}${parts.length>1?`Save part ${part+1}`:'Save to Files'}</button></div>`);
  }
  // Called straight from the tap: the share sheet only opens with the tap's permission, so nothing is awaited first.
  function shareNow(){
    if(!shareQueue)return;
    const queue=shareQueue,files=queue.parts[queue.part];
    let shared;try{shared=navigator.share({files});}catch(error){return Promise.reject(error);}
    return Promise.resolve(shared).then(()=>{
      if(shareQueue!==queue)return;
      if(queue.part+1<queue.parts.length){queue.part++;shareStep();return;}
      shareQueue=null;modal.close();toast(`${plural(queue.parts.flat().length,'song')} shared. They are in the folder you chose.`);
    },error=>{if(error?.name!=='AbortError')throw error;});
  }
  function offerShare(items,label,missing){
    const files=items.map(item=>item.file),parts=[];
    for(let i=0;i<files.length;i+=SHARE_BATCH)parts.push(files.slice(i,i+SHARE_BATCH));
    shareQueue={label,parts,part:0,missing};shareStep();
  }
  function progress(label,done,total){
    setModal(modalHead(`Saving ${label}`)+`<p id="downloadStatus">${done} of ${total} saved…</p><progress class="download-progress" max="${total}" value="${done}"></progress><div class="modal-actions"><button class="button" data-action="download-stop">Stop</button></div>`);
  }
  async function downloadTrack(id){
    const track=byId(id);if(!track)return;
    modal.close();
    const {items,missing}=await readFiles([id]);
    if(!items.length)return toast('This song’s audio is missing on this device. Import it again to download it.',true);
    const [{file}]=items;
    if(canPickFile()){
      const handle=await pick(options=>window.showSaveFilePicker(options),{suggestedName:file.name});
      if(!handle)return;
      await write(handle,file);return toast(`Saved ${handle.name||file.name}.`);
    }
    if(canShare([file]))return offerShare(items,track.title,missing);
    browserDownload(items,missing);
  }
  async function downloadPlaylist(id){
    const p=playlist(id);if(!p)return;
    modal.close();
    const ids=p.trackIds.filter(trackId=>byId(trackId));
    if(!ids.length)return toast('This playlist has no songs to download.');
    const {items,missing}=await readFiles(ids);
    if(!items.length)return toast('None of these songs’ audio is on this device.',true);
    if(canPickFolder()){
      const root=await pick(options=>window.showDirectoryPicker(options),{mode:'readwrite'});
      if(!root)return;
      const name=safeName(p.name)||'Playlist',folder=await root.getDirectoryHandle(name,{create:true});
      saving={stop:false};let saved=0,kept=0;
      try{
        for(const [index,{file}] of items.entries()){
          if(saving.stop)break;
          progress(p.name,index,items.length);
          // Never overwrite: a file that is already there stays as it is.
          if(await exists(folder,file.name)){kept++;continue;}
          await write(await folder.getFileHandle(file.name,{create:true}),file);saved++;
        }
      }finally{
        const stopped=saving.stop;saving=null;modal.close();
        toast(`${plural(saved,'song')} saved to ${root.name}/${folder.name}${kept?` · ${kept} already there`:''}${missingNote(missing)}${stopped?' · stopped':''}.`,!!missing.length,8000);
      }
      return;
    }
    if(canShare([items[0].file]))return offerShare(items,p.name,missing);
    browserDownload(items,missing);
  }
  const actions={
    'download-track':button=>downloadTrack(button.dataset.id),
    'download-playlist':button=>downloadPlaylist(button.dataset.id),
    'download-share':()=>shareNow(),
    'download-stop':()=>{if(saving)saving.stop=true;}
  };
  return {downloadTrack,downloadPlaylist,actions,get pendingShare(){return shareQueue&&{part:shareQueue.part,parts:shareQueue.parts.length};}};
}
