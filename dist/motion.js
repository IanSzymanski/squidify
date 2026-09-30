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
  let animation,version=0,closing=false;
  const reduce=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  function stop(){version++;animation?.cancel();animation=null;}
  const currentTransform=()=>typeof getComputedStyle==='function'?getComputedStyle(dialog).transform:(dialog.style.transform||'translate3d(0,0,0)');
  function interrupt(){
    const transform=currentTransform();stop();closing=false;
    dialog.style.transform=transform;
    dialog.classList?.remove('player-closing');
    const values=transform.match(/matrix(?:3d)?\(([^)]+)\)/)?.[1].split(',').map(Number);
    return values ? values[values.length===16?13:5]||0 : 0;
  }
  function open(render){
    stop();closing=false;dialog.classList?.remove('player-closing');dialog.style.removeProperty('transform');dialog.style.setProperty('--player-dim','1');const token=version;render();if(!dialog.open)dialog.showModal();dialog.setAttribute?.('tabindex','-1');dialog.focus?.({preventScroll:true});
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
    if(!dialog.open||closing)return;
    const offset=currentTransform();stop();closing=true;const token=version;
    // Keep the same compositor property for dragging and settling. Persist the
    // offscreen endpoint before closing so cancelling cannot expose a frame at 0.
    dialog.style.transform=offset;
    const dim=dialog.style.getPropertyValue?.('--player-dim')||'1';
    dialog.style.setProperty('--player-exit-dim',dim);dialog.classList?.add('player-closing');
    dialog.style.removeProperty('translate');
    if(reduce()||!dialog.animate){dialog.close();return;}
    animation=dialog.animate([{transform:offset},{transform:'translate3d(0,110vh,0)'}],{duration:360,easing:'cubic-bezier(.2,.7,.3,1)',fill:'forwards'});
    animation.finished.then(()=>{if(token===version){dialog.style.transform='translate3d(0,110vh,0)';dialog.close();stop();closing=false;}}).catch(()=>{});
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('close',()=>{if(!dialog.open){stop();closing=false;}});
  return {open,close,interrupt};
}
