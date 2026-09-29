import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotion } from '../dist/motion.js';
function setup(t,reduced=false) {
  t.mock.timers.enable({apis:['setTimeout']});
  const media=globalThis.matchMedia,doc=globalThis.document;
  globalThis.matchMedia=()=>({matches:reduced});globalThis.document={hidden:false};
  t.after(()=>{if(media)globalThis.matchMedia=media;else delete globalThis.matchMedia;if(doc)globalThis.document=doc;else delete globalThis.document;});
  let waves=0,cancelled=0;
  const svg={animate:()=>{waves++;return{cancel(){cancelled++;},finished:new Promise(()=>{})};}};
  const overlay={hidden:true,querySelector:()=>svg};
  const main={querySelectorAll:()=>[],animate(){}};
  return {motion:createMotion(main,overlay),overlay,get waves(){return waves;},get cancelled(){return cancelled;}};
}
test('startup renders immediately, subsequent navigation swaps under the wave',t=>{
  const f=setup(t);let page='';f.motion.change(()=>page='library');assert.equal(page,'library');assert.equal(f.waves,0);
  f.motion.change(()=>page='liked');assert.equal(f.overlay.hidden,false);assert.equal(page,'library');
  t.mock.timers.tick(325);assert.equal(page,'liked');assert.equal(f.waves,1);
});
test('rapid navigation cancels the stale page swap',t=>{
  const f=setup(t);let page='';f.motion.change(()=>page='library');
  f.motion.change(()=>page='liked');t.mock.timers.tick(100);f.motion.change(()=>page='settings');t.mock.timers.tick(325);
  assert.equal(page,'settings');assert.equal(f.cancelled,1);
});
test('reduced motion and picker-safe navigation render without a wash',t=>{
  const f=setup(t,true);let count=0;f.motion.change(()=>count++);f.motion.change(()=>count++);assert.equal(count,2);assert.equal(f.waves,0);
});
