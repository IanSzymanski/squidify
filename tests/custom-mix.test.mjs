import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileMix, buildTimeline, pairKey, envelopeAt, moveOrder, timeLabel, parseTime } from '../dist/mix-model.js';
import { createMixAudio } from '../dist/mix-audio.js';

const tracks=new Map(['a','b','c','d'].map(id=>[id,{id,duration:200}]));
function example(){
  const mix=reconcileMix(null,['a','b','c'],tracks);
  Object.assign(mix.clips.a,{in:0,out:83});Object.assign(mix.clips.b,{in:132,out:170});Object.assign(mix.clips.c,{in:10,out:30});
  mix.transitions[pairKey('a','b')]={duration:2,curve:'equal-power'};
  return {mix,plan:buildTimeline(mix,['a','b','c'])};
}
test('the authored example uses original-file times and puts the next song at overlap start',()=>{
  const {plan}=example();
  assert.deepEqual(plan.entries.map(e=>[e.trackId,e.start,e.end]),[['a',0,83],['b',81,119],['c',119,139]]);
  assert.equal(envelopeAt(plan.entries[0],81),1);assert.equal(envelopeAt(plan.entries[1],81),0);
  assert.ok(Math.abs(envelopeAt(plan.entries[0],82)**2+envelopeAt(plan.entries[1],82)**2-1)<1e-8);
  assert.equal(envelopeAt(plan.entries[0],83),0);assert.equal(envelopeAt(plan.entries[2],119),1);
});
test('rate and trims bound overlaps so at most two songs are audible',()=>{
  const {mix}=example();mix.clips.b.rate=2;mix.clips.b.out=134;mix.transitions[pairKey('b','c')]={duration:30,curve:'linear'};
  const plan=buildTimeline(mix,['a','b','c']);assert.equal(plan.entries[1].length,1);assert.equal(plan.entries[1].incoming,.5);assert.equal(plan.entries[1].outgoing,.5);
  for(let time=80;time<86;time+=.01)assert.ok(plan.entries.filter(e=>envelopeAt(e,time)>0).length<=2);
});
test('playlist order changes preserve clip edits and only reuse the matching neighbor pair',()=>{
  const {mix}=example(),before=structuredClone(mix),order=moveOrder(['a','b','c'],'c','a',true);
  assert.deepEqual(order,['a','c','b']);const reordered=reconcileMix(mix,order,tracks),plan=buildTimeline(reordered,order);
  assert.equal(reordered.clips.b.in,132);assert.equal(reordered.clips.b.id,mix.clips.b.id);assert.ok(plan.entries.every(e=>!e.incoming));
  assert.equal(buildTimeline(reordered,['a','b','c']).entries[1].incoming,2);assert.deepEqual(mix,before,'planning never mutates a saved project');
});
test('missing tracks and invalid edits are contained without modifying source metadata',()=>{
  const saved={version:1,clips:{a:{in:-8,out:999,rate:20,effects:{gain:900,pan:-10,reverb:Infinity}}},transitions:{[pairKey('a','b')]:{duration:999,curve:'bad'}}};
  const mix=reconcileMix(saved,['a','missing','b'],tracks);
  assert.equal(mix.clips.a.in,0);assert.equal(mix.clips.a.out,200);assert.equal(mix.clips.a.rate,2);assert.equal(mix.clips.a.effects.gain,6);assert.equal(mix.clips.a.effects.pan,-1);assert.equal(tracks.get('a').duration,200);
  assert.equal(buildTimeline(mix,['a','missing','b']).entries.length,2);assert.throws(()=>reconcileMix({version:2},['a'],tracks),/newer/);
  assert.equal(parseTime('2:12.25'),132.25);assert.ok(Number.isNaN(parseTime('oops')));assert.equal(timeLabel(59.999), '0:59');assert.equal(timeLabel(60,true),'1:00.00');
});

