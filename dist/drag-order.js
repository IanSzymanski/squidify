// Touch keeps native scrolling until a deliberate hold. A grip also supports
// immediate mouse/pen dragging. Only dropping commits an order change.
export function bindDragOrder({ root, selector, onDrop, onError = () => {}, getScroller, onStart = () => {} }) {
  const doc = root.ownerDocument || root, win = doc.defaultView || window;
  let gesture, timer, frame, suppressUntil = 0;
  const listeners = [];
  function listen(target, name, fn, options) { target.addEventListener(name, fn, options); listeners.push(() => target.removeEventListener(name, fn, options)); }
  function clear() {
    clearTimeout(timer); win.cancelAnimationFrame?.(frame);
    gesture?.row.classList.remove('order-dragging'); gesture?.target?.classList.remove('order-before','order-after'); gesture?.ghost?.remove(); gesture = null;
  }
  function finish(commit) {
    const g = gesture;
    if (g?.active) suppressUntil = Date.now() + 800;
    clear();
    if (commit && g?.active && g.target && g.target !== g.row) Promise.resolve(onDrop(g.row, g.target, g.after)).catch(onError);
  }
  function locate() {
    const g = gesture; if (!g?.active) return;
    const hit = doc.elementFromPoint(g.x, g.y)?.closest(selector);
    if (hit && root.contains(hit) && hit.parentElement === g.row.parentElement) {
      g.target?.classList.remove('order-before','order-after');
      g.target = hit; const rect = hit.getBoundingClientRect(); g.after = g.y > rect.top + rect.height / 2;
      if (hit !== g.row) hit.classList.add(g.after ? 'order-after' : 'order-before');
    }
  }
  function scroll() {
    const g = gesture; if (!g?.active) return;
    const element = getScroller?.(g.row) || root;
    const rect = element.getBoundingClientRect?.();
    if (rect) { const delta = g.y < rect.top+55 ? -9 : g.y > rect.bottom-55 ? 9 : 0; if (delta) {element.scrollTop += delta; locate();} }
    frame = win.requestAnimationFrame(scroll);
  }
  function activate() {
    const g = gesture; if (!g || !g.row.isConnected) return clear();
    g.active = true; suppressUntil = Date.now()+800; g.row.classList.add('order-dragging');
    const ghost = doc.createElement('div'); ghost.className = 'order-ghost';
    ghost.textContent = g.row.querySelector('.song-title, .mix-song-title')?.textContent || 'Move song';
    // Append inside a modal dialog when used by the editor so it stays in the top layer.
    (g.row.closest('dialog') || doc.body).append(ghost); g.ghost = ghost;
    ghost.style.left = `${Math.max(8, Math.min(g.x-60, win.innerWidth-230))}px`; ghost.style.top = `${g.y-25}px`;
    onStart(g.row); locate(); scroll();
  }
  function down(event, point, touch) {
    if (gesture) { finish(false); return; }
    const row = event.target.closest(selector); if (!row || !root.contains(row)) return;
    if (event.target.closest('input,select,textarea,[data-no-drag]')) return;
    const button = event.target.closest('button,a');
    if (button && !button.matches('[data-drag-grip],.track-cell,.number-button,[data-mix-select]')) return;
    gesture = {row,x:point.clientX,y:point.clientY,startX:point.clientX,startY:point.clientY,touch,id:touch ? point.identifier : event.pointerId,active:false};
    if (!touch && event.target.closest('[data-drag-grip]')) { event.preventDefault(); activate(); }
    else timer = setTimeout(activate, 450);
  }
  function move(event, point) {
    const g = gesture; if (!g || !point) return;
    g.x = point.clientX; g.y = point.clientY;
    if (!g.active) { if (Math.hypot(g.x-g.startX,g.y-g.startY)>10) clear(); return; }
    if (event.cancelable) event.preventDefault();
    g.ghost.style.top = `${g.y-25}px`; locate();
  }
  listen(root,'touchstart',e=>{if(e.touches.length!==1)return finish(false);down(e,e.touches[0],true);},{passive:true});
  listen(doc,'touchmove',e=>{if(gesture?.touch)move(e,[...e.touches].find(t=>t.identifier===gesture.id));},{passive:false});
  listen(doc,'touchend',e=>{if(gesture?.touch && [...e.changedTouches].some(t=>t.identifier===gesture.id))finish(true);});
  listen(doc,'touchcancel',()=>finish(false));
  listen(root,'pointerdown',e=>{if(e.pointerType==='touch'||e.button!==0)return;down(e,e,false);});
  listen(doc,'pointermove',e=>{if(gesture&&!gesture.touch&&gesture.id===e.pointerId)move(e,e);},{passive:false});
  listen(doc,'pointerup',e=>{if(gesture&&!gesture.touch&&gesture.id===e.pointerId)finish(true);});
  listen(doc,'pointercancel',e=>{if(gesture&&!gesture.touch&&gesture.id===e.pointerId)finish(false);});
  listen(root,'click',e=>{if(Date.now()<suppressUntil&&e.detail!==0){e.preventDefault();e.stopImmediatePropagation();suppressUntil=0;}},true);
  listen(root,'contextmenu',e=>{if(e.target.closest(selector)){e.preventDefault();}});
  listen(doc,'keydown',e=>{if(e.key==='Escape'&&gesture){e.preventDefault();finish(false);}});
  listen(win,'blur',()=>finish(false));
  listen(doc,'visibilitychange',()=>{if(doc.hidden)finish(false);});
  return () => {finish(false);listeners.forEach(remove=>remove());};
}
