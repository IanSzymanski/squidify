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
 assert.ok(followLevel(0,1)>.9);assert.ok(followLevel(1,0)>.4&&followLevel(1,0)<.6);assert.equal(followLevel(0,0),0);
});

test('connected curve joins twelve zone apices without artificial valleys',async()=>{
 const {equalizerPoints}=await import('../dist/spectrum.js');
 const points=equalizerPoints(Array(18).fill(1),300,70);
 assert.equal(points.filter(p=>p.y===8-3).length,12);
 assert.equal(points.length,14,'only zone apices and baseline endpoints remain');
 assert.equal(points.filter(p=>p.y===67).length,2,'only the outer edges return to baseline');
 assert.ok(points.slice(1,-1).every(p=>p.y<67-62*.7),'neighboring strong bands blend above the baseline');
 assert.ok(points.every((p,i)=>!i||p.x>points[i-1].x));
 assert.ok(equalizerPoints(Array(18).fill(0),22,22).every(p=>p.y===19));
});

test('dominant zones stand out and curved joins never introduce dips or overshoot',async()=>{
 const {equalizerPoints,equalizerTangents}=await import('../dist/spectrum.js');
 const levels=Array(18).fill(.5);levels[7]=.65;levels[8]=1;levels[9]=.8;
 const points=equalizerPoints(levels,300,70),tangents=equalizerTangents(points);
 const heights=points.slice(1,-1).map(p=>67-p.y);
 assert.ok(Math.max(...heights)/heights[0]>3,'dominant peak exceeds the original two-to-one level contrast');
 assert.ok(tangents.some(t=>t!==0),'sloping joins do not flatten every node');
 for(let i=0;i<points.length-1;i++){
  const a=points[i],b=points[i+1],dx=(b.x-a.x)/3;
  const c=a.y+tangents[i]*dx,d=b.y-tangents[i+1]*dx;
  for(let j=0;j<=20;j++){
   const t=j/20,u=1-t,y=u*u*u*a.y+3*u*u*t*c+3*u*t*t*d+t*t*t*b.y;
   assert.ok(y>=Math.min(a.y,b.y)-1e-9&&y<=Math.max(a.y,b.y)+1e-9);
  }
 }
});

test('full-width baseline stays still outside the moving center and matches mini geometry',async()=>{
 const {equalizerPoints}=await import('../dist/spectrum.js');
 const levels=Array.from({length:BAND_COUNT},(_,i)=>i%4/3);
 const full=equalizerPoints(levels,390,70,84,306),mini=equalizerPoints(levels,22,22);
 assert.deepEqual(full[0],{x:0,y:67});assert.deepEqual(full.at(-1),{x:390,y:67});
 assert.ok(full.filter(p=>p.x<=84||p.x>=306).every(p=>p.y===67));
 full.slice(1,-1).forEach((p,i)=>{
  assert.ok(Math.abs((p.x-84)/222-mini[i].x/22)<1e-10);
  assert.ok(Math.abs((67-p.y)/62-(19-mini[i].y)/14)<1e-10);
 });
 assert.ok(equalizerPoints(levels,100,70,80,20).every(p=>p.y===67),'overlapping controls leave a flat baseline');
});
