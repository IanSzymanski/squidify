import test from 'node:test';
import assert from 'node:assert/strict';
import { fileName, safeName } from '../dist/downloads.js';

test('downloaded files are named "Artist - Title" in their own format, with names that work on Windows, macOS and phones',()=>{
  assert.equal(fileName({title:'Never Gonna Give You Up',artist:'Rick Astley',name:'Rick Astley - Never.m4a',mime:'audio/mp4'}),'Rick Astley - Never Gonna Give You Up.m4a');
  assert.equal(fileName({title:'AC/DC: Live? <2>',artist:'Unknown artist',name:'x.FLAC'}),'AC DC Live 2.flac');
  assert.equal(fileName({title:'',artist:'',name:'01 Intro.wav'}),'01 Intro.wav');
  assert.equal(fileName({title:'Song',artist:'Band',mime:'audio/ogg'}),'Band - Song.ogg');
  assert.equal(fileName({}),'Song.mp3');
  assert.equal(safeName('CON'),'_CON');assert.equal(safeName('  trailing dots... '),'trailing dots');assert.equal(safeName('a\u0000b\nc'),'a b c');
  assert.equal(safeName('x'.repeat(300)).length,120);
});
