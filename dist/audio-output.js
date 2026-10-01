// Keep one stable interface for the UI, waveform, controls and persistence.
// A second native element prepares a restart; only the active element's events
// reach consumers. No Web Audio routing or silent keep-alive playback is used.
export function createAudioOutput(primary,createStandby) {
  let active=primary,standby=null,preparedSource=null,standbyObserver=null;
  function notifyStandby(){standbyObserver?.();}
  function observeInactive(element){
    for(const type of ['loadedmetadata','canplay','pause','emptied','error'])
      element.addEventListener(type,()=>{if(element!==active)notifyStandby();});
  }
  observeInactive(primary);
  const listeners=[];
  function attach(entry,element){
    const wrapped=event=>{
      if(element!==active)return;
      if(entry.once)remove(entry.type,entry.listener,entry.capture);
      if(typeof entry.listener==='function')entry.listener.call(output,event);
      else entry.listener.handleEvent(event);
    };
    entry.wrappers.set(element,wrapped);element.addEventListener(entry.type,wrapped,entry.capture);
  }
  function remove(type,listener,options){
    const capture=typeof options==='boolean'?options:!!options?.capture;
    const index=listeners.findIndex(e=>e.type===type&&e.listener===listener&&e.capture===capture);
    if(index<0)return;
    const [entry]=listeners.splice(index,1);
    for(const [element,wrapped]of entry.wrappers)element.removeEventListener(type,wrapped,capture);
  }
  const controls={
    setStandbyObserver(observer){standbyObserver=observer;},
    addEventListener(type,listener,options){
      if(!listener)return;
      const capture=typeof options==='boolean'?options:!!options?.capture;
      if(listeners.some(e=>e.type===type&&e.listener===listener&&e.capture===capture))return;
      const entry={type,listener,capture,once:!!options?.once,wrappers:new Map()};listeners.push(entry);
      attach(entry,active);if(standby)attach(entry,standby);
    },
    removeEventListener:remove,
    prepareRestart(source){
      if(!source||source===active.src){preparedSource=null;return;}
      if(!standby){standby=createStandby();standby.muted=true;observeInactive(standby);standby.preload='auto';standby.playsInline=true;for(const entry of listeners)attach(entry,standby);}
      // Keep a paused preload out of audible playback candidacy. Its saved
      // user preferences are restored only after it becomes active.
      standby.muted=true;preparedSource=source;
      // Request samples while another song is active, before its native end.
      if(standby.src!==source||standby.error)standby.src=source;
      else if(standby.readyState>=1&&standby.currentTime>0)standby.currentTime=0;
    },
    activateRestart(source){
      if(!standby||source!==preparedSource||standby.currentSrc!==source||standby.readyState<3||standby.error)return false;
      const previous=active,preferences={volume:active.volume,muted:active.muted,rate:active.playbackRate};
      active=standby;standby=previous;preparedSource=null;
      previous.muted=true;
      active.volume=preferences.volume;active.muted=preferences.muted;active.playbackRate=preferences.rate;
      if(!previous.paused)previous.pause(); // Pending inactive events are ignored.
      return true;
    },
    clearRestart(){
      preparedSource=null;if(!standby)return;
      standby.pause();standby.removeAttribute('src');standby.load();
    }
  };
  const output=new Proxy(controls,{
    get(target,key){
      if(key==='standbyState')return standby?{paused:standby.paused,muted:standby.muted,ready:standby.readyState}:null;
      if(key==='restartReadyState')return preparedSource?standby?.readyState??0:0;
      if(key in target)return target[key];
      const value=Reflect.get(active,key,active);return typeof value==='function'?value.bind(active):value;
    },
    set(target,key,value){return Reflect.set(active,key,value,active);}
  });
  return output;
}
