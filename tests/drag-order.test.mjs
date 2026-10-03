import test from 'node:test';
import assert from 'node:assert/strict';
import { bindDragOrder } from '../dist/drag-order.js';

function fixture(t){
  t.mock.timers.enable({apis:['setTimeout']});const listeners=new Map(),drops=[];let hit;
  const target=()=>({addEventListener(type,fn){const key=[this,type];listeners.set(key,fn);},removeEventListener(type,fn){for(const [key,value]of listeners)if(key[0]===this&&key[1]===type&&value===fn)listeners.delete(key);}});
  const win=Object.assign(target(),{innerWidth:390,requestAnimationFrame:()=>1,cancelAnimationFrame(){}});
  const doc=Object.assign(target(),{defaultView:win,createElement:()=>({style:{},remove(){}}),elementFromPoint:()=>hit,body:{append(){}}});
  const root=Object.assign(target(),{ownerDocument:doc,contains:()=>true,scrollTop:0,getBoundingClientRect:()=>({top:0,bottom:500})});
  function row(id){const classes=new Set();return {id,isConnected:true,parentElement:root,style:{},classList:{add:(...xs)=>xs.forEach(x=>classes.add(x)),remove:(...xs)=>xs.forEach(x=>classes.delete(x))},classes,closest(selector){return selector==='[data-row]'?this:null;},querySelector:()=>({textContent:`Song ${id}`}),getBoundingClientRect:()=>({top:100,height:70})};}
  const a=row('a'),b=row('b');
  const dispose=bindDragOrder({root,selector:'[data-row]',onDrop:(from,to,after)=>drops.push([from.id,to.id,after])});
  function emit(surface,type,extra={}){const event={target:a,button:0,pointerId:1,pointerType:'mouse',clientX:100,clientY:125,cancelable:true,detail:1,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};for(const [key,fn]of listeners)if(key[0]===surface&&key[1]===type)fn(event);return event;}
  return {a,b,root,doc,win,drops,emit,dispose,setHit(value){hit=value;},hold(){t.mock.timers.tick(451);}};
}
test('holding then dragging places a song only on drop and consumes its playback click',t=>{
  const f=fixture(t);f.emit(f.root,'pointerdown');f.hold();assert.ok(f.a.classes.has('order-dragging'));f.setHit(f.b);f.emit(f.doc,'pointermove',{clientY:160});assert.deepEqual(f.drops,[]);
  f.emit(f.doc,'pointerup');assert.deepEqual(f.drops,[['a','b',true]]);assert.equal(f.emit(f.root,'click').stopped,true);assert.ok(!f.a.classes.has('order-dragging'));f.dispose();
});
test('touch scroll remains native before a hold; deliberate touch dragging prevents scroll and reorders',t=>{
  const f=fixture(t),point={clientX:100,clientY:125,identifier:7};f.emit(f.root,'touchstart',{touches:[point]});
  assert.equal(f.emit(f.doc,'touchmove',{touches:[{...point,clientY:145}]}).prevented,undefined);f.hold();assert.ok(!f.a.classes.has('order-dragging'));
  f.emit(f.root,'touchstart',{touches:[point]});f.hold();f.setHit(f.b);
  assert.equal(f.emit(f.doc,'touchmove',{touches:[{...point,clientY:115}]}).prevented,true);
  // Browser pointer cancellation during touch does not cancel the touch gesture.
  f.emit(f.doc,'pointercancel',{pointerType:'touch'});f.emit(f.doc,'touchend',{changedTouches:[point]});assert.deepEqual(f.drops,[['a','b',false]]);f.dispose();
});
test('cancelled drags and a second finger never mutate playlist order',t=>{
  const f=fixture(t);f.emit(f.root,'pointerdown');f.hold();f.setHit(f.b);f.emit(f.doc,'pointermove',{clientY:160});f.emit(f.doc,'pointercancel');assert.deepEqual(f.drops,[]);
  const point={clientX:100,clientY:125,identifier:7};f.emit(f.root,'touchstart',{touches:[point]});f.hold();f.emit(f.root,'touchstart',{touches:[point,{...point,identifier:8}]});f.emit(f.doc,'touchend',{changedTouches:[point]});assert.deepEqual(f.drops,[]);f.dispose();
});
