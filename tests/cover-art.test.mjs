import test from 'node:test';
import assert from 'node:assert/strict';
import { coverSVG, coverText, coverOptions, COVER_STYLES } from '../dist/cover-art.js';
test('generated covers are stable, vary by composition and variation, and escape user text',()=>{
  const p={id:'night',name:'<img onerror="evil">',trackIds:[]};
  assert.equal(coverSVG(p),coverSVG(p));assert.equal(new Set(COVER_STYLES.map((_,coverStyle)=>coverSVG({...p,coverStyle}))).size,8);
  assert.notEqual(coverSVG(p),coverSVG({...p,coverVariation:1}));
  assert.match(coverText(p,'0 songs'),/&lt;img/);assert.doesNotMatch(coverText(p,'0 songs'),/<img/);
  assert.equal(coverText({...p,coverTitle:false,coverInfo:false},'0 songs'),'');
  assert.equal(coverOptions({...p,coverStyle:100}).style,coverOptions(p).style);
});
