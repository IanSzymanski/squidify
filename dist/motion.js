// Swaps commit under full coverage; entrance staggers start after the wash exits.
// Playback is never delayed by decorative motion. Rapid repeats skip the wash.
export function createMotion(main, overlay) {
  let first=true,sequence=0,timer,finishTimer,wash,lastWash=0;
  const reduce=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  function reveal(){
    if(reduce()||!main.animate)return;
    [...main.querySelectorAll('.view-header,.collection-header,.section-heading,.playlist-tile,.toolbar,.collection-actions,.track-table tbody tr,.settings-card,.empty-library')].slice(0,16).forEach((el,i)=>el.animate([{opacity:0,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],{duration:280,delay:Math.min(i*25,200),easing:'cubic-bezier(.2,.7,.2,1)',fill:'backwards'}));
  }
  function hide(){if(overlay){overlay.hidden=true;try{overlay.hidePopover?.();}catch{}}}
  function change(commit,allowWash=true){
    const version=++sequence;clearTimeout(timer);clearTimeout(finishTimer);wash?.cancel();wash=null;hide();
    const now=Date.now();
    if(first||!allowWash||reduce()||!overlay?.querySelector?.('svg')?.animate||document.hidden||now-lastWash<750){first=false;commit();reveal();return;}
    lastWash=now;overlay.hidden=false;try{overlay.showPopover?.();}catch{}
    wash=overlay.querySelector('svg').animate([{transform:'translateY(48%)',offset:0},{transform:'translateY(-12%)',offset:.46},{transform:'translateY(-12%)',offset:.54},{transform:'translateY(-105%)',offset:1}],{duration:540,easing:'cubic-bezier(.45,0,.25,1)',fill:'forwards'});
    timer=setTimeout(()=>{if(version===sequence)commit();},250);
    finishTimer=setTimeout(()=>{if(version===sequence){hide();reveal();}},540);
  }
  function pulse(){change(()=>{},true);}
  return {change,pulse};
}
