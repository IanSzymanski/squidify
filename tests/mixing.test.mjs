import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMixing,fadeValues,overlapSeconds,MIX_DEFAULTS} from '../dist/mixing.js';

test('mix preferences reject corrupt values, bound duration and default to disabled',()=>{
  assert.deepEqual(normalizeMixing(null),MIX_DEFAULTS);
  assert.deepEqual(normalizeMixing({enabled:'true',duration:Infinity,curve:'<script>'}),MIX_DEFAULTS);
  assert.equal(normalizeMixing({duration:99}).duration,12);
  assert.equal(normalizeMixing({duration:-8}).duration,0);
  assert.equal(normalizeMixing({duration:2.36}).duration,2.4);
});
test('all curves have correct endpoints, monotonic gain, and bounded overlap peaks',()=>{
  for(const curve of ['linear','equal-power','smooth']){
    let last=[1,0];
    for(let i=0;i<=1000;i++){
      const gains=fadeValues(curve,i/1000);
      assert.ok(gains[0]<=last[0]+1e-12&&gains[1]>=last[1]-1e-12);
      assert.ok(.7*(gains[0]+gains[1])<1);
      if(curve==='equal-power')assert.ok(Math.abs(gains[0]**2+gains[1]**2-1)<1e-12);
      else assert.ok(Math.abs(gains[0]+gains[1]-1)<1e-12);
      last=gains;
    }
    assert.deepEqual(fadeValues(curve,0),[1,0]);assert.ok(fadeValues(curve,1)[0]<1e-12);assert.equal(fadeValues(curve,1)[1],1);
  }
  assert.ok(fadeValues('smooth',.1)[1]<fadeValues('linear',.1)[1]);
});
test('short tracks and playback rates cannot produce three-way overlaps',()=>{
  assert.equal(overlapSeconds(12,10,120),5);
  assert.equal(overlapSeconds(12,120,6),3);
  assert.equal(overlapSeconds(12,10,20,2),2.5);
  assert.equal(overlapSeconds(12,NaN,20),0);
  assert.equal(overlapSeconds(0,120,120),0);
  assert.equal(overlapSeconds(12,120,120,0),0);
});