function fixture(){
  class Param{constructor(value=1){this.value=value;this.events=[];}cancelScheduledValues(t){this.events.push(['cancel',t]);}setValueAtTime(v,t){this.events.push(['set',v,t]);this.value=v;}setTargetAtTime(v,t){this.events.push(['target',v,t]);this.value=v;}setValueCurveAtTime(v,t,d){this.events.push(['curve',[...v],t,d]);}}
  const sources=[],nodes=[],decodes=[],reads=[],messages=[],errors=[];let timer,clock=10;
  function node(){const n={disconnect(){this.disconnected=true;},connect(target){(this.connections||=[]).push(target);}};nodes.push(n);return n;}
  function buffer(){return {duration:200,length:2000,numberOfChannels:2,getChannelData:()=>new Float32Array(2000).fill(.5)};}
  const ac={state:'running',sampleRate:1000,get currentTime(){return clock;},destination:{},resume:async()=>{ac.state='running';},close:async()=>{ac.state='closed';},decodeAudioData:async data=>{decodes.push(data);return buffer();},
    createGain:()=>Object.assign(node(),{gain:new Param()}),createBiquadFilter:()=>Object.assign(node(),{frequency:new Param(),gain:new Param()}),createStereoPanner:()=>Object.assign(node(),{pan:new Param()}),createWaveShaper:node,createConvolver:node,createDelay:()=>Object.assign(node(),{delayTime:new Param()}),createDynamicsCompressor:()=>Object.assign(node(),Object.fromEntries(['threshold','knee','ratio','attack','release'].map(key=>[key,new Param()]))),createBuffer:()=>buffer(),
    createBufferSource:()=>{const source=Object.assign(node(),{playbackRate:new Param(),start(when,offset){this.started={when,offset};},stop(when){(this.stops||=[]).push(when);}});sources.push(source);return source;}}
  const engine=createMixAudio({contextFactory:()=>ac,readMedia:async id=>{reads.push(id);return {blob:new Blob([id])};},setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{timer=null;},onState:s=>messages.push(s),onError:e=>errors.push(e)});
  return {engine,ac,sources,nodes,decodes,reads,errors,messages,advance(seconds){clock+=seconds;timer?.();}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('preview schedules exact source offsets and audio-clock crossfades; live effects do not recreate sources',async()=>{
  const f=fixture(),{plan}=example();f.engine.setTimeline(plan);await f.engine.play(82);
  assert.equal(f.errors.length,0);assert.equal(f.sources.length,2);
  assert.deepEqual(f.sources.map(s=>s.started.offset),[82,133]);assert.ok(Math.abs(f.sources[0].stops[0]-11.04)<1e-8);
  const before=f.sources.map(s=>s.started);
  f.engine.updateEffects('b',{gain:-12,reverb:.5,pan:.4});f.engine.setBypass(true);f.engine.setBypass(false);
  assert.equal(f.sources.length,2);assert.deepEqual(f.sources.map(s=>s.started),before);
  const scheduledCurves=f.nodes.flatMap(n=>n.gain?.events||[]).filter(e=>e[0]==='curve');assert.equal(scheduledCurves.length,2);
  f.engine.pause();assert.ok(f.sources.every(s=>s.disconnected));assert.equal(f.engine.playing,false);await f.engine.close();assert.equal(f.ac.state,'closed');
});
test('a selected-song audition excludes its neighbors and stops at its preview boundary',async()=>{
  const f=fixture(),{plan}=example();f.engine.setTimeline(plan);await f.engine.play(81,{start:81,end:119,soloId:'b',loop:false});
  assert.deepEqual(f.reads,['b']);assert.equal(f.sources.length,1);assert.equal(f.sources[0].started.offset,132);f.advance(40);assert.equal(f.engine.playing,false);assert.equal(f.engine.currentTime(),119);await f.engine.close();
});
test('seeking cancels old scheduled nodes; loop restarts from its chosen boundary',async()=>{
  const f=fixture(),{plan}=example();f.engine.setTimeline(plan);await f.engine.play(78,{start:78,end:86,loop:true});
  const first=[...f.sources];await f.engine.seek(82);assert.ok(first.every(s=>s.disconnected));
  f.advance(5);await settle();assert.equal(f.engine.playing,true);assert.ok(f.engine.currentTime()>=78&&f.engine.currentTime()<78.1);await f.engine.close();
});
test('late decoded audio cannot restart after Pause or a close',async()=>{
  const f=fixture(),{plan}=example();f.engine.setTimeline(plan);let release;f.ac.decodeAudioData=()=>new Promise(resolve=>{release=resolve;});
  const promise=f.engine.play(0);await settle();assert.equal(f.engine.loading,true);f.engine.pause();release({duration:200,length:2000,numberOfChannels:2,getChannelData:()=>new Float32Array(2000)});await promise;
  assert.equal(f.sources.length,0);assert.equal(f.engine.playing,false);await f.engine.close();assert.equal(f.errors.length,0);
});
test('a long playlist decodes only its current and next song, then advances preparation',async()=>{
  const f=fixture(),mix=reconcileMix(null,['a','b','c','d'],tracks);for(const c of Object.values(mix.clips))c.out=10;
  f.engine.setTimeline(buildTimeline(mix,['a','b','c','d']));await f.engine.play(0);assert.deepEqual(f.reads,['a','b']);
  f.advance(10.1);await settle();assert.deepEqual(f.reads,['a','b','c']);f.advance(.1);assert.equal(f.engine.playing,true);assert.equal(f.errors.length,0);await f.engine.close();
});
test('decode failures and device suspension leave a paused, restartable preview',async()=>{
  const f=fixture(),{plan}=example();f.engine.setTimeline(plan);f.ac.decodeAudioData=async()=>{throw new Error('unsupported');};await f.engine.play();assert.equal(f.engine.playing,false);assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/cannot decode/);await f.engine.close();
  const g=fixture();g.engine.setTimeline(plan);await g.engine.play();g.ac.state='suspended';g.ac.onstatechange();assert.equal(g.engine.playing,false);assert.ok(g.sources.every(s=>s.disconnected));await g.engine.close();
});
