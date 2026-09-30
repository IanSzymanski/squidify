import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotion, createSearchScroll, createPlayerMotion, measureTitleMarquees } from '../dist/motion.js';
test('overflow titles travel far enough to expose the ending and stop scrolling when they fit',()=>{
 const styles={},text={scrollWidth:600},title={clientWidth:250,dataset:{},querySelector:()=>text,style:{setProperty:(k,v)=>styles[k]=v}};
 const root={querySelectorAll:()=>[title]};measureTitleMarquees(root);
 assert.equal(title.dataset.overflow,'true');assert.equal(styles['--title-travel'],'374px');
 assert.ok(parseFloat(styles['--title-duration'])>10);
 title.clientWidth=700;measureTitleMarquees(root);assert.equal(title.dataset.overflow,'false');
 title.clientWidth=0;measureTitleMarquees(root);assert.equal(title.dataset.overflow,'false','hidden titles wait until measurable');
});
function env(t,reduced=false){const old={matchMedia:globalThis.matchMedia,document:globalThis.document};globalThis.matchMedia=()=>({matches:reduced});globalThis.document={hidden:false};t.after(()=>Object.assign(globalThis,old));}
test('routes commit immediately and repeated navigation cancels old entrances',t=>{
 env(t);let cancelled=0,animated=0,page='';const el={animate(){animated++;return{cancel(){cancelled++;}};}};
 const motion=createMotion({querySelectorAll:()=>[el]});motion.change(()=>page='library');assert.equal(page,'library');motion.change(()=>page='liked');assert.equal(page,'liked');assert.equal(cancelled,1);assert.equal(animated,2);
});
test('reduced motion commits without entrance animations',t=>{env(t,true);let count=0;const motion=createMotion({querySelectorAll(){throw Error('No animation');}});motion.change(()=>count++);assert.equal(count,1);});
test('Safari negative rebound cannot hide search; deliberate downward travel can',()=>{
 const scroll=createSearchScroll();scroll.update(140);assert.equal(scroll.update(40),'show');scroll.update(0);scroll.update(-60);assert.equal(scroll.update(-20),null);assert.equal(scroll.update(0),null);assert.equal(scroll.update(20),null);assert.equal(scroll.update(40),null);assert.equal(scroll.update(55),null);assert.equal(scroll.update(75),'hide');
});
test('playlist search never opens from scrolling and route resets clear momentum',()=>{const scroll=createSearchScroll();scroll.update(100,true);assert.equal(scroll.update(20,true),null);scroll.reset();assert.equal(scroll.update(0),null);});
test('player stays open during dismissal and closes only when animation finishes',async t=>{
 env(t);let complete;let cancelled=0,animations=0;const dialog={open:true,style:{transform:'translate3d(0,84px,0)',setProperty(){},removeProperty(){}},addEventListener(){},close(){assert.equal(this.style.transform,'translate3d(0,110vh,0)');this.open=false;},animate(frames,options){animations++;assert.equal(frames[0].transform,'translate3d(0,84px,0)');assert.equal(frames[1].opacity,undefined,'sheet must remain opaque');assert.equal(options.duration,360);return{finished:new Promise(r=>complete=r),cancel(){cancelled++;}};}};
 const motion=createPlayerMotion(dialog);motion.close();motion.close();assert.equal(animations,1,'repeated dismissal must not restart animation');assert.equal(dialog.open,true);complete();await Promise.resolve();assert.equal(dialog.open,false);assert.equal(cancelled,1);
});
