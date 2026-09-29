import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readMetadata, parseID3, fingerprint, isAudio, mimeFor } from '../dist/metadata.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const encode=s=>new TextEncoder().encode(s);
const frame=(id,value)=>{const b=encode(value),result=new Uint8Array(11+b.length);result.set(encode(id));new DataView(result.buffer).setUint32(4,b.length+1);result[10]=3;result.set(b,11);return result;};
export function taggedFile(title='Signal',name='song.mp3'){
  const frames=[frame('TIT2',title),frame('TPE1','Local artist'),frame('TALB','Local album'),frame('TLEN','180000')];
  const size=frames.reduce((n,f)=>n+f.length,0),bytes=new Uint8Array(10+size);bytes.set(encode('ID3'));bytes[3]=3;bytes.set([(size>>21)&127,(size>>14)&127,(size>>7)&127,size&127],6);let offset=10;for(const f of frames){bytes.set(f,offset);offset+=f.length;}
  return new File([bytes],name,{type:'audio/mpeg'});
}
test('ID3 metadata supports title, artist, album and duration',async()=>{
  const tags=await readMetadata(taggedFile());
  assert.equal(tags.title,'Signal');assert.equal(tags.artist,'Local artist');assert.equal(tags.album,'Local album');assert.equal(tags.duration,180);
});
test('missing and malformed tags safely fall back to filename and folder',async()=>{
  const tags=await readMetadata(new File(['not valid media'],'Artist - 03 Song.wav'),'Music/Record/Artist - 03 Song.wav');
  assert.equal(tags.title,'Song');assert.equal(tags.artist,'Artist');assert.equal(tags.album,'Record');
  for(let n=0;n<30;n++)assert.doesNotThrow(()=>parseID3(new Uint8Array(n)));
});
test('duplicate detection ignores filename and recognizes changed bytes',async()=>{
  const a=taggedFile(),same=new File([await a.arrayBuffer()],'renamed.mp3');
  assert.equal(await fingerprint(a),await fingerprint(same));assert.notEqual(await fingerprint(a),await fingerprint(taggedFile('Another')));
});
test('file picker fallback accepts extension-only files and assigns useful media types',()=>{
  assert.equal(isAudio({name:'TRACK.M4A',type:''}),true);assert.equal(mimeFor({name:'TRACK.M4A',type:''}),'audio/mp4');
  assert.equal(isAudio({name:'notes.txt',type:'text/plain'}),false);
});
