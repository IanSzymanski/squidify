import * as db from './storage.js';
import { PlayQueue, formatTime, formatBytes, escapeHTML as esc } from './core.js';
import { isAudio, mimeFor, fingerprint, readMetadata } from './metadata.js';
import { icon, mark } from './icons.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const main = $('#main'), audio = $('#audio'), modal = $('#modal'), nowDialog = $('#nowDialog');
const fileInput = $('#fileInput'), folderInput = $('#folderInput');
const state = { tracks: new Map(), playlists: [], folders: [], queue: new PlayQueue(), view: 'library', detail: '', search: '', tab: 'songs', sort: 'added', busy: false, stopImport: false, shellReady: false, storage: {}, installPrompt: null, ready: false };
const artworkURLs = new Map(), mediaURLs = new Map(), mediaPromises = new Map();
let activeId = null, playGeneration = 0, playIntent = false, priming = false, audioUnlocked = false, toastTimer, stateTimer, lastSavedAt = 0, metadataJobs = [], probing = false;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const trackArray = () => [...state.tracks.values()];
const byId = id => state.tracks.get(id);
const playlist = id => state.playlists.find(p => p.id === id);
const idToken = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const totalDuration = list => { const s = list.reduce((sum,t) => sum + (t.duration || 0),0); return s ? s < 3600 ? `${Math.round(s/60)} min` : `${Math.floor(s/3600)} hr ${Math.round(s%3600/60)} min` : ''; };

