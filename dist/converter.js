import * as db from './storage.js';
import { escapeHTML as esc, formatBytes } from './core.js';
import { icon } from './icons.js';
import { fingerprint } from './metadata.js';
import { converterConfig, youtubeURL, youtubeTarget, createConverterClient } from './converter-client.js';

// Playlist videos convert one at a time, with a short gap so YouTube does not see a burst of downloads.
const PLAYLIST_GAP=1500;
const watchURL=id=>`https://www.youtube.com/watch?v=${id}`;
function wait(ms,signal){return new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});});}
const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
const counts=b=>[`${b.added} added`,b.existing&&`${b.existing} already in your library`,b.failed.length&&`${b.failed.length} could not be converted`].filter(Boolean).join(' · ');
export function createConverter(context,{clientFactory=createConverterClient}={}){
  let config=null,job=null,file=null,controller=null,running=false,generation=0,url='',phase='idle',message='',title='',progress=0,total=0;
  // offer: a listed playlist awaiting confirmation. batch: a playlist being converted (saved, so it resumes). summary: the last finished playlist.
  let offer=null,batch=null,summary=null;
  const $=selector=>context.$(selector);
  const refresh=()=>{if(context.state.view==='settings')context.ui.render();};
  const busy=()=>running||phase==='importing';
  const locked=()=>busy()||!!job||!!batch||phase==='choose';
  const notify=(next,text)=>{phase=next;message=text;paint();};
  const persistJob=()=>db.setSetting('converterJob',job);
  const persistBatch=()=>db.setSetting('converterBatch',batch);
  const batchPaused=()=>`Playlist paused at ${Math.min(batch.index+1,batch.entries.length)} of ${batch.entries.length}. Resume to continue.`;
  async function loadSettings(){
    const [saved,pending,savedBatch]=await Promise.all([db.setting('converterConnection',null),db.setting('converterJob',null),db.setting('converterBatch',null)]);
    try{if(saved)config=converterConfig(saved.endpoint,saved.token);}catch{}
    if(config&&pending?.endpoint===config.endpoint&&/^[a-f0-9]{48}$/.test(pending.id)){
      job=pending;url=pending.url||'';title=pending.title||'';phase='paused';message='An earlier conversion is waiting. Resume to check it and add the song.';
    }
    if(config&&savedBatch?.endpoint===config.endpoint&&Array.isArray(savedBatch.entries)&&savedBatch.index<savedBatch.entries.length){batch=savedBatch;phase='paused';message=batchPaused();}
  }
  function batchHTML(){
    if(!batch)return '';
    const n=batch.entries.length,done=Math.min(batch.index,n);
    return `<div class="converter-batch"><div><strong>${esc(batch.title)}</strong><span>${Math.min(done+1,n)} of ${n}</span></div><progress aria-label="Playlist progress" max="${n}" value="${done}"></progress><small>${counts(batch)}</small></div>`;
  }
  function offerHTML(){
    const n=offer.entries.length,notes=[plural(n,'video'),offer.unavailable&&`${offer.unavailable} private or deleted skipped`,offer.truncated&&`only the first ${n}`].filter(Boolean).join(' · ');
    return `<div class="converter-status" role="status"><strong>${esc(offer.title)}</strong><span>${esc(notes)}</span><label class="converter-check"><input type="checkbox" id="converterMakePlaylist" checked> Also create a Squidify playlist</label><div class="converter-result-actions"><button class="button primary" data-action="converter-playlist">${icon('plus')}Convert all ${n}</button>${offer.video?'<button class="button" data-action="converter-single">Just this video</button>':''}<button class="button quiet" data-action="converter-dismiss">Cancel</button></div></div>`;
  }
  function failuresHTML(){
    if(phase!=='saved'&&phase!=='error'||!summary?.failed.length)return '';
    return `<details class="converter-failures"><summary>${plural(summary.failed.length,'video')} could not be converted</summary><ul>${summary.failed.map(f=>`<li><strong>${esc(f.title)}</strong><span>${esc(f.reason)}</span></li>`).join('')}</ul></details>`;
  }
  function resultHTML(){
    if(phase==='choose'&&offer)return offerHTML();
    if(!message&&!job&&!batch)return '';
    const active=busy(),ready=!!file,actions=[];
    if(!active&&(job||batch))actions.push(`<button class="button primary" data-action="converter-resume">${icon(ready?'plus':'refresh')}${ready?'Add to library':batch?'Resume playlist':'Resume conversion'}</button>`);
    if(ready&&!active)actions.push(`<button class="button" data-action="converter-download">${icon('download')}Save file instead</button>`);
    if(job||running||batch)actions.push(`<button class="button quiet" data-action="converter-cancel" ${phase==='importing'?'disabled':''}>${batch?'Stop playlist':active?'Cancel':'Discard conversion'}</button>`);
    if(phase==='error'&&offer?.video&&!job&&!batch)actions.push('<button class="button" data-action="converter-single">Just this video</button>');
    if(!batch&&summary?.playlistId&&context.playlist(summary.playlistId)&&(phase==='saved'||phase==='error'))actions.push(`<button class="button" data-view="playlist" data-id="${esc(summary.playlistId)}">Open playlist</button>`);
    if(phase==='saved'&&!batch)actions.push('<button class="button quiet" data-view="library">Open library</button>');
    return `${batchHTML()}<div class="converter-status ${phase==='error'?'error':phase==='saved'?'success':''}" role="status"><strong>${esc(message||'Ready')}</strong>${title?`<span>${esc(title)}</span>`:''}${phase==='downloading'?`<progress aria-label="Receiving audio" ${total?`max="${total}" value="${progress}"`:''}></progress><small>${formatBytes(progress)}${total?' / '+formatBytes(total):''}</small>`:''}${active&&phase!=='downloading'?'<progress aria-label="Conversion in progress"></progress>':''}${failuresHTML()}<div class="converter-result-actions">${actions.join('')}</div></div>`;
  }
  function panel(){
    const lock=locked();
    return `<section class="settings-card converter-card" id="converterPanel"><div class="converter-heading"><div><p class="eyebrow">MUSIC IMPORT</p><h2>YouTube to your library</h2></div><span class="converter-badge">${config?'Service configured':'Service needed'}</span></div><p>Paste a video or playlist link to save its audio directly in Squidify.</p><form id="converterForm"><label for="converterVideo">YouTube video or playlist link</label><div class="converter-url-row"><input class="text-input" id="converterVideo" type="url" inputmode="url" placeholder="https://www.youtube.com/watch?v=…" value="${esc(url)}" maxlength="2048" required ${lock?'disabled':''}><button class="button primary" type="submit" ${!config||lock?'disabled':''}>${icon('plus')}Convert & add</button></div></form><div id="converterResult">${resultHTML()}</div><p class="small-note">Videos up to 20 minutes · Playlists up to 200 videos, converted one at a time while Squidify stays open · YouTube’s original audio when available (no re-encoding), otherwise MP3 · Internet required for conversion. Saved songs play offline.</p><details class="converter-connection" ${!config?'open':''}><summary>${config?'Converter connection':'Connect a conversion service'}</summary><p class="small-note">YouTube conversion needs a separately hosted converter. Connect your Squidify converter service here. Only video and playlist links are sent to that service; your existing music stays on this device.</p><form id="converterConnectionForm"><label for="converterEndpoint">Service address</label><input id="converterEndpoint" class="text-input" type="url" placeholder="https://converter.example.com" value="${esc(config?.endpoint||'')}" required ${lock?'disabled':''}><label for="converterToken">Service access key</label><input id="converterToken" class="text-input" type="password" autocomplete="off" minlength="32" maxlength="256" value="${esc(config?.token||'')}" placeholder="Key from your converter service" required ${lock?'disabled':''}><div class="converter-result-actions"><button class="button" type="submit" ${lock?'disabled':''}>Test & save connection</button>${config?`<button class="button quiet" type="button" data-action="converter-disconnect" ${lock?'disabled':''}>Disconnect</button>`:''}</div><p class="small-note">The address and access key are saved only in this browser. Disconnect removes them.</p></form></details><div class="converter-local"><span>Already have the audio file?</span><button class="button quiet" data-action="choose-files">${icon('folder')}Choose files</button></div></section>`;
  }
  function paint(){
    const host=$('#converterResult');if(host)host.innerHTML=resultHTML();
    const lock=locked();
    const input=$('#converterVideo');if(input)input.disabled=lock;
    const form=$('#converterForm');if(form)form.querySelector('button[type="submit"]').disabled=!config||lock;
    for(const selector of ['#converterEndpoint','#converterToken']){const element=$(selector);if(element)element.disabled=lock;}
    $('#converterConnectionForm')?.querySelectorAll('button').forEach(button=>{button.disabled=lock;});
  }
  async function saveConnection(endpoint,token){
    if(locked())return;
    const next=converterConfig(endpoint,token),client=clientFactory(next);running=true;controller=new AbortController();const tokenId=++generation;
    notify('connecting','Checking the converter…');
    try{await client.check(controller.signal);if(tokenId!==generation)return;await db.setSetting('converterConnection',next);config=next;notify('idle','Connection saved. Paste a video or playlist link to begin.');}
    catch(error){if(tokenId===generation)notify('error',error.message);}
    finally{if(tokenId===generation){running=false;controller=null;refresh();}}
  }
  async function processJob(client,signal,tokenId){
    while(job&&tokenId===generation){
      const result=await client.status(job.id,signal);if(tokenId!==generation)return;
      title=String(result.title||'').slice(0,200);
      if(result.status==='failed'||result.status==='cancelled'){const error=new Error(result.error||'Conversion was cancelled.');error.terminal=true;throw error;}
      if(result.status==='ready'){
        notify('downloading','Receiving your song…');progress=0;total=0;
        const downloaded=await client.download(job.id,title,signal,(received,size)=>{if(tokenId!==generation)return;progress=received;total=size;paint();});
        if(tokenId!==generation)return;file=downloaded;return importReady(client,tokenId);
      }
      if(!['validating','converting','downloading'].includes(result.status)){const error=new Error('This conversion is no longer available. Convert the video again.');error.terminal=true;throw error;}
      if(Date.now()-job.started>7*60*1000)throw new Error('The service is still processing. Resume later to check this conversion.');
      notify(result.status,result.status==='validating'?'Checking the video…':result.status==='downloading'?'Another window is receiving this song…':'Extracting the audio…');
      await wait(1500,signal);
    }
  }
  // Returns what happened, for playlists: saved (with the library track), retry (keep the job), or stopped.
  async function importReady(client,tokenId){
    if(!file||tokenId!==generation)return {kind:'stopped'};
    if(context.state.busy){notify('ready','Your song is ready. Finish the current file import, then choose Add to library.');return {kind:'retry'};}
    notify('importing','Adding the song to your library…');
    const id=await fingerprint(file).catch(()=>null);
    const outcome=await context.importer.importEntries([{file,path:file.name}]);
    if(tokenId!==generation)return {kind:'stopped'};
    if(outcome?.added||outcome?.skipped){
      const completed=job?.id;job=null;file=null;
      await persistJob().catch(()=>{});notify('saved',outcome.added?'Saved to your library. Ready for offline listening.':'This song is already in your library.');
      if(completed)void client.complete(completed).catch(()=>{});
      return {kind:'saved',added:!!outcome.added,trackId:outcome.trackId||(id&&context.state.tracks.has(id)?id:null)};
    }
    notify('ready',outcome?.quota?'Storage is full. Free some space and retry, or save the file to your device.':'The song could not be added. Retry or save the file to your device.');
    return {kind:'retry'};
  }
  async function run(start=false,entryTitle=''){
    if(busy())return;if(!config)return notify('error','Connect your converter service first.');
    if(navigator.onLine===false){notify('error','Connect to the internet to convert or receive this song.');return {kind:'retry'};}
    if(start&&job)return;
    let canonical;if(start)canonical=youtubeURL(url);
    running=true;controller=new AbortController();const signal=controller.signal,tokenId=++generation,client=clientFactory(config);
    try{
      if(start){notify('validating','Connecting to your converter…');await client.check(signal);if(tokenId!==generation)return {kind:'stopped'};const id=await client.start(canonical,signal);if(tokenId!==generation){void client.cancel(id).catch(()=>{});return {kind:'stopped'};}job={id,url:canonical,endpoint:config.endpoint,started:Date.now()};title=entryTitle;file=null;await persistJob();}
      const result=file?await importReady(client,tokenId):job?await processJob(client,signal,tokenId):null;
      return tokenId===generation&&result?result:{kind:'stopped'};
    }catch(error){
      if(tokenId!==generation)return {kind:'stopped'};
      // The video itself can't be converted (removed, private, too long, rejected link): later attempts won't help.
      const terminal=error.terminal||error.status===404||error.status===400;
      if(terminal){job=null;file=null;await persistJob().catch(()=>{});}
      if(error.name==='AbortError')return {kind:'stopped'};
      notify('error',error.message);
      return terminal?{kind:'failed',reason:error.message}:{kind:'retry'};
    }finally{if(tokenId===generation){running=false;controller=null;paint();}}
  }
  // A pasted link: a single video converts straight away; a playlist is listed first and confirmed.
  async function submit(){
    if(locked())return;if(!config)return notify('error','Connect your converter service first.');
    summary=null;offer=null;
    const target=youtubeTarget(url);
    if(!target.playlist)return run(true);
    if(navigator.onLine===false)return notify('error','Connect to the internet to read this playlist.');
    running=true;controller=new AbortController();const tokenId=++generation,client=clientFactory(config);title='';
    notify('listing','Reading the playlist…');
    try{
      const list=await client.playlist(target.playlist,controller.signal);if(tokenId!==generation)return;
      if(!list.entries.length)throw new Error('This playlist has no videos that can be converted.');
      offer={...list,video:target.video};phase='choose';message='';
    }catch(error){
      if(tokenId!==generation||error.name==='AbortError')return;
      offer=target.video?{video:target.video,entries:[]}:null;
      phase='error';message=target.video?`${error.message} You can still convert just this video.`:error.message;
    }finally{if(tokenId===generation){running=false;controller=null;paint();}}
  }
  async function startBatch(){
    if(!offer?.entries?.length||busy()||job||batch||!config)return;
    const state=context.state,makePlaylist=$('#converterMakePlaylist')?.checked!==false;let playlistId=null;
    if(makePlaylist){const p={id:context.idToken(),name:offer.title,trackIds:[],color:state.playlists.length%2?'lime':'purple',createdAt:Date.now()};await db.put('playlists',p);state.playlists.push(p);playlistId=p.id;}
    batch={endpoint:config.endpoint,title:offer.title,playlistId,entries:offer.entries,index:0,added:0,existing:0,failed:[],started:Date.now()};
    offer=null;summary=null;phase='idle';message='';await persistBatch();
    return runBatch();
  }
  async function addToPlaylist(trackId){
    const p=batch?.playlistId&&context.playlist(batch.playlistId);
    if(!trackId||!p||p.trackIds.includes(trackId))return;
    const updated={...p,trackIds:[...p.trackIds,trackId]};await db.put('playlists',updated).catch(()=>{});Object.assign(p,updated);
    if(context.state.view==='playlist'&&context.state.detail===p.id)context.ui.render();
  }
  async function gap(){
    running=true;controller=new AbortController();const tokenId=++generation;
    try{await wait(PLAYLIST_GAP,controller.signal);return tokenId===generation;}catch{return false;}
    finally{if(tokenId===generation){running=false;controller=null;paint();}}
  }
  async function runBatch(){
    if(!batch||busy())return;
    while(batch&&batch.index<batch.entries.length){
      const entry=batch.entries[batch.index];let result;
      if(job||file)result=await run();else{url=watchURL(entry.id);result=await run(true,entry.title);}
      if(!batch||!result||result.kind==='stopped')return;
      // Connection or storage problems pause the playlist; the current video resumes rather than restarting.
      if(result.kind==='retry'){message=`${message} ${batchPaused()}`;paint();return;}
      if(result.kind==='saved'){if(result.added)batch.added++;else batch.existing++;await addToPlaylist(result.trackId);}
      else batch.failed.push({title:entry.title,reason:result.reason});
      batch.index++;await persistBatch();
      if(batch.index<batch.entries.length&&!await gap())return;
    }
    if(!batch)return;
    const finished=batch;batch=null;await persistBatch().catch(()=>{});
    summary={playlistId:finished.playlistId,failed:finished.failed};title='';url='';
    const parts=[`${plural(finished.added,'song')} added`,finished.existing&&`${finished.existing} already in your library`,finished.failed.length&&`${finished.failed.length} could not be converted`].filter(Boolean);
    notify(finished.added||finished.existing?'saved':'error',`Playlist finished: ${parts.join(', ')}.`);refresh();
  }
  async function cancel(){
    if(phase==='importing')return;
    const previous=job,stopped=batch,client=config&&clientFactory(config);generation++;controller?.abort();controller=null;running=false;job=null;file=null;title='';progress=0;total=0;offer=null;
    await persistJob();
    if(stopped){batch=null;await persistBatch();summary={playlistId:stopped.playlistId,failed:stopped.failed};notify('idle',`Playlist stopped after ${stopped.index} of ${stopped.entries.length}. Songs already converted${stopped.playlistId?' and the playlist':''} were kept.`);}
    else notify('idle','Conversion cancelled.');
    if(previous&&client)void client.cancel(previous.id).catch(()=>{});
  }
  async function disconnect(){if(locked())return;await db.setSetting('converterConnection',null);config=null;message='Connection removed from this device.';phase='idle';refresh();}
  function download(){if(!file)return;const href=URL.createObjectURL(file),link=document.createElement('a');link.href=href;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(href),60000);}
  function single(){if(!offer?.video||busy()||job||batch)return;url=offer.video;offer=null;phase='idle';message='';return run(true);}
  function bindEvents(){
    document.addEventListener('input',event=>{if(event.target.id==='converterVideo')url=event.target.value;});
    document.addEventListener('submit',event=>{
      if(event.target.id==='converterForm'){event.preventDefault();url=$('#converterVideo').value;void submit().catch(error=>notify('error',error.message));}
      if(event.target.id==='converterConnectionForm'){event.preventDefault();void saveConnection($('#converterEndpoint').value,$('#converterToken').value).catch(error=>notify('error',error.message));}
    });
    window.addEventListener('pagehide',()=>{
      if(!running||phase==='importing')return;generation++;controller?.abort();controller=null;running=false;
      if(batch){phase='paused';message=batchPaused();}else if(job){phase='paused';message='Resume this conversion to check it and add the song.';}else{phase='idle';message='';}
    });
  }
  return {panel,loadSettings,bindEvents,saveConnection,run,submit,startBatch,cancel,get job(){return job;},get batch(){return batch;},get offer(){return offer;},get status(){return {phase,message,running,hasFile:!!file,summary};},setURL:value=>{url=value;},actions:{'converter-resume':()=>batch?runBatch():run(),'converter-cancel':cancel,'converter-disconnect':disconnect,'converter-download':download,'converter-playlist':startBatch,'converter-single':single,'converter-dismiss':()=>{offer=null;notify('idle','');}}};
}
