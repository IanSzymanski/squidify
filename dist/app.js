import { createEnhancements } from './enhancements.js';
import * as db from './storage.js';
import { PlayQueue } from './core.js';
import { createContext } from './context.js';
import { createInterface } from './interface.js';
import { createImport } from './import.js';
import { createPlaylists } from './playlists.js';
import { createPlayback } from './playback.js';
import { createOffline } from './offline.js';
import { createMixEditor } from './mix-editor.js';
import { createConverter } from './converter.js';

// Wire stable API objects before any callbacks run. Modules never import each
// other, and each owns its timers, event listeners, and temporary resources.
const context = createContext();
for (const name of ['ui', 'importer', 'playlists', 'playback', 'offline']) context[name] = {};
Object.assign(context.ui, createInterface(context));
Object.assign(context.importer, createImport(context));
Object.assign(context.playlists, createPlaylists(context));
Object.assign(context.playback, createPlayback(context));
Object.assign(context.offline, createOffline(context));
context.enhancements = createEnhancements(context);
context.mixEditor = createMixEditor(context);
context.converter = createConverter(context);
const { state, audio, main, trackArray } = context;
const { paintIcons, readRoute, header, toast } = context.ui;
const { loadTrack } = context.playback;
const { setupOffline } = context.offline;
const actions = Object.assign({}, context.ui.actions, context.importer.actions, context.playlists.actions, context.playback.actions, context.mixEditor.actions, context.converter.actions);
context.ui.bindEvents(actions);
context.importer.bindEvents();
context.playlists.bindEvents();
context.playback.bindEvents();
context.mixEditor.bindEvents();
context.converter.bindEvents();

async function init() {
  paintIcons();
  try{
    const [tracks,playlists,folders,saved,playlistOrder]=await Promise.all([db.all('tracks'),db.all('playlists'),db.all('folders'),db.setting('session',{}),db.setting('playlistOrder',[]),context.enhancements.loadSettings(),context.playback.loadMixingSettings(),context.converter.loadSettings()]);
    state.tracks=new Map(tracks.map(t=>[t.id,t]));state.playlists=playlists.sort((a,b)=>{const order=Array.isArray(playlistOrder)?playlistOrder:[];const rank=id=>{const i=order.indexOf(id);return i<0?order.length:i;};return rank(a.id)-rank(b.id);});state.folders=folders;state.queue=new PlayQueue(saved.queue);state.queue.prune(new Set(state.tracks.keys()));state.sort=saved.sort||'added';
    audio.volume=typeof saved.volume==='number'?Math.min(1,Math.max(0,saved.volume)):1;audio.muted=!!saved.muted;
    state.storage=await db.storageInfo();state.ready=true;readRoute();
    if(state.queue.current)await loadTrack(state.queue.current,false,saved.time||0);
    setupOffline();
    context.playback.setupMediaSession();
    registerTools();
  }catch(e){console.error(e);main.innerHTML=header('Storage is unavailable','','SQUIDIFY',null)+'<p class="inline-alert">Squidify needs permission to save music in this browser. Try a regular browser window, allow website storage, then reload.</p><button class="button" onclick="location.reload()">Reload Squidify</button>';toast('Could not open local storage.',true);setupOffline();}
}
function registerTools() {
  const modelContext=document.modelContext;if(!modelContext?.registerTool)return;
  const lifecycle=new AbortController();
  const register=tool=>{try{Promise.resolve(modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}};
  register({name:'read_music_library',description:'Read locally imported music metadata and playlists. Does not read or transmit audio files.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:()=>({tracks:trackArray().map(t=>({id:t.id,title:t.title,artist:t.artist,album:t.album,liked:!!t.liked})),playlists:state.playlists.map(p=>({id:p.id,name:p.name,trackIds:p.trackIds})),currentTrackId:state.queue.current})});
  register({name:'create_music_playlist',description:'Create a local playlist from existing track IDs and show it in Squidify.',inputSchema:{type:'object',properties:{name:{type:'string',minLength:1,maxLength:100},trackIds:{type:'array',items:{type:'string'}}},required:['name','trackIds'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},execute:context.playlists.createFromTool});
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}

export { context, actions };
export const ready = init();
