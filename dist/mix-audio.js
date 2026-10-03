import * as db from './storage.js';
import { clamp, cleanEffects, envelopeAt, fadeValue } from './mix-model.js';

const DB = value => Math.pow(10, value / 20);
export function waveformPeaks(buffer, count = 360) {
  const data = buffer.getChannelData(0), peaks = [];
  for (let n=0;n<count;n++) {
    const begin=Math.floor(n*data.length/count),end=Math.floor((n+1)*data.length/count),stride=Math.max(1,Math.floor((end-begin)/64));
    let peak=0; for(let i=begin;i<end;i+=stride)peak=Math.max(peak,Math.abs(data[i])); peaks.push(peak);
  }
  return peaks;
}
export function scheduleEnvelope(param, entry, position, origin, now) {
  const clock = time => origin + time;
  const at = Math.max(position, entry.start);
  param.cancelScheduledValues(now); param.value=envelopeAt(entry, at);
  const fade = (start, duration, incoming, curve) => {
    if (!duration || start+duration <= at) return;
    const first=Math.max(start,at),remaining=start+duration-first;
    const values=Float32Array.from({length:65},(_,i)=>fadeValue((first-start+remaining*i/64)/duration,incoming,curve));
    param.setValueCurveAtTime(values,Math.max(now,clock(first)),remaining);
  };
  fade(entry.start,entry.incoming,true,entry.inCurve);
  fade(entry.end-entry.outgoing,entry.outgoing,false,entry.outCurve);
  param.setValueAtTime(0,clock(entry.end));
}

