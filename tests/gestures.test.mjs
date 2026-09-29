import test from 'node:test';
import assert from 'node:assert/strict';
import { bindGestures } from '../dist/gestures.js';

function fixture(t) {
  t.mock.timers.enable({apis:['setTimeout']});
  const events={},calls=[],menus=[];
  const add=(type,fn)=>{(events[type]||=[]).push(fn);};
  const document={addEventListener:add,hidden:false};
  const window={addEventListener:add};
  function target(kind){
    const classes=new Set(),styles=new Map();
    const node={dataset:kind==='song'?{trackRow:'song-1'}:kind==='playlist'?{playlistId:'list-1'}:{},
      style:{setProperty:(k,v)=>styles.set(k,v),removeProperty:k=>styles.delete(k)},
      classList:{add:x=>classes.add(x),remove:(...xs)=>xs.forEach(x=>classes.delete(x)),toggle:(x,v)=>v?classes.add(x):classes.delete(x)},
      setPointerCapture(){},classes,styles,
      closest(selector){
        if(selector.includes('input,') && kind==='slider')return node;
        if(selector==='[data-track-row], [data-playlist-id]' && ['song','playlist'].includes(kind))return node;
        if(selector==='#player'&&kind==='player')return node;
        if(selector==='#nowDialog'&&['full','top'].includes(kind))return node;
        if(selector==='.now-top'&&kind==='top')return node;
        return null;
      }};
    return node;
  }
  bindGestures({document,window,nowDialog:{open:false},run:(...args)=>calls.push(args),openMenu:item=>menus.push(item)});
  function emit(type,node,x=100,y=100,extra={}){
    const event={target:node,pointerId:1,button:0,isPrimary:true,clientX:x,clientY:y,cancelable:true,detail:1,
      preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};
    for(const fn of events[type]||[]){fn(event);if(event.stopped)break;}return event;
  }
  const swipe=(node,dx,dy)=>{emit('pointerdown',node);emit('pointermove',node,100+dx,100+dy);emit('pointerup',node,100+dx,100+dy);};
  return {target,emit,swipe,calls,menus};
}
test('mini-player opens upwards; whole full player closes downwards',t=>{
  const f=fixture(t);f.swipe(f.target('player'),0,-90);f.swipe(f.target('top'),0,90);
  assert.deepEqual(f.calls,[['now-playing'],['close-now']]);
  f.swipe(f.target('full'),0,90);assert.equal(f.calls.length,3,'downward swipe below header dismisses');
});
test('horizontal player swipes skip next/previous and consume the synthetic click',t=>{
  const f=fixture(t),player=f.target('player');
  f.swipe(player,-100,10);f.swipe(f.target('full'),100,0);
  assert.deepEqual(f.calls,[['next'],['gesture-previous']]);
  const click=f.emit('click',player);assert.equal(click.prevented,true);assert.equal(click.stopped,true);
  assert.equal(f.emit('click',player).prevented,undefined,'following ordinary click works');
});
test('right-swipe queues one song only after crossing threshold; left-swipe does not queue',t=>{
  const f=fixture(t),song=f.target('song');
  f.emit('pointerdown',song);f.emit('pointermove',song,180,103);
  assert.equal(song.classes.has('queue-ready'),true);assert.equal(f.calls.length,0);
  f.emit('pointerup',song,180,103);assert.deepEqual(f.calls,[['add-queue','song-1']]);assert.equal(song.styles.size,0);
  f.swipe(song,-90,0);f.swipe(song,40,0);assert.equal(f.calls.length,1);
});
test('hold opens song/playlist options without playing or following the link',t=>{
  const f=fixture(t);
  for(const kind of ['song','playlist']){
    const item=f.target(kind);f.emit('pointerdown',item);t.mock.timers.tick(501);
    assert.equal(f.menus.at(-1),item);f.emit('pointerup',item);
    assert.equal(f.emit('click',item).stopped,true);
  }
  assert.equal(f.calls.length,0);
});
test('scrolling, cancellation and multi-touch cancel pending holds and actions',t=>{
  const f=fixture(t),song=f.target('song');
  f.emit('pointerdown',song);f.emit('pointermove',song,103,130);t.mock.timers.tick(600);f.emit('pointerup',song);
  f.emit('pointerdown',song);f.emit('pointercancel',song);t.mock.timers.tick(600);
  f.emit('pointerdown',song);f.emit('pointerdown',song,100,100,{isPrimary:false,pointerId:2});t.mock.timers.tick(600);f.emit('pointerup',song);
  assert.equal(f.menus.length,0);assert.equal(f.calls.length,0);
});
test('sliders, short taps and playlist swipes keep normal behavior',t=>{
  const f=fixture(t);f.swipe(f.target('slider'),100,0);f.swipe(f.target('playlist'),100,0);
  const song=f.target('song');f.emit('pointerdown',song);f.emit('pointerup',song);t.mock.timers.tick(600);
  assert.equal(f.emit('click',song).prevented,undefined);assert.equal(f.calls.length,0);assert.equal(f.menus.length,0);
});
test('right-click and keyboard context-menu key open the same options',t=>{
  const f=fixture(t),song=f.target('song');
  assert.equal(f.emit('contextmenu',song).prevented,true);
  assert.equal(f.emit('keydown',song,0,0,{key:'F10',shiftKey:true}).prevented,true);
  assert.equal(f.menus.length,2);
  assert.equal(f.emit('click',song,0,0,{detail:0}).prevented,undefined,'keyboard clicks stay accessible');
});