function toast(message, error = false) {
  clearTimeout(toastTimer);
  const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6500 : 3500);
}
function report(error, fallback = 'Something went wrong. Please try again.') {
  if (error?.name === 'AbortError') return;
  console.error(error);
  toast(error?.name === 'QuotaExceededError' ? 'Device storage is full. Remove some songs, then try again.' : fallback, true);
}
function paintIcons(root = document) {
  $$('[data-icon]', root).forEach(el => { el.innerHTML = icon(el.dataset.icon); });
  $$('[data-mark]', root).forEach(el => { el.innerHTML = mark; });
}
function artwork(track, extra = '', fallback = 'music') {
  let url;
  if (track?.artwork) {
    url = artworkURLs.get(track.id);
    if (!url) { url = URL.createObjectURL(track.artwork); artworkURLs.set(track.id,url); }
  }
  return `<span class="artwork ${extra}">${url ? `<img src="${url}" alt="" loading="lazy">` : icon(fallback)}</span>`;
}
function collectionArt(p, extra = '') {
  const track = p?.trackIds?.map(byId).find(t => t?.artwork);
  return artwork(track, `${extra} ${p?.color || 'purple'}`, 'list');
}
function route(name, id = '') {
  state.search = ''; $('#searchInput').value = '';
  const hash = `#${name}${id ? '/'+encodeURIComponent(id) : ''}`;
  if (location.hash !== hash) location.hash = hash;
  else readRoute();
}
function readRoute() {
  const [name, ...parts] = location.hash.slice(1).split('/');
  state.view = ['library','liked','playlists','playlist','album','settings'].includes(name) ? name : 'library';
  try { state.detail = decodeURIComponent(parts.join('/')); } catch { state.detail = ''; }
  state.search = ''; $('#searchInput').value = '';
  render(); window.scrollTo({ top:0 });
}
function currentList() {
  let list;
  if (state.search) {
    const query = state.search.toLowerCase().trim();
    list = trackArray().filter(t => `${t.title} ${t.artist} ${t.album} ${t.name}`.toLowerCase().includes(query));
  } else if (state.view === 'liked') list = trackArray().filter(t => t.liked);
  else if (state.view === 'playlist') list = (playlist(state.detail)?.trackIds || []).map(byId).filter(Boolean);
  else if (state.view === 'album') list = trackArray().filter(t => albumKey(t) === state.detail).sort((a,b)=>(parseInt(a.trackNumber)||999)-(parseInt(b.trackNumber)||999)||a.title.localeCompare(b.title));
  else list = trackArray();
  const sort = state.view === 'playlist' && !state.search ? 'custom' : state.view === 'album' && !state.search ? 'custom' : state.sort;
  if(sort === 'title') list.sort((a,b)=>a.title.localeCompare(b.title));
  if(sort === 'artist') list.sort((a,b)=>a.artist.localeCompare(b.artist)||a.title.localeCompare(b.title));
  if(sort === 'album') list.sort((a,b)=>a.album.localeCompare(b.album)||(parseInt(a.trackNumber)||999)-(parseInt(b.trackNumber)||999));
  if(sort === 'added') list.sort((a,b)=>b.addedAt-a.addedAt);
  return list;
}
function albumKey(t) { return `${t.album}\u241f${t.artist}`; }
function contextName() {
  if (state.search) return `Search: ${state.search}`;
  if (state.view === 'liked') return 'Liked songs';
  if (state.view === 'playlist') return playlist(state.detail)?.name || 'Playlist';
  if (state.view === 'album') return currentList()[0]?.album || 'Album';
  return 'Your library';
}
function renderSidebar() {
  $('#likedCount').textContent = trackArray().filter(t=>t.liked).length;
  $('#sidebarPlaylists').innerHTML = state.playlists.length ? state.playlists.map(p=>`<button class="sidebar-playlist ${state.view==='playlist'&&state.detail===p.id?'active':''}" data-view="playlist" data-id="${esc(p.id)}">${collectionArt(p)}<span><strong>${esc(p.name)}</strong><small>${plural(p.trackIds.length,'song')}</small></span></button>`).join('') : '<p class="sidebar-empty">A place for every mood.<br>Create your first playlist.</p>';
  $$('[data-view]').forEach(el=> { const selected = !state.search && el.dataset.view === state.view && (!el.dataset.id || el.dataset.id === state.detail); el.classList.toggle('active',selected); if(selected)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current'); });
}
function header(title,meta,eyebrow='ON THIS DEVICE', action='add-music',label='Add music') {
  return `<div class="view-header"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1>${meta?`<p class="view-meta">${meta}</p>`:''}</div>${action?`<button class="button quiet" data-action="${action}">${icon('plus')}<span class="button-label">${label}</span></button>`:''}</div>`;
}
function sortControl() {
  return `<label class="sort-label">${icon('list')}<select id="sortSelect" aria-label="Sort songs">${[['added','Recently added'],['title','Title'],['artist','Artist'],['album','Album']].map(([v,l])=>`<option value="${v}" ${state.sort===v?'selected':''}>${l}</option>`).join('')}</select>${icon('down')}</label>`;
}
function trackRows(list) {
  return `<table class="track-table"><thead><tr><th class="num">#</th><th class="title-col">Title</th><th class="album-col">Album</th><th class="like-col"><span class="sr-only">Liked</span></th><th class="duration-col" aria-label="Duration">${icon('clock')}</th><th class="more-col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${list.map((t,i)=>`<tr data-track-row="${t.id}" class="${state.queue.current===t.id?'current':''}"><td class="number-cell"><button class="number-button" data-action="play-track" data-id="${t.id}" aria-label="Play ${esc(t.title)}">${state.queue.current===t.id?icon(!audio.paused?'pause':'play'):i+1}</button></td><td><button class="track-cell" data-action="play-track" data-id="${t.id}">${artwork(t)}<span class="track-text"><span class="song-title">${esc(t.title)}</span><span class="song-artist">${esc(t.artist)}</span></span></button></td><td class="album-cell"><button class="album-text" data-view="album" data-id="${esc(albumKey(t))}">${esc(t.album)}</button></td><td class="table-like"><button class="icon-button like-button ${t.liked?'liked':''}" data-action="like" data-id="${t.id}" aria-label="${t.liked?'Unlike':'Like'} ${esc(t.title)}" aria-pressed="${!!t.liked}">${icon('heart')}</button></td><td class="duration-cell" data-duration-id="${t.id}">${formatTime(t.duration)}</td><td><button class="icon-button" data-action="track-menu" data-id="${t.id}" aria-label="Actions for ${esc(t.title)}">${icon('more')}</button></td></tr>`).join('')}</tbody></table>`;
}
function emptyLibrary() {
  return `<section class="empty-library"><div class="empty-icon">${icon('folder')}</div><h2>Your music belongs here.</h2><p>Connect a folder or choose audio files to start your own offline library.</p><div class="actions-row"><button class="button primary" data-action="choose-folder">${icon('folder')}Choose a folder</button><button class="button" data-action="choose-files">${icon('plus')}Choose files</button></div><p class="empty-footer">${icon('shield')}Music stays on your device. No uploads. No account for your music.</p></section><div class="help-grid"><div class="help-item">${icon('download')}<div><h3>Take it offline</h3><p>Imported songs are saved on this device, ready when the connection isn’t.</p></div></div><div class="help-item">${icon('shuffle')}<div><h3>A better kind of shuffle</h3><p>No repeats in a cycle. More space between the same artists.</p></div></div><div class="help-item">${icon('plus')}<div><h3>Keep it on your Home Screen</h3><p>Install Squidify, then add your music inside the installed app.</p><button data-view="settings">How to install</button></div></div></div>`;
}
function renderLibrary() {
  const list=currentList(), allCount=state.tracks.size;
  const searching=!!state.search;
  let html=header(searching?'Search results':'Your library',searching?`<span>${plural(list.length,'song')} found</span>`:`<span>${plural(allCount,'song')}</span><span>${formatBytes(trackArray().reduce((s,t)=>s+t.size,0))}</span>`,searching?'YOUR MUSIC':'ON THIS DEVICE');
  html+=`<div class="toolbar"><div class="pills"><button class="pill ${state.tab==='songs'||searching?'active':''}" data-action="tab" data-tab="songs">Songs</button>${!searching?`<button class="pill ${state.tab==='albums'?'active':''}" data-action="tab" data-tab="albums">Albums</button>`:''}</div>${list.length?sortControl():''}</div>`;
  if(!allCount) return html+emptyLibrary();
  if(!list.length) return html+'<div class="empty-small"><h2>No songs found</h2><p>Try another title, artist, album, or filename.</p></div>';
  if(state.tab==='albums'&&!searching) {
    const albums=new Map(); for(const t of list){ const key=albumKey(t); if(!albums.has(key))albums.set(key,[]);albums.get(key).push(t); }
    return html+`<div class="grid">${[...albums].sort((a,b)=>a[1][0].album.localeCompare(b[1][0].album)).map(([key,ts])=>`<button class="collection-card" data-view="album" data-id="${esc(key)}">${artwork(ts.find(t=>t.artwork)||ts[0],'','album')}<strong>${esc(ts[0].album)}</strong><small>${esc(ts[0].artist)} · ${plural(ts.length,'song')}</small></button>`).join('')}</div>`;
  }
  html+=`<div class="collection-actions"><button class="play-circle" data-action="play-view" aria-label="Play library">${icon('play')}</button><button class="button quiet" data-action="shuffle-view">${icon('shuffle')}Shuffle</button><span class="small-note">Saved for offline listening</span></div>`;
  return html+trackRows(list);
}
function renderCollection() {
  const list=currentList(), isLiked=state.view==='liked', isAlbum=state.view==='album', p=playlist(state.detail);
  if(state.view==='playlist'&&!p) return header('Playlist not found','', 'YOUR MUSIC','new-playlist','Create playlist')+'<p class="view-meta">Choose another playlist from your library.</p>';
  const title=isLiked?'Liked songs':isAlbum?list[0]?.album||'Album':p.name;
  const art=isLiked?artwork(null,'lime','heart'):isAlbum?artwork(list.find(t=>t.artwork)||list[0],'','album'):collectionArt(p);
  let html=`<div class="collection-header">${art}<div><p class="eyebrow">${isAlbum?'ALBUM':'PLAYLIST'}</p><h1>${esc(title)}</h1><p class="view-meta">${isAlbum?`<span>${esc(list[0]?.artist||'')}</span>`:''}<span>${plural(list.length,'song')}</span>${totalDuration(list)?`<span>${totalDuration(list)}</span>`:''}</p></div></div><div class="collection-actions"><button class="play-circle" data-action="play-view" aria-label="Play ${esc(title)}" ${!list.length?'disabled':''}>${icon('play')}</button><button class="icon-button shuffle-control ${state.queue.shuffle?'active':''}" data-action="shuffle-view" aria-label="Shuffle ${esc(title)}" ${!list.length?'disabled':''}>${icon('shuffle')}</button>${p?`<button class="button quiet" data-action="edit-playlist-tracks" data-id="${p.id}">${icon('plus')}Add songs</button><button class="icon-button" data-action="playlist-menu" data-id="${p.id}" aria-label="Playlist options">${icon('more')}</button>`:''}${isLiked&&list.length?sortControl():''}</div>`;
  if(list.length)return html+trackRows(list);
  return html+`<div class="empty-small"><h2>${isLiked?'Keep your favorites close.':'Make it your own.'}</h2><p>${isLiked?'Tap the heart on any song to save it here.':'Add songs from your library to this playlist.'}</p><button class="button ${p?'primary':'quiet'}" ${p?`data-action="edit-playlist-tracks" data-id="${p.id}"`:'data-view="library"'}>${p?'Add songs':'Browse your library'}</button></div>`;
}
function renderPlaylists() {
  return header('Your playlists',`<span>${plural(state.playlists.length,'playlist')}</span>`,'MADE BY YOU','new-playlist','Create playlist')+`<div class="grid">${state.playlists.map(p=>`<button class="collection-card" data-view="playlist" data-id="${p.id}">${collectionArt(p)}<strong>${esc(p.name)}</strong><small>${plural(p.trackIds.length,'song')}</small></button>`).join('')}<button class="collection-card new-card" data-action="new-playlist"><span>${icon('plus')}<strong>Create a playlist</strong><small>Give your songs a place.</small></span></button></div>`;
}
function renderSettings() {
  const bytes=trackArray().reduce((sum,t)=>sum+t.size,0), info=state.storage;
  return header('Offline & settings','Everything for listening on this device.','SQUIDIFY',null)+`<div class="settings-grid"><section class="settings-card"><h2>Ready when you are</h2><div class="status-line">${icon(state.shellReady?'check':'download')}<span>${state.shellReady?'App available offline':'Offline app is not ready yet'}</span></div><p>${state.shellReady?'The app is saved in this browser. Imported music and playlists work without an internet connection.':'Open Squidify online once and keep it open until this status changes. Offline setup needs a secure browser connection.'}</p><div class="stat-line"><span>Saved songs</span><strong>${state.tracks.size}</strong></div><div class="stat-line"><span>Connection</span><strong>${navigator.onLine?'Online':'Offline'}</strong></div><button class="button" data-action="check-offline">${icon('check')}Check offline readiness</button><p class="small-note">After setup, try Airplane Mode and reopen the app before relying on it away from home.</p></section><section class="settings-card"><h2>On your Home Screen</h2>${standalone()?'<div class="status-line">'+icon('check')+'Running as an installed app</div>':''}<ol>${isIOS?'<li>Open this link in Safari.</li><li>Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Keep <strong>Open as Web App</strong> on if shown.</li>':'<li>Open this link in your regular browser.</li><li>Use the browser menu and choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>.</li>'}<li>Open Squidify from its new icon, then import your music there.</li></ol>${state.installPrompt?'<button class="button primary" data-action="install">Install Squidify</button>':''}<p class="small-note">Your browser tab and installed app may have separate storage. Set up your library inside the version you’ll use.</p></section><section class="settings-card"><h2>Music storage</h2><div class="stat-line"><span>Audio saved</span><strong>${formatBytes(bytes)}</strong></div>${info.quota?`<div class="stat-line"><span>Browser storage used</span><strong>${formatBytes(info.usage)} / ${formatBytes(info.quota)}</strong></div><div class="storage-bar"><span style="width:${Math.min(100,(info.usage||0)/info.quota*100)}%"></span></div>`:''}<div class="stat-line"><span>Storage protection</span><strong>${info.persistent?'Persistent storage granted':'Managed by your browser'}</strong></div><button class="button" data-action="persist">${icon('shield')}${info.persistent?'Check storage protection':'Request storage protection'}</button><p class="small-note">Keep your original music files. Clearing website data or removing the app can erase saved music and playlists. Browsers may also reclaim unprotected storage.</p></section><section class="settings-card"><h2>Local folders</h2><p>${'showDirectoryPicker' in window?'Folder connections can be remembered in this browser. Rescan to add new songs; existing copies and playlists stay intact.':'This browser uses file imports. Choose a folder if supported, or select multiple audio files. Saved copies stay available after you close the app.'}</p><button class="button primary" data-action="add-music">${icon('plus')}Add music</button>${state.folders.map(f=>`<div class="folder-row">${icon('folder')}<span>${esc(f.name)}</span><button class="button" data-action="rescan" data-id="${esc(f.id)}">Rescan</button><button class="icon-button" data-action="forget-folder" data-id="${esc(f.id)}" aria-label="Forget connection to ${esc(f.name)}">${icon('close')}</button></div>`).join('')}<p class="small-note">Choose files downloaded to your device. Cloud-only files need a connection before they can be imported.</p></section><section class="settings-card"><h2>Playback</h2><p>Balanced shuffle plays each queued song once and separates artists and albums where possible. Previous returns through the actual played order.</p><p>Lock Screen and headphone controls use your browser’s media support. Your phone can still pause or suspend browser playback in the background.</p><p class="small-note">MP3, AAC/M4A, WAV, FLAC, Ogg and other browser-supported audio. Codec support varies by device. Protected subscription downloads cannot be played.</p>${isIOS?'<p class="small-note">Use your phone’s volume buttons to adjust volume.</p>':''}</section><section class="settings-card"><h2>At your fingertips</h2><div class="key-help"><kbd>Space</kbd> Play / pause<br><kbd>←</kbd> <kbd>→</kbd> Seek 5 seconds<br><kbd>Shift</kbd> + <kbd>←</kbd> / <kbd>→</kbd> Previous / next<br><kbd>S</kbd> Balanced shuffle &nbsp; <kbd>L</kbd> Like song<br><kbd>/</kbd> Search your music</div><details><summary>About your music</summary><p>Squidify reads local audio and copies it into this app’s storage on this device. Your music is never sent to a server. Changes in Squidify do not modify the original files.</p></details></section></div>`;
}
function render() {
  if(state.pickerOpen)return;
  if(!state.ready)return;
  if(state.search || state.view==='library')main.innerHTML=renderLibrary();
  else if(['liked','playlist','album'].includes(state.view))main.innerHTML=renderCollection();
  else if(state.view==='playlists')main.innerHTML=renderPlaylists();
  else main.innerHTML=renderSettings();
  renderSidebar(); renderPlayer(); if(!$('#queuePanel').hidden)renderQueue();
}

function setModal(content, className = '') {
  // Keep the same input nodes alive when switching dialogs.
  $('#fileInputs').append(fileInput,folderInput);
  modal.className=`modal ${className}`; modal.innerHTML=content;
  if(!modal.open)modal.showModal();
}
const modalHead = title => `<div class="modal-head"><h2 id="modalTitle">${esc(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="Close">${icon('close')}</button></div>`;
function addMusicDialog() {
  if(state.busy)return toast('Finish the current import first.');
  setModal(modalHead('Add your music')+`<p>Choose a local folder or audio files. Squidify saves a copy on this device for offline playback.</p><label for="fileInput">Audio files</label><div id="filePickerSlot"></div><label for="folderInput">Music folder</label>${'showDirectoryPicker' in window?`<button type="button" class="import-choice" data-action="choose-folder">${icon('folder')}<span><strong>Connect a folder</strong><small>Include songs in its subfolders</small></span></button>`:'<div id="folderPickerSlot"></div>'}<p class="small-note">If folder selection is unavailable, choose audio files instead. For offline importing, files must already be downloaded to this device.</p>`);
  $('#filePickerSlot').append(fileInput);
  if(!('showDirectoryPicker' in window))$('#folderPickerSlot').append(folderInput);
}
function playlistForm(id = null, trackId = null) {
  const p=playlist(id);
  setModal(modalHead(p?'Rename playlist':'Create a playlist')+`<form id="playlistForm" data-id="${esc(id||'')}" data-track="${esc(trackId||'')}"><label for="playlistName">Playlist name</label><input class="text-input" id="playlistName" name="name" maxlength="100" placeholder="Late night listening" value="${esc(p?.name||'')}" required autofocus><div class="modal-actions"><button type="button" class="button" data-action="close-modal">Cancel</button><button type="submit" class="button primary">${p?'Save name':'Create playlist'}</button></div></form>`);
  $('#playlistName').focus();
}
async function savePlaylistForm(form) {
  const name=$('#playlistName').value.trim(); if(!name)return $('#playlistName').focus();
  const existing=playlist(form.dataset.id);
  const p=existing?{...existing,name}:{id:idToken(),name,trackIds:form.dataset.track?[form.dataset.track]:[],color:state.playlists.length%2?'lime':'purple',createdAt:Date.now()};
  await db.put('playlists',p);
  if(existing)state.playlists=state.playlists.map(x=>x.id===p.id?p:x);else state.playlists.push(p);
  modal.close();route('playlist',p.id);toast(existing?'Playlist renamed.':'Playlist created.');
}
function playlistPicker(trackId) {
  const t=byId(trackId);if(!t)return;
  setModal(modalHead('Add to playlist')+`<p>${esc(t.title)}</p><button class="menu-item" data-action="new-playlist" data-track="${t.id}">${icon('plus')}Create a new playlist</button><div class="playlist-picker">${state.playlists.map(p=>`<button class="playlist-option" data-action="add-to-playlist" data-id="${p.id}" data-track="${t.id}" ${p.trackIds.includes(t.id)?'disabled':''}>${collectionArt(p)}<span><strong>${esc(p.name)}</strong><small>${plural(p.trackIds.length,'song')}</small></span>${icon(p.trackIds.includes(t.id)?'check':'plus')}</button>`).join('')}</div>`);
}
async function addToPlaylist(id,trackId) {
  const p=playlist(id);if(!p||!byId(trackId))return;
  if(p.trackIds.includes(trackId))return toast('This song is already in the playlist.');
  const updated={...p,trackIds:[...p.trackIds,trackId]};await db.put('playlists',updated);Object.assign(p,updated);modal.close();render();toast(`Added to ${p.name}.`);
}
function editPlaylistTracks(id) {
  const p=playlist(id);if(!p)return;
  if(!state.tracks.size){modal.close();addMusicDialog();return;}
  const candidates=trackArray().filter(t=>!p.trackIds.includes(t.id)).sort((a,b)=>a.title.localeCompare(b.title));
  setModal(modalHead('Add songs')+`<p>Choose songs for ${esc(p.name)}.</p><input id="pickerSearch" class="text-input modal-search" type="search" placeholder="Find a song" aria-label="Find a song to add"><form id="addTracksForm" data-id="${p.id}"><div class="track-picker">${candidates.length?candidates.map(t=>`<label class="picker-track" data-search="${esc((t.title+' '+t.artist).toLowerCase())}"><input type="checkbox" name="track" value="${t.id}"><span><span class="song-title">${esc(t.title)}</span><span class="song-artist">${esc(t.artist)}</span></span></label>`).join(''):'<p>All library songs are already in this playlist.</p>'}</div><div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit" ${!candidates.length?'disabled':''}>Add selected songs</button></div></form>`);
}
function trackMenu(id) {
  const t=byId(id);if(!t)return;
  const p=state.view==='playlist'?playlist(state.detail):null;
  setModal(modalHead('Song options')+`<div class="menu-track">${artwork(t)}<div><span class="song-title">${esc(t.title)}</span><span class="song-artist">${esc(t.artist)}</span></div></div><button class="menu-item" data-action="like" data-id="${id}">${icon('heart')}${t.liked?'Remove from liked songs':'Add to liked songs'}</button><button class="menu-item" data-action="playlist-picker" data-id="${id}">${icon('plus')}Add to playlist</button><button class="menu-item" data-action="play-next" data-id="${id}">${icon('next')}Play next</button><button class="menu-item" data-action="add-queue" data-id="${id}">${icon('queue')}Add to queue</button>${p?`<hr class="menu-separator"><button class="menu-item" data-action="move-playlist-track" data-id="${id}" data-delta="-1" ${p.trackIds.indexOf(id)===0?'disabled':''}>${icon('up')}Move up in playlist</button><button class="menu-item" data-action="move-playlist-track" data-id="${id}" data-delta="1" ${p.trackIds.indexOf(id)===p.trackIds.length-1?'disabled':''}>${icon('down')}Move down in playlist</button><button class="menu-item" data-action="remove-playlist-track" data-id="${id}">${icon('close')}Remove from this playlist</button>`:''}<hr class="menu-separator"><button class="menu-item danger" data-action="confirm-remove-track" data-id="${id}">${icon('trash')}Remove from this device</button><p class="small-note">${esc(t.name)} · ${formatBytes(t.size)}</p>`);
}
function playlistMenu(id) {
  const p=playlist(id);if(!p)return;
  setModal(modalHead(p.name)+`<button class="menu-item" data-action="rename-playlist" data-id="${id}">${icon('edit')}Rename playlist</button><button class="menu-item" data-action="edit-playlist-tracks" data-id="${id}">${icon('plus')}Add songs</button><button class="menu-item" data-action="export-playlist" data-id="${id}">${icon('download')}Export playlist</button><hr class="menu-separator"><button class="menu-item danger" data-action="confirm-delete-playlist" data-id="${id}">${icon('trash')}Delete playlist</button>`);
}
async function toggleLike(id) {
  const t=byId(id);if(!t)return;
  const updated={...t,liked:!t.liked};await db.put('tracks',updated);state.tracks.set(id,updated);
  render();if(nowDialog.open)renderNowPlaying();if(modal.open)modal.close();
}

async function* walkFolder(handle,path='') {
  for await(const entry of handle.values()) {
    const next=path?`${path}/${entry.name}`:entry.name;
    if(entry.kind==='directory')yield*walkFolder(entry,next);
    else if(isAudio({name:entry.name,type:''}))yield{file:await entry.getFile(),path:next};
  }
}
async function chooseFolder() {
  if(state.busy)return toast('Finish the current import first.');
  if(!('showDirectoryPicker' in window)){openFilePicker(folderInput);return;}
  state.pickerOpen=true;
  try {
    const handle=await window.showDirectoryPicker({mode:'read',id:'squidify-music'});
    state.pickerOpen=false;
    let existing;
    for(const f of state.folders){try{if(await handle.isSameEntry(f.handle))existing=f;}catch{}}
    const folder=existing||{id:idToken(),name:handle.name,handle};
    try {await db.put('folders',folder);if(!existing)state.folders.push(folder);}catch{toast('Music can be imported, but this browser could not remember the folder connection.');}
    await importEntries(walkFolder(handle,handle.name),folder.id);
  } catch(error){if(error.name!=='AbortError')report(error,'Could not read that folder. Try Choose files instead.');}
  finally {state.pickerOpen=false;render();}
}
async function rescanFolder(id) {
  if(state.busy)return toast('Finish the current import first.');
  const f=state.folders.find(x=>x.id===id);if(!f)return;
  try{
    const permission=await f.handle.requestPermission({mode:'read'});
    if(permission!=='granted')return toast('Folder access was not granted. Saved music is still available.',true);
    await importEntries(walkFolder(f.handle,f.name),f.id);
  }catch(e){report(e,'Reconnect this folder using Add music. Existing songs are still saved.');}
}
function openFilePicker(input) {
  if(state.busy)return toast('Finish the current import first.');
  state.pickerOpen=true;
  // Stay within the user gesture, without closing dialogs or restoring focus.
  try {if(typeof input.showPicker==='function')input.showPicker();else input.click();}
  catch {try{input.click();}catch(e){state.pickerOpen=false;report(e,'Use Add music to choose files directly.');}}
}
function selectFiles() {openFilePicker(fileInput);}
async function importEntries(entries,folderId=null) {
  state.pickerOpen=false;
  if(state.busy)return;
  state.busy=true;state.stopImport=false;modal.close();
  const banner=$('#importBanner'),progress=$('#importProgress'),text=$('#importText');banner.hidden=false;progress.removeAttribute('value');
  text.textContent='Reading your music…';
  let added=0,skipped=0,failed=0,total=0,quota=false,firstTrack=null;
  try {
    // A persistence request is advisory; only successful IndexedDB commits count as saved songs.
    navigator.storage?.persist?.().catch(()=>false);
    for await(const entry of entries) {
      if(state.stopImport)break;
      const file=entry.file||entry;
      if(!isAudio(file)){skipped++;continue;}
      total++;text.textContent=`Saving ${file.name} · ${added} added`;
      try {
        const id=await fingerprint(file);
        if(state.tracks.has(id)){skipped++;continue;}
        const path=entry.path||file.webkitRelativePath||file.name;
        const tags=await readMetadata(file,path);
        const track={...tags,id,name:file.name,path,folderId,size:file.size,mime:mimeFor(file),addedAt:Date.now(),liked:false};
        const blob=new Blob([file],{type:track.mime});
        await db.saveTrack(track,blob);
        state.tracks.set(id,track);added++;firstTrack ||= id;
        if(!track.duration)metadataJobs.push({id,blob});
        if(added%8===0){render();await new Promise(resolve=>setTimeout(resolve,0));}
      } catch(e){if(e.name==='QuotaExceededError'){quota=true;break;}failed++;console.error('Import failed',file.name,e);}
    }
  }catch(e){failed++;console.error('Folder read interrupted',e);}
  finally{
    state.busy=false;banner.hidden=true;state.storage=await db.storageInfo();render();
    if(firstTrack&&!state.queue.current){state.queue.start(trackArray().map(t=>t.id),firstTrack,state.tracks,'Your library');await loadTrack(firstTrack,false);}
    let message=`${plural(added,'song')} saved`;
    if(skipped)message+=` · ${skipped} duplicate or non-audio file${skipped===1?'':'s'} skipped`;
    if(failed)message+=` · ${failed} could not be read`;
    if(state.stopImport)message+=' · import stopped';
    if(quota)message+=' · storage is full';
    toast(message+'.',quota||!!failed);
    if(!total&&!added&&!failed&&!skipped)toast('No audio files found in that folder.');
    runDurationJobs();saveSession();
  }
}
async function probeDuration(blob) {
  return new Promise(resolve=>{
    const probe=new Audio(); const url=URL.createObjectURL(blob);let timer;
    const done=value=>{clearTimeout(timer);probe.onloadedmetadata=null;probe.onerror=null;probe.removeAttribute('src');probe.load();URL.revokeObjectURL(url);resolve(value);};
    probe.preload='metadata';probe.onloadedmetadata=()=>done(Number.isFinite(probe.duration)&&probe.duration>0?probe.duration:undefined);probe.onerror=()=>done(undefined);
    timer=setTimeout(()=>done(undefined),1800);probe.src=url;
  });
}
async function runDurationJobs() {
  if(probing)return;probing=true;
  let consecutiveTimeouts=0;
  while(metadataJobs.length){
    const {id,blob}=metadataJobs.shift();if(!byId(id))continue;
    const duration=await probeDuration(blob);
    if(duration){const t=byId(id);if(t){t.duration=duration;await db.put('tracks',t).catch(()=>{});$$(`[data-duration-id="${id}"]`).forEach(el=>el.textContent=formatTime(duration));}consecutiveTimeouts=0;}
    else consecutiveTimeouts++;
    if(consecutiveTimeouts>=3){metadataJobs=[];break;}
  }
  probing=false;
}

async function mediaURL(id) {
  if(mediaURLs.has(id))return mediaURLs.get(id);
  if(mediaPromises.has(id))return mediaPromises.get(id);
  const promise=(async()=>{
    const item=await db.get('media',id);
    if(!item?.blob)throw new Error('This song is no longer saved on this device. Import the file again.');
    const url=URL.createObjectURL(item.blob);mediaURLs.set(id,url);
    for(const [key,value] of mediaURLs){if(mediaURLs.size<=4)break;if(key!==id&&key!==activeId&&key!==state.queue.order[state.queue.index+1]){URL.revokeObjectURL(value);mediaURLs.delete(key);}}
    return url;
  })();
  mediaPromises.set(id,promise);
  try{return await promise;}finally{mediaPromises.delete(id);}
}
function primeAudio() {
  if(audioUnlocked || priming)return;
  // Start the same media element within the tap so WebKit can continue after the disk read.
  const buffer=new ArrayBuffer(2044),v=new DataView(buffer);const write=(p,s)=>[...s].forEach((c,i)=>v.setUint8(p+i,c.charCodeAt(0)));
  write(0,'RIFF');v.setUint32(4,2036,true);write(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);write(36,'data');v.setUint32(40,2000,true);
  const url=URL.createObjectURL(new Blob([buffer],{type:'audio/wav'}));priming=true;audio.src=url;audio.play().then(()=>{audioUnlocked=true;}).catch(()=>{});setTimeout(()=>URL.revokeObjectURL(url),2000);
}
async function loadTrack(id,autoplay=true,restoreTime=0) {
  if(!byId(id))return;
  const generation=++playGeneration;playIntent=autoplay;
  if(autoplay)primeAudio();
  try {
    const url=await mediaURL(id);if(generation!==playGeneration||!byId(id)||state.queue.current!==id)return;
    priming=false;activeId=id;audio.src=url;
    const restore=()=>{if(generation===playGeneration&&restoreTime>0&&Number.isFinite(audio.duration))audio.currentTime=Math.min(restoreTime,Math.max(0,audio.duration-0.5));};
    audio.addEventListener('loadedmetadata',restore,{once:true});
    audio.load();renderPlayer();if(nowDialog.open)renderNowPlaying();highlightCurrent();if(!$('#queuePanel').hidden)renderQueue();updateMediaSession();saveSession();
    if(playIntent){try{await audio.play();}catch(e){if(generation===playGeneration&&e.name!=='AbortError'){playIntent=false;toast(e.name==='NotAllowedError'?'Tap Play to start listening.':'This browser could not play this audio format. Try MP3 or AAC/M4A.',true);}}}
    const next=state.queue.order[state.queue.index+1];if(next)mediaURL(next).catch(()=>{});
  }catch(e){if(generation!==playGeneration)return;priming=false;playIntent=false;audio.pause();toast(e.message||'Could not load this song. Import it again.',true);}
  renderPlayer();
}
function startView(startId=null,shuffle=false) {
  const list=currentList();if(!list.length)return addMusicDialog();
  if(shuffle)state.queue.shuffle=true;
  const id=startId || (state.queue.shuffle?list[Math.floor(Math.random()*list.length)].id:list[0].id);
  state.queue.start(list.map(t=>t.id),id,state.tracks,contextName());loadTrack(id,true);
}
async function togglePlay() {
  if(!state.tracks.size)return addMusicDialog();
  if(playIntent||!audio.paused){playIntent=false;audio.pause();return;}
  if(!state.queue.current)return startView();
  if(activeId!==state.queue.current||!audio.src)return loadTrack(state.queue.current,true);
  playIntent=true;
  try{await audio.play();}catch(e){playIntent=false;report(e,'Unable to play. Tap a song or try a different audio format.');}
}
function nextTrack(manual=true) {
  const id=state.queue.next(state.tracks,manual);
  if(!id){playIntent=false;audio.pause();renderPlayer();saveSession();return;}
  loadTrack(id,true);
}
function previousTrack() {
  if(audio.currentTime>3){audio.currentTime=0;updateProgress();return;}
  const id=state.queue.previous();if(id)loadTrack(id,true);
}
function toggleShuffle() {
  state.queue.setShuffle(!state.queue.shuffle,state.tracks);saveSession();renderPlayer();if(!$('#queuePanel').hidden)renderQueue();
  toast(state.queue.shuffle?'Balanced shuffle on. Every song once, artists spread out.':'Shuffle off.');
}
function cycleRepeat() {
  state.queue.repeat={off:'all',all:'one',one:'off'}[state.queue.repeat];saveSession();renderPlayer();toast({off:'Repeat off.',all:'Repeat queue on.',one:'Repeat song on.'}[state.queue.repeat]);
}
function highlightCurrent() {
  $$('[data-track-row]').forEach((row,i)=>{const current=row.dataset.trackRow===state.queue.current;row.classList.toggle('current',current);const button=$('.number-button',row);if(button)button.innerHTML=current?icon(!audio.paused&&!priming?'pause':'play'):i+1;});
}
function renderPlayer() {
  if(state.pickerOpen)return;
  const t=byId(state.queue.current),playing=!audio.paused&&!priming;
  $('#nowTitle').textContent=t?.title||'Nothing playing yet';$('#nowArtist').textContent=t?.artist||'Choose something from your library';
  const art=artwork(t);$('#nowArtwork').innerHTML=art.replace(/^<span[^>]+>/,'').replace(/<\/span>$/,'');
  $('#playerLike').disabled=!t;$('#playerLike').classList.toggle('liked',!!t?.liked);$('#playerLike').setAttribute('aria-label',t?.liked?'Unlike current song':'Like current song');
  $$('[data-action="toggle-play"]').forEach(b=>{b.innerHTML=icon(playing?'pause':'play');b.setAttribute('aria-label',playing?'Pause':'Play');});
  $$('.shuffle-control').forEach(b=>{b.classList.toggle('active',state.queue.shuffle);b.setAttribute('aria-pressed',String(state.queue.shuffle));if(b.dataset.action==='shuffle')b.setAttribute('aria-label',state.queue.shuffle?'Disable balanced shuffle':'Enable balanced shuffle');});
  $$('.repeat-control').forEach(b=>{b.classList.toggle('active',state.queue.repeat!=='off');b.setAttribute('aria-label',`Repeat ${state.queue.repeat}`);b.title=`Repeat ${state.queue.repeat}`;const one=$('b',b);if(one)one.hidden=state.queue.repeat!=='one';});
  $$('[data-action="next"],[data-action="previous"]').forEach(b=>b.disabled=!t);
  $('#muteButton').innerHTML=icon(audio.muted?'muted':'volume');$('#muteButton').setAttribute('aria-label',audio.muted?'Unmute':'Mute');
  $('#volumeInput').value=audio.muted?0:audio.volume;$('#volumeInput').style.setProperty('--pct',`${(audio.muted?0:audio.volume)*100}%`);
  highlightCurrent();updateProgress();
}
function updateProgress() {
  if(state.pickerOpen)return;
  const duration=activeId===state.queue.current&&Number.isFinite(audio.duration)&&!priming?audio.duration:byId(state.queue.current)?.duration||0;
  const current=activeId===state.queue.current&&!priming?audio.currentTime||0:0;
  $$('.elapsed').forEach(el=>el.textContent=formatTime(current));$$('.duration').forEach(el=>el.textContent=duration?formatTime(duration):'0:00');
  $$('[data-seek]').forEach(el=>{if(el.dataset.dragging)return;el.disabled=!duration||!audio.src;el.max=duration||100;el.value=current;el.style.setProperty('--pct',`${duration?current/duration*100:0}%`);el.setAttribute('aria-valuetext',`${formatTime(current)} of ${formatTime(duration||0)}`);});
  updatePositionState();
}
function renderNowPlaying() {
  const t=byId(state.queue.current);if(!t)return;
  nowDialog.innerHTML=`<div class="now-top"><button class="icon-button" data-action="close-now" aria-label="Close now playing">${icon('down')}</button><p>${esc(state.queue.context)}</p><button class="icon-button" data-action="current-menu" aria-label="Song options">${icon('more')}</button></div>${artwork(t,'full-art')}<div class="full-title-row"><div><h2 id="fullTitle">${esc(t.title)}</h2><p>${esc(t.artist)}</p></div><button class="icon-button like-button ${t.liked?'liked':''}" data-action="like-current" aria-label="${t.liked?'Unlike':'Like'} song" aria-pressed="${!!t.liked}">${icon('heart')}</button></div><div class="scrubber"><span class="time elapsed">0:00</span><input data-seek type="range" min="0" max="100" step=".1" value="0" aria-label="Playback position"><span class="time duration">0:00</span></div><div class="playback-buttons"><button class="icon-button shuffle-control" data-action="shuffle" aria-label="Balanced shuffle">${icon('shuffle')}</button><button class="icon-button" data-action="previous" aria-label="Previous song">${icon('previous')}</button><button class="main-play" data-action="toggle-play" aria-label="Play">${icon('play')}</button><button class="icon-button" data-action="next" aria-label="Next song">${icon('next')}</button><button class="icon-button repeat-control" data-action="repeat" aria-label="Repeat off">${icon('repeat')}<b hidden>1</b></button></div><div class="now-footer"><span>${icon('download')}Saved on this device</span><button class="icon-button" data-action="queue" aria-label="Open queue">${icon('queue')}</button></div>`;
  renderPlayer();
}
function renderQueue() {
  const panel=$('#queuePanel'),q=state.queue,current=byId(q.current);
  const item=(id,i,now=false)=>{const t=byId(id);if(!t)return '';return `<div class="queue-item ${now?'current':''}"><button class="track-cell" data-action="queue-jump" data-index="${i}">${artwork(t)}<span class="track-text"><span class="song-title">${esc(t.title)}</span><span class="song-artist">${esc(t.artist)}</span></span></button>${!now?`<button class="icon-button" data-action="queue-up" data-index="${i}" aria-label="Move ${esc(t.title)} earlier" ${i===q.index+1?'disabled':''}>${icon('up')}</button><button class="icon-button" data-action="queue-remove" data-index="${i}" aria-label="Remove ${esc(t.title)} from queue">${icon('close')}</button>`:''}</div>`;};
  panel.innerHTML=`<div class="panel-head"><h2>Queue</h2><button class="icon-button" data-action="queue" aria-label="Close queue">${icon('close')}</button></div>${current?`<p class="queue-heading">Now playing</p>${item(current.id,q.index,true)}<p class="queue-heading">Up next · ${Math.max(0,q.order.length-q.index-1)}</p><p class="queue-description">${esc(q.context)}${q.shuffle?' · Balanced shuffle':''}</p>${q.order.slice(q.index+1).map((id,i)=>item(id,q.index+1+i)).join('')||'<p class="queue-description">You’re at the end of the queue.</p>'}<div class="queue-controls"><button class="button" data-action="clear-queue">Clear upcoming</button><button class="button" data-action="save-queue">Save as playlist</button></div>`:'<p class="queue-description">Play a song to start a queue. Add more from any song’s menu.</p>'}`;
}
function updateMediaSession() {
  if(!('mediaSession' in navigator))return;
  const t=byId(state.queue.current);if(!t)return;
  try{
    let art=artworkURLs.get(t.id);if(!art&&t.artwork){art=URL.createObjectURL(t.artwork);artworkURLs.set(t.id,art);}
    navigator.mediaSession.metadata=new MediaMetadata({title:t.title,artist:t.artist,album:t.album,artwork:art?[{src:art,type:t.artwork.type}]:[{src:new URL('./icon-512.png',location.href).href,sizes:'512x512',type:'image/png'}]});
  }catch{}
}
function updatePositionState() {
  if(!navigator.mediaSession?.setPositionState||priming)return;
  if(Number.isFinite(audio.duration)&&audio.duration>0){try{navigator.mediaSession.setPositionState({duration:audio.duration,playbackRate:audio.playbackRate,position:Math.min(audio.currentTime,audio.duration)});}catch{}}
}
function saveSession(immediate=false) {
  clearTimeout(stateTimer);
  const write=()=>db.setSetting('session',{queue:state.queue.toJSON(),time:activeId===state.queue.current?audio.currentTime||0:0,volume:audio.volume,muted:audio.muted,sort:state.sort}).catch(()=>{});
  if(immediate)write();else stateTimer=setTimeout(write,250);
}

async function checkOffline(repair=false) {
  let ready=false;
  try{
    const registration=await navigator.serviceWorker?.getRegistration('./');
    if(registration?.active){
      ready=await new Promise(resolve=>{const channel=new MessageChannel();const timeout=setTimeout(()=>{channel.port1.close();resolve(false);},repair?15000:2000);channel.port1.onmessage=e=>{clearTimeout(timeout);resolve(!!e.data?.ready);channel.port1.close();};registration.active.postMessage({type:repair&&navigator.onLine?'REPAIR_OFFLINE':'CHECK_OFFLINE'},[channel.port2]);});
    }
  }catch{}
  state.shellReady=ready;renderOfflineBadge();if(state.view==='settings')render();return ready;
}
function renderOfflineBadge() {
  const badge=$('#offlineBadge');badge.classList.toggle('ready',state.shellReady);
  badge.innerHTML=icon(state.shellReady?'check':'download')+`<span>${state.shellReady?(navigator.onLine?'Offline ready':'Listening offline'):'Offline setup'}</span>`;
}
async function setupOffline() {
  if(!('serviceWorker' in navigator)){renderOfflineBadge();return;}
  try{
    const reg=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});
    navigator.serviceWorker.ready.then(()=>checkOffline());
    navigator.serviceWorker.addEventListener('controllerchange',()=>checkOffline());
    if(reg.active)checkOffline();
  }catch(e){console.error('Offline setup unavailable',e);renderOfflineBadge();}
}

