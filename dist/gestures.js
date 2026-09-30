import { icon } from './icons.js';
// Pointer gestures keep vertical list scrolling native. Only a completed gesture
// consumes its following click; range inputs retain their normal drag behavior.
export function bindGestures({ document, window, run, openMenu, nowDialog, beginPlayerDrag }) {
  let active = null, holdTimer, suppressUntil = 0;
  const clearHold = () => { clearTimeout(holdTimer); holdTimer = undefined; };
  const reset = (preserve = false) => {
    clearHold();
    if (active) {
      const offset=active.surface.style.transform;
      if(!preserve){active.surface.style.removeProperty('transform');if(active.kind==='full')active.surface.style.setProperty('--player-dim','1');if(offset&&active.surface.animate&&!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)active.surface.animate([{transform:offset},{transform:'translate3d(0,0,0)'}],{duration:380,easing:'cubic-bezier(.22,1.2,.36,1)'});}
      active.surface.classList.remove('gesture-active', 'queue-ready');
      if(active.underlay){const layer=active.underlay;setTimeout(()=>layer.remove(),380);}
    }
    active = null;
  };
  const consume = () => { suppressUntil = Date.now() + 800; };
  const listTarget = target => target.closest('[data-track-row], [data-playlist-id]');
  document.addEventListener('pointerdown', event => {
    if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) { reset(); return; }
    reset();
    if (event.target.closest('input, textarea, select, [contenteditable="true"], #modal')) return;
    const item = listTarget(event.target);
    const full = event.target.closest('#nowDialog');
    const player = event.target.closest('#player');
    const surface = item || full || player;
    if (!surface) return;
    const button = event.target.closest('[data-action]');
    if (item && button && !['play-track', 'queue-jump'].includes(button.dataset.action)) return;
    active = { surface, item, kind: item ? 'item' : full ? 'full' : 'player',
      pointer: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0,
      top: !!event.target.closest('.now-top'), axis: null, held: false, startY:0 };
    if (item) holdTimer = setTimeout(() => {
      if (!active || active.axis) return;
      active.held = true; consume(); openMenu(item);
    }, 500);
  });
  document.addEventListener('pointermove', event => {
    const g = active;
    if (!g || g.pointer !== event.pointerId || g.held) return;
    g.dx = event.clientX - g.x; g.dy = event.clientY - g.y;
    if (Math.hypot(g.dx, g.dy) < 12) return;
    clearHold();
    if (!g.axis) {
      if (Math.abs(g.dx) > Math.abs(g.dy) * 1.25) g.axis = 'x';
      else if (Math.abs(g.dy) > Math.abs(g.dx) * 1.25) g.axis = 'y';
      else return;
      if(g.kind==='full')g.startY=beginPlayerDrag?.()||0;
    }
    if (g.axis === 'y' && g.kind === 'item') { reset(); return; }
    // A playlist's horizontal movement is not a playback or queue gesture.
    if (g.axis === 'x' && g.item && !g.item.dataset.trackRow) { reset(); return; }
    if (event.cancelable) event.preventDefault();
    g.surface.setPointerCapture?.(event.pointerId);
    g.surface.classList.add('gesture-active');
    const amount = g.axis === 'x' ? g.dx : g.dy;
    const offset = g.kind==='full'&&g.axis==='y'&&amount>0 ? amount*.85 : g.item?.dataset.trackRow&&g.axis==='x'&&amount>0 ? Math.min(150,amount*.95) : Math.max(-70, Math.min(70, amount * 0.55));
    const y=g.axis==='y'?offset+g.startY:0;
    g.surface.style.setProperty('transform', g.axis === 'x' ? `translate3d(${offset}px,0,0)` : `translate3d(0,${y}px,0)`);
    if(g.kind==='full'&&g.axis==='y')g.surface.style.setProperty('--player-dim',String(Math.max(0,1-Math.max(0,y)/(window.innerHeight||800))));
    g.surface.classList.toggle('queue-ready', !!g.item && g.dx >= 64);
    if(g.item?.dataset.trackRow && g.axis==='x' && g.dx>0){
      if(!g.underlay && document.createElement){const host=g.item.closest('.track-list');if(host){const r=g.item.getBoundingClientRect(),h=host.getBoundingClientRect();const layer=document.createElement('div');layer.className='queue-underlay';layer.setAttribute('aria-hidden','true');layer.innerHTML=icon('queue')+'<span>Add to queue</span>';layer.style.top=`${r.top-h.top}px`;layer.style.height=`${r.height}px`;host.prepend(layer);g.underlay=layer;}}
      if(g.underlay){g.underlay.classList.toggle('ready',g.dx>=64);g.underlay.querySelector('span').textContent=g.dx>=64?'Release to queue':'Add to queue';}
    }
  }, { passive: false });
  document.addEventListener('pointerup', event => {
    const g = active;
    if (!g || g.pointer !== event.pointerId) return;
    if (g.held || g.axis) consume();
    let action;
    if (!g.held && g.axis === 'x' && Math.abs(g.dx) >= 64) {
      if (g.item) { if (g.dx > 0) action = ['add-queue', g.item.dataset.trackRow]; }
      else action = [g.dx < 0 ? 'next' : 'gesture-previous'];
    } else if (!g.held && g.axis === 'y' && Math.abs(g.dy) >= 64) {
      if (g.kind === 'player' && g.dy < 0) action = ['now-playing'];
      if (g.kind === 'full' && g.dy > 0) action = ['close-now'];
    }
    reset(action?.[0]==='close-now');
    if (action) run(...action);
  });
  document.addEventListener('pointercancel', () => reset());
  document.addEventListener('scroll', clearHold, true);
  window.addEventListener('blur', () => reset());
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  document.addEventListener('click', event => {
    if (Date.now() >= suppressUntil || event.detail === 0) return;
    event.preventDefault(); event.stopImmediatePropagation(); suppressUntil = 0;
  }, true);
  document.addEventListener('contextmenu', event => {
    const item = listTarget(event.target);
    if (!item || nowDialog.open) return;
    event.preventDefault(); reset(); consume(); openMenu(item);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    const item = listTarget(event.target);
    if (item) { event.preventDefault(); openMenu(item); }
  });
}
