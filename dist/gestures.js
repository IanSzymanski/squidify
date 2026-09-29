// Pointer gestures keep vertical list scrolling native. Only a completed gesture
// consumes its following click; range inputs retain their normal drag behavior.
export function bindGestures({ document, window, run, openMenu, nowDialog }) {
  let active = null, holdTimer, suppressUntil = 0;
  const clearHold = () => { clearTimeout(holdTimer); holdTimer = undefined; };
  const reset = () => {
    clearHold();
    if (active) {
      active.surface.style.removeProperty('translate');
      active.surface.classList.remove('gesture-active', 'queue-ready');
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
      top: !!event.target.closest('.now-top'), axis: null, held: false };
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
    }
    if (g.axis === 'y' && (g.kind === 'item' || (g.kind === 'full' && !g.top))) { reset(); return; }
    // A playlist's horizontal movement is not a playback or queue gesture.
    if (g.axis === 'x' && g.item && !g.item.dataset.trackRow) { reset(); return; }
    if (event.cancelable) event.preventDefault();
    g.surface.setPointerCapture?.(event.pointerId);
    g.surface.classList.add('gesture-active');
    const amount = g.axis === 'x' ? g.dx : g.dy;
    const offset = Math.max(-70, Math.min(70, amount * 0.55));
    g.surface.style.setProperty('translate', g.axis === 'x' ? `${offset}px 0` : `0 ${offset}px`);
    g.surface.classList.toggle('queue-ready', !!g.item && g.dx >= 64);
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
      if (g.kind === 'full' && g.top && g.dy > 0) action = ['close-now'];
    }
    reset();
    if (action) run(...action);
  });
  document.addEventListener('pointercancel', reset);
  document.addEventListener('scroll', clearHold, true);
  window.addEventListener('blur', reset);
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
