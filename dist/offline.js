export function createOffline(context) {
  const { state } = context;
  const render = (...args) => context.ui.render(...args);
  const renderOfflineBadge = (...args) => context.ui.renderOfflineBadge(...args);

  async function checkOffline(repair=false) {
    let ready=false;
    try{
      const registration=await navigator.serviceWorker?.getRegistration('./');
      if(registration?.active){
        ready=await new Promise(resolve=>{const channel=new MessageChannel();const timeout=setTimeout(()=>{channel.port1.close();resolve(false);},repair?15000:2000);channel.port1.onmessage=e=>{clearTimeout(timeout);resolve(!!e.data?.ready);channel.port1.close();};registration.active.postMessage({type:repair&&navigator.onLine?'REPAIR_OFFLINE':'CHECK_OFFLINE'},[channel.port2]);});
      }
    }catch{}
    state.shellReady=ready;renderOfflineBadge();if(state.view==='settings')render();return ready;
  }
  async function setupOffline() {
    if(!('serviceWorker' in navigator)){renderOfflineBadge();return;}
    try{
      const reg=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});
      navigator.serviceWorker.ready.then(()=>checkOffline());
      navigator.serviceWorker.addEventListener('controllerchange',()=>checkOffline());
      if(reg.active)checkOffline();
    }catch(e){console.error('Offline setup unavailable',e);renderOfflineBadge();}
  }


  return { checkOffline, setupOffline };
}
