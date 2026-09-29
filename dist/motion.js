// Decorative motion never delays startup or intercepts playback/file controls.
export function createMotion(main, overlay) {
  let first = true, sequence = 0, timer, wash;
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function reveal() {
    if (reduce() || !main.animate) return;
    const items=[...main.querySelectorAll('.view-header,.collection-header,.section-heading,.playlist-tile,.toolbar,.collection-actions,.track-table tbody tr,.settings-card,.empty-library')].slice(0,16);
    items.forEach((el,i)=>el.animate([{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'translateY(0)'}],{duration:360,delay:Math.min(i*35,280),easing:'cubic-bezier(.2,.7,.2,1)',fill:'backwards'}));
  }
  function change(commit, allowWash=true) {
    const version=++sequence;
    clearTimeout(timer);wash?.cancel();wash=null;
    if(overlay)overlay.hidden=true;
    if(first || !allowWash || reduce() || !overlay?.querySelector?.('svg')?.animate || document.hidden){
      first=false;commit();reveal();return;
    }
    overlay.hidden=false;
    const svg=overlay.querySelector('svg');
    wash=svg.animate([
      {transform:'translateY(55%)',offset:0},
      {transform:'translateY(-14%)',offset:.48},
      {transform:'translateY(-110%)',offset:1}
    ],{duration:680,easing:'cubic-bezier(.65,0,.35,1)',fill:'forwards'});
    timer=setTimeout(()=>{if(version===sequence){commit();reveal();}},325);
    wash.finished.then(()=>{if(version===sequence)overlay.hidden=true;}).catch(()=>{});
  }
  return { change };
}