// Foreground editing has its own AudioContext; normal native playback is untouched.
// Only the current overlap and next song are retained, never a decoded playlist.
export function createMixAudio({onState=()=>{},onTick=()=>{},onError=()=>{},readMedia=id=>db.get('media',id),contextFactory=()=>new (window.AudioContext||window.webkitAudioContext)(),setTimer=setInterval,clearTimer=clearInterval}={}) {
  let ac, master, compressor, impulse, plan={entries:[],duration:0}, origin=0, position=0, playing=false, loading=false, generation=0, timer, bounds=null, bypass=false, closed=false,decodeChain=Promise.resolve(),waveTarget=null;
  const buffers=new Map(),pending=new Map(),voices=new Map(),failed=new Map();
  const budget=256*1024*1024;
  const time = () => playing ? clamp(Math.max(position,ac.currentTime-origin),0,plan.duration) : position;
  function state(message='') {onState({playing,loading,position:time(),message});}
  function ensureContext() {
    if(closed)throw new Error('The mix editor has closed.');
    if(ac)return ac;
    ac=contextFactory(); master=ac.createGain();master.gain.value=.8;
    compressor=ac.createDynamicsCompressor();compressor.threshold.value=-3;compressor.knee.value=6;compressor.ratio.value=12;compressor.attack.value=.003;compressor.release.value=.15;
    master.connect(compressor);compressor.connect(ac.destination);
    ac.onstatechange=()=>{if(playing&&ac.state!=='running'){pause();state('Preview paused. Tap Play to continue.');}};
    return ac;
  }
  function bytes(buffer){return buffer.length*buffer.numberOfChannels*4;}
  function trimCache(keep, extra=0) {
    let size=[...buffers.values()].reduce((sum,b)=>sum+bytes(b),0);
    for(const [id,b] of buffers)if(!keep.has(id)&&(buffers.size>=3||size+extra>budget)){buffers.delete(id);size-=bytes(b);}
    if(size+extra>budget)throw new Error('This song is too large for the preview memory available. Try a shorter audio file.');
  }
  async function bufferFor(id, protect=[],forWave=false) {
    if(buffers.has(id))return buffers.get(id);
    if(pending.has(id))return pending.get(id);
    const context=ensureContext();
    const promise=decodeChain.catch(()=>{}).then(async()=>{
      if(closed || (forWave && waveTarget!==id))throw new Error('Waveform request cancelled.');
      const entry=plan.entries.find(e=>e.trackId===id);
      if(entry&&entry.sourceDuration*context.sampleRate*8>budget)throw new Error('This song is too long to decode safely for editing. Try a shorter audio file.');
      const item=await readMedia(id);if(!item?.blob)throw new Error('An audio file is missing. Reimport it into your library to preview this mix.');
      const encoded=await item.blob.arrayBuffer();if(closed)throw new Error('Preview closed.');
      let buffer;try{buffer=await context.decodeAudioData(encoded);}catch{throw new Error('This browser cannot decode this song for mixing. Try an MP3 or AAC copy.');}
      if(closed)throw new Error('Preview closed.');
      trimCache(new Set([...protect,...voices.keys(),id]),bytes(buffer));buffers.set(id,buffer);return buffer;
    });
    decodeChain=promise;pending.set(id,promise);
    try{return await promise;}finally{pending.delete(id);}
  }
  function makeImpulse() {
    if(impulse)return impulse;
    impulse=ac.createBuffer(2,Math.floor(ac.sampleRate*1.4),ac.sampleRate);
    for(let c=0;c<2;c++){const channel=impulse.getChannelData(c);for(let i=0;i<channel.length;i++)channel[i]=(Math.random()*2-1)*Math.pow(1-i/channel.length,2.8);}
    return impulse;
  }
  function parameter(param,value){param.setTargetAtTime(value,ac.currentTime,.015);}
  function effects(voice, values) {
    const fx=cleanEffects(bypass?{}:values);
    parameter(voice.gain.gain,DB(fx.gain));parameter(voice.bass.gain,fx.bass);parameter(voice.treble.gain,fx.treble);parameter(voice.pan.pan,fx.pan);
    parameter(voice.reverbWet.gain,fx.reverb*.65);parameter(voice.delayWet.gain,fx.delay*.55);
    if(voice.distortionAmount!==fx.distortion){
      voice.distortionAmount=fx.distortion;
      const amount=fx.distortion*35;
      voice.distortion.curve=Float32Array.from({length:2048},(_,i)=>{const x=i*2/2047-1;return amount?Math.tanh(x*(1+amount))/Math.tanh(1+amount):x;});
    }
  }
  function createVoice(entry, at) {
    const buffer=buffers.get(entry.trackId);if(!buffer||voices.has(entry.trackId)||entry.end<=at)return;
    const source=ac.createBufferSource();source.buffer=buffer;source.playbackRate.value=entry.rate;
    const gain=ac.createGain(),bass=ac.createBiquadFilter(),treble=ac.createBiquadFilter(),pan=ac.createStereoPanner(),distortion=ac.createWaveShaper(),reverb=ac.createConvolver(),reverbWet=ac.createGain(),delay=ac.createDelay(1),feedback=ac.createGain(),delayWet=ac.createGain(),sum=ac.createGain(),envelope=ac.createGain();
    bass.type='lowshelf';bass.frequency.value=200;treble.type='highshelf';treble.frequency.value=3500;delay.delayTime.value=.28;feedback.gain.value=.22;reverb.buffer=makeImpulse();
    source.connect(bass);bass.connect(treble);treble.connect(distortion);distortion.connect(sum);
    distortion.connect(reverb);reverb.connect(reverbWet);reverbWet.connect(sum);
    distortion.connect(delay);delay.connect(feedback);feedback.connect(delay);delay.connect(delayWet);delayWet.connect(sum);
    sum.connect(gain);gain.connect(pan);pan.connect(envelope);envelope.connect(master);
    const voice={source,gain,bass,treble,pan,distortion,reverbWet,delayWet,entry,nodes:[source,gain,bass,treble,pan,distortion,reverb,reverbWet,delay,feedback,delayWet,sum,envelope]};
    effects(voice,entry.effects);
    const start=Math.max(entry.start,at),offset=entry.in+(start-entry.start)*entry.rate;
    if(offset>=buffer.duration){voice.nodes.forEach(node=>node.disconnect());throw new Error('The saved trim is beyond this audio file. Adjust its In and Out points.');}
    scheduleEnvelope(envelope.gain,entry,at,origin,ac.currentTime);
    source.start(Math.max(ac.currentTime,origin+start),offset);
    source.stop(origin+Math.min(entry.end,bounds?.end??entry.end));voices.set(entry.trackId,voice);
  }
  function dropVoice(id) {const voice=voices.get(id);if(!voice)return;try{voice.source.stop();}catch{}voice.nodes.forEach(node=>node.disconnect());voices.delete(id);}
  function stopVoices(){for(const id of voices.keys())dropVoice(id);clearTimer(timer);timer=undefined;}
  function pause(){position=time();generation++;playing=false;loading=false;stopVoices();state();onTick(position);}
  async function play(start=position, range=bounds) {
    pause();const token=generation;bounds=range;position=clamp(start,0,plan.duration);
    if(!plan.entries.length)return;
    if(position>=plan.duration)position=range?.start||0;
    loading=true;state('Preparing audio…');
    try{
      const context=ensureContext();await context.resume();
      const needed=plan.entries.filter(e=>e.end>position&&e.start<(range?.end??plan.duration)&&(!range?.soloId||e.trackId===range.soloId)).slice(0,2).map(e=>e.trackId);
      // Serial decoding bounds transient memory on mobile.
      for(const id of needed){await bufferFor(id,needed);if(token!==generation||closed)return;}
      if(token!==generation||closed)return;
      if(context.state!=='running')throw new Error('Audio is paused by your device. Tap Play to try again.');
      origin=context.currentTime+.04-position;playing=true;loading=false;
      pump();timer=setTimer(pump,40);state();
    }catch(error){if(token!==generation||closed)return;pause();onError(error);}
  }
  function pump(){
    if(!playing)return;
    const at=time(),end=bounds?.end??plan.duration;
    if(at>=end){position=end;const loop=bounds?.loop,preset=bounds;pause();position=end;if(loop)void play(preset.start,preset);else{onTick(end);state();}return;}
    for(const [id,voice] of voices)if(voice.entry.end<=at)dropVoice(id);
    const next=plan.entries.filter(e=>e.end>at&&e.start<(bounds?.end??plan.duration)&&(!bounds?.soloId||e.trackId===bounds.soloId)).slice(0,2);
    try{
      for(const entry of next){
        if(buffers.has(entry.trackId))createVoice(entry,at);
        else if(entry.start<=at+.15){
          // Never silently skip a boundary when a file is not ready.
          if(failed.has(entry.trackId)){const error=failed.get(entry.trackId);failed.delete(entry.trackId);throw error;}
          void play(at,bounds);return;
        }else if(!pending.has(entry.trackId)&&!failed.has(entry.trackId))void bufferFor(entry.trackId,next.map(e=>e.trackId)).catch(error=>{if(!closed)failed.set(entry.trackId,error);});
      }
      onTick(at);
    }catch(error){pause();onError(error);}
  }
  return {
    get playing(){return playing;},get loading(){return loading;},get position(){return time();},
    currentTime:time,
    play,pause,
    seek(value){const running=playing||loading;if(running)return play(value,bounds);position=clamp(value,0,plan.duration);onTick(position);},
    setTimeline(next){pause();plan=next;position=Math.min(position,plan.duration);bounds=null;failed.clear();},
    updateEffects(id,fx){const entry=plan.entries.find(e=>e.trackId===id);if(entry)entry.effects=cleanEffects(fx);const voice=voices.get(id);if(voice)effects(voice,fx);},
    setBypass(value){bypass=value;for(const voice of voices.values())effects(voice,voice.entry.effects);},
    setVolume(value){if(master)parameter(master.gain,clamp(value,0,1));},
    async waveform(id){waveTarget=id;const buffer=await bufferFor(id,[],true);return {peaks:waveformPeaks(buffer),duration:buffer.duration};},
    async close(){pause();closed=true;buffers.clear();failed.clear();impulse=null;if(ac){ac.onstatechange=null;await ac.close();}ac=null;}
  };
}
