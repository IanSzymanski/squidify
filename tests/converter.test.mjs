import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeURL, converterConfig, createConverterClient, audioFilename, MAX_AUDIO_BYTES } from '../dist/converter-client.js';

const id='a'.repeat(48),token='a'.repeat(48),endpoint='https://converter.example';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
test('YouTube input normalization accepts single videos and rejects host spoofing, playlists and command input',()=>{
  for(const url of ['BaW_jenozKc','https://youtu.be/BaW_jenozKc?t=30','https://music.youtube.com/watch?v=BaW_jenozKc&list=ignored','https://youtube.com/shorts/BaW_jenozKc'])assert.equal(youtubeURL(url),'https://www.youtube.com/watch?v=BaW_jenozKc');
  for(const url of ['https://youtube.com.evil.test/watch?v=BaW_jenozKc','https://youtube.com@evil.test/watch?v=BaW_jenozKc','https://youtube.com/playlist?list=x','https://youtube.com/watch?v=BaW_jenozKc&v=BaW_jenozKc','--exec anything','file:///etc/passwd'])assert.throws(()=>youtubeURL(url));
});
test('service connections require HTTPS and an explicit key; keys never enter URLs',async()=>{
  for(const url of ['http://example.test','https://secret@example.test','https://example.test/?token=x','https://example.test/#x'])assert.throws(()=>converterConfig(url,token));
  assert.throws(()=>converterConfig(endpoint,'short'));
  let received;const client=createConverterClient({endpoint,token},{fetcher:async(url,options)=>{received={url,options};return json({service:'squidify-converter',api_version:1,ready:true});}});
  await client.check();assert.equal(received.url,endpoint+'/api/health');assert.equal(received.options.headers.Authorization,'Bearer '+token);assert.equal(received.options.redirect,'error');assert.equal(received.options.credentials,'omit');
});
test('job/download paths remain on the chosen service even when responses advertise foreign URLs',async()=>{
  const paths=[];const client=createConverterClient({endpoint,token},{fetcher:async(url)=>{paths.push(url);if(url.endsWith('/convert'))return json({job_id:id,status_url:'https://foreign.example/stolen'});if(url.includes('/download/'))return new Response('ID3test',{headers:{'Content-Type':'audio/mpeg'}});return json({status:'ready',title:'A / song',download_url:'https://foreign.example/stolen'});}});
  const job=await client.start('BaW_jenozKc');const result=await client.status(job);const file=await client.download(job,result.title);
  assert.equal(file.type,'audio/mpeg');assert.equal(file.name,'A   song.mp3');assert.ok(paths.every(url=>url.startsWith(endpoint+'/api/')));assert.equal(await file.text(),'ID3test');assert.throws(()=>client.status('https://foreign.example'));
});
test('oversized, incomplete, HTML and non-MP3 downloads are rejected before import',async()=>{
  for(const response of [new Response('ID3test',{headers:{'Content-Type':'audio/mpeg','Content-Length':String(MAX_AUDIO_BYTES+1)}}),new Response('ID3test',{headers:{'Content-Type':'audio/mpeg','Content-Length':'20'}}),new Response('<html>error</html>',{headers:{'Content-Type':'text/html'}}),new Response('invalid',{headers:{'Content-Type':'audio/mpeg'}})]){
    const client=createConverterClient({endpoint,token},{fetcher:async()=>response});await assert.rejects(client.download(id,'track'));
  }
});
test('progress measures actual received bytes, metadata is safe, and storage acknowledgment is explicit',async()=>{
  const events=[],calls=[];const client=createConverterClient({endpoint,token},{fetcher:async(url,options)=>{calls.push([url,options.method]);return url.includes('/download/')?new Response('ID3test',{headers:{'Content-Type':'audio/mpeg','Content-Length':'7'}}):json({status:'downloaded'});}});
  const file=await client.download(id,'../bad<>name.mp3',undefined,(...value)=>events.push(value));assert.equal(file.size,7);assert.deepEqual(events.at(-1),[7,7]);assert.ok(!file.name.includes('/'));assert.equal(calls.length,1,'receiving audio does not acknowledge a library commit');
  await client.complete(id);assert.deepEqual(calls.at(-1),[endpoint+'/api/jobs/'+id+'/complete','POST']);assert.equal(audioFilename(''), 'YouTube audio.mp3');
});
test('health failures and cancellation are actionable and cannot start conversion',async()=>{
  const bad=createConverterClient({endpoint,token},{fetcher:async()=>json({service:'other',ready:true})});await assert.rejects(bad.check(),/compatible/);
  const denied=createConverterClient({endpoint,token},{fetcher:async()=>json({error:'Key rejected'},401)});await assert.rejects(denied.check(),/Key rejected/);
  const signal=new AbortController();signal.abort();let calls=0;const client=createConverterClient({endpoint,token},{fetcher:()=>{calls++;}});await assert.rejects(client.check(signal.signal),{name:'AbortError'});assert.equal(calls,0);
});
