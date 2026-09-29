// Modules rise into place; route and playback actions never wait on animation.
export function createMotion(main) {
  let entrances=[];
  const reduce=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  function reveal(root=main){
    entrances.forEach(a=>a.cancel());entrances=[];
    if(reduce()||document.hidden)return;
    const items=[...root.querySelectorAll('.view-header,.collection-header,.section-heading,.playlist-tile,.toolbar,.collection-actions,.track-table tbody tr,.settings-card,.empty-library')].slice(0,20);
    items.forEach((el,i)=>{
      if(!el.animate)return;
      entrances.push(el.animate([
        {opacity:0,transform:'translateY(26px) scale(.985)',filter:'blur(3px)'},
        {opacity:1,transform:'translateY(0) scale(1)',filter:'blur(0)'}
      ],{duration:650,delay:Math.min(i*38,304),easing:'cubic-bezier(.16,1,.3,1)',fill:'backwards'}));
    });
  }
  function change(commit){commit();reveal();}
  return {change,reveal};
}

// Clamp Safari's negative rubber-band scroll and require real downward travel
// beyond the top zone before hiding a search field that just appeared.
export function createSearchScroll(){
  let last=0,down=0;
  return {
    reset(){last=0;down=0;},
    update(raw,playlist=false){
      const y=Math.max(0,raw),delta=y-last;last=y;
      if(y<=48){down=0;return !playlist&&delta<0?'show':null;}
      if(delta>0)down+=delta;else down=0;
      if(down>=28){down=0;return 'hide';}
      return null;
    }
  };
}

export function createPlayerMotion(dialog){
  let animation,version=0;
  const reduce=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  function stop(){version++;animation?.cancel();animation=null;}
  function open(render){
    stop();dialog.classList?.remove('player-closing');const token=version;render();if(!dialog.open)dialog.showModal();
    dialog.style.removeProperty('translate');
    if(reduce()||!dialog.animate)return;
    animation=dialog.animate([
      {transform:'translateY(100%)',opacity:.6},
      {transform:'translateY(-7px)',opacity:1,offset:.8},
      {transform:'translateY(0)',opacity:1}
    ],{duration:580,easing:'cubic-bezier(.18,.8,.24,1)',fill:'both'});
    animation.finished.then(()=>{if(token===version){animation.cancel();animation=null;}}).catch(()=>{});
  }
  function close(){
    if(!dialog.open)return;
    const offset=dialog.style.translate||'0 0';stop();dialog.classList?.add('player-closing');const token=version;
    dialog.style.removeProperty('translate');
    if(reduce()||!dialog.animate){dialog.close();return;}
    // Continue from the finger's released position, never snap back to zero.
    animation=dialog.animate([{translate:offset,opacity:1},{translate:'0 105%',opacity:.5}],{duration:420,easing:'cubic-bezier(.4,0,.2,1)',fill:'both'});
    animation.finished.then(()=>{if(token===version){const finished=animation;dialog.close();finished?.cancel();animation=null;}}).catch(()=>{});
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('close',stop);
  return {open,close};
}