const actions = {
  'add-music':()=>addMusicDialog(), 'choose-folder':()=>chooseFolder(), 'choose-files':()=>selectFiles(),
  'close-modal':()=>modal.close(), 'close-now':()=>nowDialog.close(), 'cancel-import':()=>{state.stopImport=true;},
  'new-playlist':b=>playlistForm(null,b.dataset.track), 'rename-playlist':b=>playlistForm(b.dataset.id), 'playlist-picker':b=>playlistPicker(b.dataset.id),
  'add-to-playlist':b=>addToPlaylist(b.dataset.id,b.dataset.track), 'edit-playlist-tracks':b=>editPlaylistTracks(b.dataset.id),
  'track-menu':b=>trackMenu(b.dataset.id), 'playlist-menu':b=>playlistMenu(b.dataset.id),
  'current-menu':()=>{nowDialog.close();trackMenu(state.queue.current);},
  'like':b=>toggleLike(b.dataset.id), 'like-current':()=>toggleLike(state.queue.current),
  'play-track':b=>{if(state.queue.current===b.dataset.id)togglePlay();else startView(b.dataset.id);},
  'play-view':()=>startView(), 'shuffle-view':()=>startView(null,true), 'toggle-play':()=>togglePlay(), 'previous':()=>previousTrack(), 'next':()=>nextTrack(),
  'shuffle':()=>toggleShuffle(), 'repeat':()=>cycleRepeat(),
  'mute':()=>{audio.muted=!audio.muted;renderPlayer();saveSession();},
  'tab':b=>{state.tab=b.dataset.tab;render();},
  'now-playing':()=>{if(!state.queue.current)return;renderNowPlaying();nowDialog.showModal();},
  'queue':()=>{nowDialog.close();const panel=$('#queuePanel');panel.hidden=!panel.hidden;if(!panel.hidden){renderQueue();$('.panel-head button',panel).focus();}},
  'play-next':b=>{state.queue.add(b.dataset.id,true);modal.close();saveSession();if(!$('#queuePanel').hidden)renderQueue();toast('Added to play next.');},
  'add-queue':b=>{state.queue.add(b.dataset.id);modal.close();saveSession();if(!$('#queuePanel').hidden)renderQueue();toast('Added to queue.');},
  'queue-jump':b=>{const i=Number(b.dataset.index);if(!Number.isInteger(i)||!byId(state.queue.order[i]))return;state.queue.index=i;loadTrack(state.queue.current,true);},
  'queue-remove':b=>{state.queue.removeAt(Number(b.dataset.index));saveSession();renderQueue();},
  'queue-up':b=>{const i=Number(b.dataset.index),q=state.queue;if(i<=q.index+1||i>=q.order.length)return;[q.order[i-1],q.order[i]]=[q.order[i],q.order[i-1]];saveSession();renderQueue();},
  'clear-queue':()=>{state.queue.order=state.queue.order.slice(0,state.queue.index+1);state.queue.source=[...new Set(state.queue.order)];saveSession();renderQueue();},
  'save-queue':async()=>{const ids=[...new Set(state.queue.order)].filter(id=>byId(id));if(!ids.length)return;const p={id:idToken(),name:`Queue ${new Date().toLocaleDateString()}`,trackIds:ids,color:'purple',createdAt:Date.now()};await db.put('playlists',p);state.playlists.push(p);render();toast('Queue saved as a playlist.');},
  'move-playlist-track':async b=>{const p=playlist(state.detail);if(!p)return;const ids=[...p.trackIds],i=ids.indexOf(b.dataset.id),j=i+Number(b.dataset.delta);if(i<0||j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];await db.put('playlists',{...p,trackIds:ids});p.trackIds=ids;modal.close();render();},
  'remove-playlist-track':async b=>{const p=playlist(state.detail);if(!p)return;const ids=p.trackIds.filter(id=>id!==b.dataset.id);await db.put('playlists',{...p,trackIds:ids});p.trackIds=ids;modal.close();render();toast('Removed from playlist.');},
  'confirm-delete-playlist':b=>{const p=playlist(b.dataset.id);if(!p)return;setModal(modalHead('Delete this playlist?')+`<p>Delete ${esc(p.name)}? Your songs will stay in your library.</p><div class="modal-actions"><button class="button" data-action="close-modal">Cancel</button><button class="button danger" data-action="delete-playlist" data-id="${p.id}">Delete playlist</button></div>`);},
  'delete-playlist':async b=>{await db.remove('playlists',b.dataset.id);state.playlists=state.playlists.filter(p=>p.id!==b.dataset.id);modal.close();route('playlists');toast('Playlist deleted.');},
  'confirm-remove-track':b=>{const t=byId(b.dataset.id);if(!t)return;setModal(modalHead('Remove this song?')+`<p>Remove ${esc(t.title)} from Squidify and all its playlists? The original audio file will stay untouched.</p><div class="modal-actions"><button class="button" data-action="close-modal">Cancel</button><button class="button danger" data-action="remove-track" data-id="${t.id}">Remove song</button></div>`);},
  'remove-track':async b=>{const id=b.dataset.id;await db.deleteTrack(id);if(id===activeId){playGeneration++;playIntent=false;audio.pause();audio.removeAttribute('src');audio.load();activeId=null;}state.tracks.delete(id);state.playlists.forEach(p=>{p.trackIds=p.trackIds.filter(x=>x!==id);});state.queue.prune(new Set(state.tracks.keys()));if(mediaURLs.has(id)){URL.revokeObjectURL(mediaURLs.get(id));mediaURLs.delete(id);}if(artworkURLs.has(id)){URL.revokeObjectURL(artworkURLs.get(id));artworkURLs.delete(id);}modal.close();render();saveSession();toast('Song removed from this device.');},
  'rescan':b=>rescanFolder(b.dataset.id),
  'forget-folder':async b=>{await db.remove('folders',b.dataset.id);state.folders=state.folders.filter(f=>f.id!==b.dataset.id);render();toast('Folder connection forgotten. Saved songs are unchanged.');},
  'persist':async()=>{const granted=await navigator.storage?.persist?.().catch(()=>false);state.storage=await db.storageInfo();render();toast(granted?'Storage protection granted.':"Your browser decides storage protection. Installing Squidify may help.");},
  'check-offline':async()=>{const ready=await checkOffline(true);state.storage=await db.storageInfo();render();toast(ready?'The app is cached. Imported songs are saved on this device.':'Offline setup is incomplete. Open the app online in your regular browser.',!ready);},
  'install':async()=>{if(!state.installPrompt)return;await state.installPrompt.prompt();await state.installPrompt.userChoice;state.installPrompt=null;render();},
  'export-playlist':b=>{const p=playlist(b.dataset.id);if(!p)return;const content='#EXTM3U\n'+p.trackIds.map(byId).filter(Boolean).map(t=>`#EXTINF:${Math.round(t.duration||-1)},${(t.artist+' - '+t.title).replace(/[\r\n]/g,' ')}\n${t.path.replace(/[\r\n]/g,' ')}`).join('\n');const url=URL.createObjectURL(new Blob([content],{type:'audio/x-mpegurl;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=p.name.replace(/[^\w -]/g,'').slice(0,80)+'.m3u';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);modal.close();toast('Playlist exported. Audio files are not included.');}
};

document.addEventListener('click',event=>{
  if(event.target===fileInput||event.target===folderInput){
    if(state.busy){event.preventDefault();toast('Finish the current import first.');return;}
    state.pickerOpen=true;return;
  }
  const button=event.target.closest('[data-action],[data-view]');if(!button||button.disabled)return;
  event.preventDefault();
  if(button.dataset.view){route(button.dataset.view,button.dataset.id||'');return;}
  const action=actions[button.dataset.action];if(action)Promise.resolve(action(button)).catch(e=>report(e));
});
document.addEventListener('submit',event=>{
  if(event.target.id==='playlistForm'){event.preventDefault();savePlaylistForm(event.target).catch(e=>report(e,'Could not save the playlist. Your name is still here; try again.'));}
  if(event.target.id==='addTracksForm'){
    event.preventDefault();const form=event.target,p=playlist(form.dataset.id);if(!p)return;
    const ids=new FormData(form).getAll('track').filter(id=>byId(id));if(!ids.length)return toast('Select at least one song.');
    const next={...p,trackIds:[...new Set([...p.trackIds,...ids])]};
    db.put('playlists',next).then(()=>{Object.assign(p,next);modal.close();render();toast(`${plural(ids.length,'song')} added.`);}).catch(e=>report(e));
  }
});
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.id==='searchInput'){state.search=el.value;render();}
  if(el.id==='pickerSearch')$$('.picker-track',modal).forEach(row=>{row.hidden=!row.dataset.search.includes(el.value.toLowerCase().trim());});
  if(el.id==='volumeInput'){audio.volume=Number(el.value);audio.muted=false;el.style.setProperty('--pct',`${audio.volume*100}%`);saveSession();}
  if(el.matches('[data-seek]')){const value=Number(el.value);if(Number.isFinite(audio.duration)){audio.currentTime=Math.min(value,audio.duration);updateProgress();saveSession();}}
});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.id==='sortSelect'){state.sort=el.value;render();saveSession();}
  if(el===fileInput||el===folderInput){state.pickerOpen=false;const files=[...el.files];el.value='';if(files.length)importEntries(files.map(file=>({file,path:file.webkitRelativePath||file.name}))).catch(e=>report(e));else render();}
});
document.addEventListener('cancel',event=>{if(event.target===fileInput||event.target===folderInput){state.pickerOpen=false;render();}});
// Older browsers may omit the file-input cancel event. The next page interaction
// safely ends that pending state; blur/focus alone must not dismiss a live picker.
document.addEventListener('pointerdown',event=>{if(state.pickerOpen&&event.target!==fileInput&&event.target!==folderInput){state.pickerOpen=false;}});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!$('#queuePanel').hidden){$('#queuePanel').hidden=true;return;}
  if(modal.open||['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)||event.target.isContentEditable||event.altKey||event.ctrlKey||event.metaKey)return;
  if(event.key===' '&&event.target.closest('button,a'))return;
  if(event.key===' '){event.preventDefault();togglePlay();}
  if(event.key==='ArrowRight'){event.preventDefault();if(event.shiftKey)nextTrack();else if(Number.isFinite(audio.duration))audio.currentTime=Math.min(audio.duration,audio.currentTime+5);}
  if(event.key==='ArrowLeft'){event.preventDefault();if(event.shiftKey)previousTrack();else if(audio.src)audio.currentTime=Math.max(0,audio.currentTime-5);}
  if(event.key.toLowerCase()==='s')toggleShuffle();
  if(event.key.toLowerCase()==='l')toggleLike(state.queue.current).catch(report);
  if(event.key==='/'){event.preventDefault();$('#searchInput').focus();}
});
window.addEventListener('hashchange',readRoute);
window.addEventListener('online',renderOfflineBadge);window.addEventListener('offline',renderOfflineBadge);
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.installPrompt=e;if(state.view==='settings')render();});
window.addEventListener('appinstalled',()=>{state.installPrompt=null;toast('Squidify installed. Open it from your Home Screen.');if(state.view==='settings')render();});
window.addEventListener('pagehide',()=>saveSession(true));
document.addEventListener('visibilitychange',()=>{if(document.hidden)saveSession(true);else if(!state.pickerOpen){renderPlayer();if(nowDialog.open)renderNowPlaying();}});
audio.addEventListener('play',()=>{audioUnlocked=true;if(priming)return;playIntent=true;renderPlayer();if(navigator.mediaSession)navigator.mediaSession.playbackState='playing';});
audio.addEventListener('pause',()=>{if(priming)return;playIntent=false;renderPlayer();saveSession();if(navigator.mediaSession)navigator.mediaSession.playbackState='paused';});
audio.addEventListener('ended',()=>{if(!priming)nextTrack(false);});
audio.addEventListener('timeupdate',()=>{if(priming)return;updateProgress();if(Date.now()-lastSavedAt>5000){lastSavedAt=Date.now();saveSession();}});
audio.addEventListener('loadedmetadata',()=>{if(priming)return;const t=byId(activeId);if(t&&Number.isFinite(audio.duration)&&audio.duration>0){t.duration=audio.duration;db.put('tracks',t).catch(()=>{});$$(`[data-duration-id="${t.id}"]`).forEach(el=>el.textContent=formatTime(t.duration));}updateProgress();});
audio.addEventListener('error',()=>{if(priming||!audio.getAttribute('src'))return;playIntent=false;renderPlayer();toast('This file cannot be played in this browser. Try another song or an MP3/AAC copy.',true);});
audio.addEventListener('volumechange',()=>{renderPlayer();saveSession();});

