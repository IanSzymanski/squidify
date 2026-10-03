import * as db from './storage.js';
import { escapeHTML as esc, formatBytes } from './core.js';
import { icon } from './icons.js';
import { converterConfig, youtubeURL, createConverterClient } from './converter-client.js';

function wait(ms,signal){return new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});});}
export function createConverter(context,{clientFactory=createConverterClient}={}){
  let config=null,job=null,file=null,controller=null,running=false,generation=0,url='',phase='idle',message='',title='',progress=0,total=0;
  const $=selector=>context.$(selector);
  const refresh=()=>{if(context.state.view==='settings')context.ui.render();};
  const busy=()=>running||phase==='importing';
  const notify=(next,text)=>{phase=next;message=text;paint();};
  const persistJob=()=>db.setSetting('converterJob',job);
  async function loadSettings(){
    const [saved,pending]=await Promise.all([db.setting('converterConnection',null),db.setting('converterJob',null)]);
    try{if(saved)config=converterConfig(saved.endpoint,saved.token);}catch{}
    if(config&&pending?.endpoint===config.endpoint&&/^[a-f0-9]{48}$/.test(pending.id)){
      job=pending;url=pending.url||'';title=pending.title||'';phase='paused';message='An earlier conversion is waiting. Resume to check it and add the MP3.';
    }
  }
  function resultHTML(){
    if(!message&&!job)return '';
    const active=busy(),ready=!!file;
    return `<div class="converter-status ${phase==='error'?'error':phase==='saved'?'success':''}" role="status"><strong>${esc(message||'Ready')}</strong>${title?`<span>${esc(title)}</span>`:''}${phase==='downloading'?`<progress aria-label="Receiving MP3" ${total?`max="${total}" value="${progress}"`:''}></progress><small>${formatBytes(progress)}${total?' / '+formatBytes(total):''}</small>`:''}${active&&phase!=='downloading'?'<progress aria-label="Conversion in progress"></progress>':''}<div class="converter-result-actions">${!active&&job?`<button class="button primary" data-action="converter-resume">${icon(ready?'plus':'refresh')}${ready?'Add to library':'Resume conversion'}</button>`:''}${ready&&!active?`<button class="button" data-action="converter-download">${icon('download')}Save MP3 instead</button>`:''}${job||running?`<button class="button quiet" data-action="converter-cancel" ${phase==='importing'?'disabled':''}>${active?'Cancel':'Discard conversion'}</button>`:''}${phase==='saved'?'<button class="button quiet" data-view="library">Open library</button>':''}</div></div>`;
  }
  function panel(){
    return `<section class="settings-card converter-card" id="converterPanel"><div class="converter-heading"><div><p class="eyebrow">MUSIC IMPORT</p><h2>YouTube to your library</h2></div><span class="converter-badge">${config?'Service configured':'Service needed'}</span></div><p>Paste a video link to convert its audio to MP3 and save it directly in Squidify.</p><form id="converterForm"><label for="converterVideo">YouTube video link</label><div class="converter-url-row"><input class="text-input" id="converterVideo" type="url" inputmode="url" placeholder="https://www.youtube.com/watch?v=…" value="${esc(url)}" maxlength="2048" required ${busy()||job?'disabled':''}><button class="button primary" type="submit" ${!config||busy()||job?'disabled':''}>${icon('plus')}Convert & add</button></div></form><div id="converterResult">${resultHTML()}</div><p class="small-note">Up to 20 minutes · MP3 at 192 kbps · Internet required for conversion. Saved songs play offline.</p><details class="converter-connection" ${!config?'open':''}><summary>${config?'Converter connection':'Connect a conversion service'}</summary><p class="small-note">YouTube conversion needs a separately hosted converter. Connect your Squidify converter service here. Only the video link is sent to that service; your existing music stays on this device.</p><form id="converterConnectionForm"><label for="converterEndpoint">Service address</label><input id="converterEndpoint" class="text-input" type="url" placeholder="https://converter.example.com" value="${esc(config?.endpoint||'')}" required ${busy()||job?'disabled':''}><label for="converterToken">Service access key</label><input id="converterToken" class="text-input" type="password" autocomplete="off" minlength="32" maxlength="256" value="${esc(config?.token||'')}" placeholder="Key from your converter service" required ${busy()||job?'disabled':''}><div class="converter-result-actions"><button class="button" type="submit" ${busy()||job?'disabled':''}>Test & save connection</button>${config?`<button class="button quiet" type="button" data-action="converter-disconnect" ${busy()||job?'disabled':''}>Disconnect</button>`:''}</div><p class="small-note">The address and access key are saved only in this browser. Disconnect removes them.</p></form></details><div class="converter-local"><span>Already have the audio file?</span><button class="button quiet" data-action="choose-files">${icon('folder')}Choose files</button></div></section>`;
  }
  function paint(){
    const host=$('#converterResult');if(host)host.innerHTML=resultHTML();
    const input=$('#converterVideo');if(input)input.disabled=busy()||!!job;
    const form=$('#converterForm');if(form)form.querySelector('button[type="submit"]').disabled=!config||busy()||!!job;
    for(const selector of ['#converterEndpoint','#converterToken']){const element=$(selector);if(element)element.disabled=busy()||!!job;}
    $('#converterConnectionForm')?.querySelectorAll('button').forEach(button=>{button.disabled=busy()||!!job;});
  }
  async function saveConnection(endpoint,token){
    if(busy()||job)return;
    const next=converterConfig(endpoint,token),client=clientFactory(next);running=true;controller=new AbortController();const tokenId=++generation;
    notify('connecting','Checking the converter…');
    try{await client.check(controller.signal);if(tokenId!==generation)return;await db.setSetting('converterConnection',next);config=next;notify('idle','Connection saved. Paste a video link to begin.');}
    catch(error){if(tokenId===generation)notify('error',error.message);}
    finally{if(tokenId===generation){running=false;controller=null;refresh();}}
  }
  async function processJob(client,signal,tokenId){
    while(job&&tokenId===generation){
      const result=await client.status(job.id,signal);if(tokenId!==generation)return;
      title=String(result.title||'').slice(0,200);
      if(result.status==='failed'||result.status==='cancelled'){const error=new Error(result.error||'Conversion was cancelled.');error.terminal=true;throw error;}
      if(result.status==='ready'){
        notify('downloading','Receiving your MP3…');progress=0;total=0;
        const downloaded=await client.download(job.id,title,signal,(received,size)=>{if(tokenId!==generation)return;progress=received;total=size;paint();});
        if(tokenId!==generation)return;file=downloaded;await importReady(client,tokenId);return;
      }
      if(!['validating','converting','downloading'].includes(result.status)){const error=new Error('This conversion is no longer available. Convert the video again.');error.terminal=true;throw error;}
      if(Date.now()-job.started>7*60*1000)throw new Error('The service is still processing. Resume later to check this conversion.');
      notify(result.status,result.status==='validating'?'Checking the video…':result.status==='downloading'?'Another window is receiving this MP3…':'Extracting and converting audio…');
      await wait(1500,signal);
    }
  }
  async function importReady(client,tokenId){
    if(!file||tokenId!==generation)return;
    if(context.state.busy){notify('ready','Your MP3 is ready. Finish the current file import, then choose Add to library.');return;}
    notify('importing','Adding the MP3 to your library…');
    const outcome=await context.importer.importEntries([{file,path:file.name}]);
    if(tokenId!==generation)return;
    if(outcome?.added||outcome?.skipped){
      const completed=job?.id;job=null;file=null;
      await persistJob().catch(()=>{});notify('saved',outcome.added?'Saved to your library. Ready for offline listening.':'This song is already in your library.');
      if(completed)void client.complete(completed).catch(()=>{});
    }else notify('ready',outcome?.quota?'Storage is full. Free some space and retry, or save the MP3 to your device.':'The MP3 could not be added. Retry or save the file to your device.');
  }
  async function run(start=false){
    if(busy())return;if(!config)return notify('error','Connect your converter service first.');
    if(navigator.onLine===false)return notify('error','Connect to the internet to convert or receive this song.');
    if(start&&job)return;
    let canonical;if(start)canonical=youtubeURL(url);
    running=true;controller=new AbortController();const signal=controller.signal,tokenId=++generation,client=clientFactory(config);
    try{
      if(start){notify('validating','Connecting to your converter…');await client.check(signal);if(tokenId!==generation)return;const id=await client.start(canonical,signal);if(tokenId!==generation){void client.cancel(id).catch(()=>{});return;}job={id,url:canonical,endpoint:config.endpoint,started:Date.now()};title='';file=null;await persistJob();}
      if(file)await importReady(client,tokenId);else if(job)await processJob(client,signal,tokenId);
    }catch(error){
      if(tokenId!==generation)return;
      if(error.terminal||error.status===404){job=null;file=null;await persistJob().catch(()=>{});}
      if(error.name!=='AbortError')notify('error',error.message);
    }finally{if(tokenId===generation){running=false;controller=null;paint();}}
  }
  async function cancel(){
    if(phase==='importing')return;
    const previous=job,client=config&&clientFactory(config);generation++;controller?.abort();controller=null;running=false;job=null;file=null;title='';progress=0;total=0;
    await persistJob();notify('idle','Conversion cancelled.');
    if(previous&&client)void client.cancel(previous.id).catch(()=>{});
  }
  async function disconnect(){if(busy()||job)return;await db.setSetting('converterConnection',null);config=null;message='Connection removed from this device.';phase='idle';refresh();}
  function download(){if(!file)return;const href=URL.createObjectURL(file),link=document.createElement('a');link.href=href;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(href),60000);}
  function bindEvents(){
    document.addEventListener('input',event=>{if(event.target.id==='converterVideo')url=event.target.value;});
    document.addEventListener('submit',event=>{
      if(event.target.id==='converterForm'){event.preventDefault();url=$('#converterVideo').value;void run(true).catch(error=>notify('error',error.message));}
      if(event.target.id==='converterConnectionForm'){event.preventDefault();void saveConnection($('#converterEndpoint').value,$('#converterToken').value).catch(error=>notify('error',error.message));}
    });
    window.addEventListener('pagehide',()=>{if(!running||phase==='importing')return;generation++;controller?.abort();controller=null;running=false;if(job){phase='paused';message='Resume this conversion to check it and add the MP3.';}});
  }
  return {panel,loadSettings,bindEvents,saveConnection,run,cancel,get job(){return job;},get status(){return {phase,message,running,hasFile:!!file};},setURL:value=>{url=value;},actions:{'converter-resume':()=>run(),'converter-cancel':cancel,'converter-disconnect':disconnect,'converter-download':download}};
}
