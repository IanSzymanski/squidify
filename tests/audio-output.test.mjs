import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioOutput } from '../dist/audio-output.js';

class Player extends EventTarget {
  constructor(){super();this.src='';this.currentSrc='';this.readyState=0;this.paused=true;this.currentTime=0;this.volume=.7;this.muted=false;this.playbackRate=1.25;}
  pause(){this.paused=true;this.dispatchEvent(new Event('pause'));}
  play(){this.paused=false;this.dispatchEvent(new Event('playing'));return Promise.resolve();}
  removeAttribute(name){if(name==='src')this.src='';}
  load(){this.readyState=0;this.currentSrc=this.src;this.dispatchEvent(new Event('emptied'));}
}
test('native restart activation requires playable samples and preserves output preferences',()=>{
  const first=new Player(),second=new Player(),audio=createAudioOutput(first,()=>second);
  audio.prepareRestart('blob:first');second.currentSrc=second.src;second.readyState=1;
  assert.equal(audio.activateRestart('blob:first'),false);assert.equal(audio.src,first.src);
  second.readyState=4;assert.equal(audio.activateRestart('blob:wrong'),false);
  second.error={code:3};assert.equal(audio.activateRestart('blob:first'),false);second.error=null;
  first.muted=true;assert.equal(audio.activateRestart('blob:first'),true);
  assert.equal(audio.src,'blob:first');assert.equal(audio.volume,.7);assert.equal(audio.muted,true);assert.equal(audio.playbackRate,1.25);assert.equal(audio.paused,true);
});
test('inactive events do not consume once listeners or leak through after handoff',async()=>{
  const first=new Player(),second=new Player(),audio=createAudioOutput(first,()=>second);let playing=0,errors=0;
  const onError=()=>errors++;audio.addEventListener('playing',()=>playing++,{once:true});audio.addEventListener('error',onError);
  audio.prepareRestart('blob:first');second.dispatchEvent(new Event('playing'));assert.equal(playing,0);
  second.currentSrc=second.src;second.readyState=4;audio.activateRestart('blob:first');
  first.dispatchEvent(new Event('error'));assert.equal(errors,0);
  await audio.play();await audio.play();assert.equal(playing,1);
  second.dispatchEvent(new Event('error'));assert.equal(errors,1);audio.removeEventListener('error',onError);second.dispatchEvent(new Event('error'));assert.equal(errors,1);
});
test('clearing a prepared restart releases only the inactive element',async()=>{
  const first=new Player(),second=new Player(),audio=createAudioOutput(first,()=>second);let emptied=0;
  await audio.play();audio.addEventListener('emptied',()=>emptied++);audio.prepareRestart('blob:first');audio.clearRestart();
  assert.equal(first.paused,false);assert.equal(second.src,'');assert.equal(emptied,0);assert.equal(audio.restartReadyState,0);
});
