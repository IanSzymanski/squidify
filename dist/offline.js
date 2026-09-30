import * as db from './storage.js';
import { SHELL_VERSION, RELEASE_LABEL } from './release.js';

export function createOffline(context) {
  const { state, $ } = context;
  let announcement, waitingNotified=false;
  const render = () => context.ui.render();
  const renderOfflineBadge = () => context.ui.renderOfflineBadge();
  function downloading(worker, isUpdate) {
    state.updateDownloading=!!worker;
    const status=$('#updateStatus');
    status.hidden=!worker;
    if(worker){
      $('#updateStatusText').textContent=isUpdate?'Downloading update…':'Preparing offline playback…';
      try{status.showPopover?.();}catch{}
    }else try{status.hidePopover?.();}catch{}
    renderOfflineBadge();
  }

  async function announceInstalled(version, updated=false) {
    // Never call an old controller, incomplete cache, or merely downloaded
    // waiting worker an installed update to this running release.
    if(version!==SHELL_VERSION)return;
    if(announcement)return announcement;
    announcement=(async()=>{
      const previous=await db.setting('installedShellVersion',null);
      if(previous===version)return;
      await db.setSetting('installedShellVersion',version);
      if(previous || updated)context.ui.toast(`Squidify updated to ${RELEASE_LABEL}.`);
    })().catch(()=>{announcement=null;});
    return announcement;
  }
  async function checkOffline(repair=false) {
    let result={ready:false};
    try{
      const registration=await navigator.serviceWorker?.getRegistration('./');
      if(registration?.active){
        result=await new Promise(resolve=>{
          const channel=new MessageChannel();
          const timeout=setTimeout(()=>{channel.port1.close();resolve({ready:false});},repair?15000:2000);
          channel.port1.onmessage=e=>{clearTimeout(timeout);channel.port1.close();resolve(e.data||{ready:false});};
          registration.active.postMessage({type:repair&&navigator.onLine?'REPAIR_OFFLINE':'CHECK_OFFLINE'},[channel.port2]);
        });
      }
    }catch{}
    state.shellReady=!!result.ready;
    renderOfflineBadge();if(state.view==='settings')render();
    if(result.ready)await announceInstalled(result.version,result.updated);
    return state.shellReady;
  }
  function notifyWaiting(registration) {
    if(registration.waiting)downloading(null);
    if(!registration.waiting || !registration.active || waitingNotified)return;
    waitingNotified=true;
    context.ui.toast('Update ready. Close all Squidify windows and reopen to install.',false,8000);
  }
  async function setupOffline() {
    if(!('serviceWorker' in navigator)){renderOfflineBadge();return;}
    try{
      const reg=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});
      let watched;
      const watchInstalling=()=>{
        const worker=reg.installing;if(!worker||worker===watched)return;watched=worker;
        const update=!!reg.active;
        const changed=()=>{
          if(worker!==watched)return;
          if(worker.state==='installing')downloading(worker,update);
          else if(['installed','activating','activated','redundant'].includes(worker.state)){
            downloading(null);
            if(worker.state==='installed')notifyWaiting(reg);
            if(worker.state==='redundant')context.ui.toast(update?'Update download interrupted. Squidify will try again when you reopen online.':'Offline setup interrupted. Reopen Squidify online to try again.',true);
          }
        };
        worker.addEventListener('statechange',changed);changed();
      };
      reg.addEventListener('updatefound',watchInstalling);watchInstalling();notifyWaiting(reg);
      navigator.serviceWorker.ready.then(()=>checkOffline());
      navigator.serviceWorker.addEventListener('controllerchange',()=>checkOffline());
      if(reg.active)checkOffline();
    }catch(e){console.error('Offline setup unavailable',e);downloading(null);}
  }
  return { checkOffline, setupOffline, announceInstalled };
}
