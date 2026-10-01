import test from 'node:test';
import assert from 'node:assert/strict';
import { balancedShuffle, PlayQueue, formatTime, escapeHTML } from '../dist/core.js';
const tracks = Array.from({length:18},(_,i)=>({id:String(i),artist:`Artist ${i%3}`,album:`Album ${i%6}`}));
const ids=tracks.map(t=>t.id);
const map=new Map(tracks.map(t=>[t.id,t]));
function random(seed) { return ()=> {seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;}; }

test('balanced shuffle plays every song once and separates equally represented artists',()=>{
  for(let seed=0;seed<100;seed++){
    const order=balancedShuffle([...ids,ids[0]],map,[],random(seed));
    assert.equal(order.length,ids.length);assert.equal(new Set(order).size,ids.length);
    for(let i=1;i<order.length;i++)assert.notEqual(map.get(order[i]).artist,map.get(order[i-1]).artist);
  }
});
test('shuffle deals with one artist and avoids repeating the last song across cycles',()=>{
  const songs=tracks.map(t=>({...t,artist:'Same artist',album:'Same album'}));
  const order=balancedShuffle(ids,songs,['17'],random(9));
  assert.notEqual(order[0],'17');assert.deepEqual([...order].sort(),[...ids].sort());
  assert.deepEqual(balancedShuffle([],songs),[]);
});
test('previous follows actual shuffle order; changing shuffle preserves heard songs',()=>{
  const queue=new PlayQueue({shuffle:true});queue.start(ids,'7',map);
  const first=queue.current,second=queue.next(map),third=queue.next(map);
  assert.equal(queue.previous(),second);assert.equal(queue.next(map),third);
  const past=queue.order.slice(0,queue.index+1);queue.setShuffle(false,map);
  assert.deepEqual(queue.order.slice(0,queue.index+1),past);
  queue.setShuffle(true,map);assert.equal(queue.current,third);assert.equal(queue.order[0],first);assert.equal(new Set(queue.order).size,ids.length);
});
test('repeat one applies to natural endings, while manual next advances',()=>{
  const queue=new PlayQueue();queue.start(['0','1'],'0',map);queue.repeat='one';
  assert.equal(queue.next(map,false),'0');assert.equal(queue.next(map,true),'1');
  queue.repeat='off';assert.equal(queue.next(map),null);
  queue.repeat='all';assert.equal(queue.next(map),'0');
});
test('manual Next starts a full new pass at the end for every repeat mode, including shuffle and single-song queues',()=>{
  for(const repeat of ['off','one','all'])for(const shuffle of [false,true]) {
    const queue=new PlayQueue({repeat,shuffle});queue.start(['0','1','2'],'0',map);queue.index=queue.order.length-1;
    assert.ok(queue.next(map,true));assert.equal(queue.index,0);assert.equal(queue.repeat,repeat);
    const played=[queue.current,queue.next(map,true),queue.next(map,true)];
    assert.deepEqual([...played].sort(),['0','1','2']);
    queue.repeat='off';assert.equal(queue.next(map,false),null,'natural completion still stops with repeat off');
  }
  const single=new PlayQueue();single.start(['0'],'0',map);assert.equal(single.next(map,true),'0');
  const empty=new PlayQueue();assert.equal(empty.next(map,true),null);
});
test('play next moves a queued song without duplicating it; queue survives serialization',()=>{
  const queue=new PlayQueue();queue.start(['0','1','2','3'],'0',map);queue.add('3',true);
  assert.deepEqual(queue.order,['0','3','1','2']);queue.next(map);
  const restored=new PlayQueue(JSON.parse(JSON.stringify(queue)));assert.equal(restored.current,'3');assert.equal(restored.previous(),'0');
  restored.removeAt(1);assert.deepEqual(restored.order,['0','1','2']);
});
test('a prepared shuffle pass is stable, does not change playback, and refreshes after queue edits',()=>{
  const queue=new PlayQueue({shuffle:true});queue.start(ids,'0',map);queue.index=queue.order.length-1;
  const saved=queue.toJSON(),order=[...queue.order],first=queue.current;
  const prepared=[...queue.prepareNextPass(map)];
  assert.deepEqual(queue.prepareNextPass(map),prepared);assert.deepEqual(queue.order,order);assert.equal(queue.current,first);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(queue)),'preparedPass'),false);
  assert.equal(queue.next(map,true),prepared[0]);assert.deepEqual(queue.order,prepared);assert.equal(queue.preparedPass,null);
  queue.prepareNextPass(map);queue.add('new');
  assert.ok(queue.prepareNextPass(map).includes('new'));assert.equal(saved.shuffle,queue.shuffle);
});
test('removing an earlier library song preserves the current playback index',()=>{
  const queue=new PlayQueue();queue.start(['0','1','2'],'1',map);queue.prune(new Set(['1','2']));
  assert.equal(queue.current,'1');assert.equal(queue.index,0);assert.equal(queue.next(map),'2');
});
test('display helpers handle missing duration and hostile local filenames',()=>{
  assert.equal(formatTime(NaN),'—');assert.equal(formatTime(125.7),'2:05');
  assert.equal(escapeHTML('<img src=x onerror="x">'), '&lt;img src=x onerror=&quot;x&quot;&gt;');
});

test('seven-song shuffle boundaries preserve exact Previous and forward history across multiple passes',()=>{
  const queue=new PlayQueue({shuffle:true}),songs=ids.slice(0,7);queue.start(songs,'0',map);
  const heard=[queue.current];
  for(let i=0;i<21;i++)heard.push(queue.next(map,true));
  assert.equal(queue.pastPasses.length,3);
  for(let i=heard.length-2;i>=0;i--)assert.equal(queue.previous(),heard[i]);
  assert.equal(queue.previous(),heard[0],'no invented history before initial start');
  const restored=new PlayQueue(JSON.parse(JSON.stringify(queue.toJSON())));
  for(let i=1;i<heard.length;i++)assert.equal(restored.next(map,true),heard[i],'forward navigation does not reshuffle heard passes');
});
test('pass history is bounded, removes deleted tracks and resets for an explicitly started queue',()=>{
  const queue=new PlayQueue();queue.start(['0','1'],'0',map);
  for(let i=0;i<60;i++)queue.next(map,true);
  assert.equal(queue.pastPasses.length,10);
  queue.previous();queue.prune(new Set(['0']));
  assert.ok(queue.pastPasses.every(p=>p.every(id=>id==='0')));
  assert.ok(queue.futurePasses.every(p=>p.every(id=>id==='0')));
  queue.start(['2','3'],'2',map);
  assert.equal(queue.previousId,null);assert.equal(queue.pastPasses.length,0);assert.equal(queue.futurePasses.length,0);
  assert.equal(queue.previous(),'2');
});
