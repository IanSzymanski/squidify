import test from 'node:test';
import assert from 'node:assert/strict';
import { spectrumAt, followLevel, BAND_COUNT } from '../dist/spectrum.js';
test('equalizer hotspots separate low and high tones without temporal travel',()=>{
 const tone=f=>Float32Array.from({length:1024},(_,i)=>.7*Math.sin(2*Math.PI*f*i/8000));
 const low=spectrumAt(tone(125),512,8000),high=spectrumAt(tone(2500),512,8000);
 const peak=a=>a.indexOf(Math.max(...a));assert.equal(low.length,BAND_COUNT);assert.ok(peak(high)>peak(low)+8);
 assert.deepEqual([...spectrumAt(new Float32Array(1024),512,8000)],Array(BAND_COUNT).fill(0));
 assert.ok(low.every(x=>Number.isFinite(x)&&x>=0&&x<=1));
});
test('sharp accents attack quickly while release remains smooth',()=>{
 assert.ok(followLevel(0,1)>.7);assert.ok(followLevel(1,0)>.5);assert.equal(followLevel(0,0),0);
});

test('connected curve retains twelve narrow peaks and baseline valleys under full-band energy',async()=>{
 const {equalizerPoints}=await import('../dist/spectrum.js');
 const points=equalizerPoints(Array(18).fill(1),300,70);
 assert.equal(points.filter(p=>p.y===8-3).length,12);
 assert.equal(points.filter(p=>p.y===67).length,13);
 assert.ok(points.every((p,i)=>!i||p.x>points[i-1].x));
 assert.ok(equalizerPoints(Array(18).fill(0),22,22).every(p=>p.y===19));
});