// File drops stay local and use exactly the same import path as the file picker.
let dragDepth=0;
document.addEventListener('dragenter',e=>{if(!e.dataTransfer?.types.includes('Files'))return;e.preventDefault();dragDepth++;if(!$('.drag-overlay')){const overlay=document.createElement('div');overlay.className='drag-overlay';overlay.textContent='Drop your music here';document.body.append(overlay);}});
document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault();});
document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('.drag-overlay')?.remove();}});
document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('.drag-overlay')?.remove();if(state.busy)return toast('Finish the current import first.');const files=[...(e.dataTransfer?.files||[])];if(files.length)importEntries(files.map(file=>({file}))).catch(report);});

async function init() {
  paintIcons();
  try{
    const [tracks,playlists,folders,saved]=await Promise.all([db.all('tracks'),db.all('playlists'),db.all('folders'),db.setting('session',{})]);
    state.tracks=new Map(tracks.map(t=>[t.id,t]));state.playlists=playlists;state.folders=folders;state.queue=new PlayQueue(saved.queue);state.queue.prune(new Set(state.tracks.keys()));state.sort=saved.sort||'added';
    audio.volume=typeof saved.volume==='number'?Math.min(1,Math.max(0,saved.volume)):1;audio.muted=!!saved.muted;
    state.storage=await db.storageInfo();state.ready=true;readRoute();
    if(state.queue.current)await loadTrack(state.queue.current,false,saved.time||0);
    setupOffline();
    if('mediaSession' in navigator){const handlers={play:()=>{if(audio.paused)togglePlay();},pause:()=>{playIntent=false;audio.pause();},previoustrack:()=>previousTrack(),nexttrack:()=>nextTrack(),seekto:d=>{if(Number.isFinite(audio.duration))audio.currentTime=Math.min(audio.duration,Math.max(0,d.seekTime));},seekbackward:d=>{audio.currentTime=Math.max(0,audio.currentTime-(d.seekOffset||10));},seekforward:d=>{if(Number.isFinite(audio.duration))audio.currentTime=Math.min(audio.duration,audio.currentTime+(d.seekOffset||10));},stop:()=>{audio.pause();audio.currentTime=0;}};for(const [name,handler]of Object.entries(handlers))try{navigator.mediaSession.setActionHandler(name,handler);}catch{}}
    registerTools();
  }catch(e){console.error(e);main.innerHTML=header('Storage is unavailable','','SQUIDIFY',null)+'<p class="inline-alert">Squidify needs permission to save music in this browser. Try a regular browser window, allow website storage, then reload.</p><button class="button" onclick="location.reload()">Reload Squidify</button>';toast('Could not open local storage.',true);setupOffline();}
}
function registerTools() {
  const context=document.modelContext;if(!context?.registerTool)return;
  const lifecycle=new AbortController();
  const register=tool=>{try{Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}};
  register({name:'read_music_library',description:'Read locally imported music metadata and playlists. Does not read or transmit audio files.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:()=>({tracks:trackArray().map(t=>({id:t.id,title:t.title,artist:t.artist,album:t.album,liked:!!t.liked})),playlists:state.playlists.map(p=>({id:p.id,name:p.name,trackIds:p.trackIds})),currentTrackId:state.queue.current})});
  register({name:'create_music_playlist',description:'Create a local playlist from existing track IDs and show it in Squidify.',inputSchema:{type:'object',properties:{name:{type:'string',minLength:1,maxLength:100},trackIds:{type:'array',items:{type:'string'}}},required:['name','trackIds'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},execute:async input=>{if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>100||!Array.isArray(input.trackIds)||input.trackIds.some(id=>typeof id!=='string'||!byId(id)))throw new Error('Use a nonempty name of up to 100 characters and existing track IDs.');const p={id:idToken(),name:input.name.trim(),trackIds:[...new Set(input.trackIds)],color:'purple',createdAt:Date.now()};await db.put('playlists',p);state.playlists.push(p);route('playlist',p.id);render();return{id:p.id,name:p.name,songCount:p.trackIds.length};}});
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
init();
