import { createMotion, createSearchScroll, createPlayerMotion, measureTitleMarquees } from './motion.js';
import { bindGestures } from './gestures.js';
import * as db from './storage.js';
import { formatTime, formatBytes, escapeHTML as esc } from './core.js';
import { icon, mark } from './icons.js';
import { RELEASE_LABEL } from './release.js';

export function createInterface(context) {
  const { $, $$, main, audio, modal, nowDialog, fileInput, folderInput, state, isIOS, standalone, trackArray, byId, playlist, plural, totalDuration } = context;
  const playback = context.playback;
  const motion = createMotion(main);
  const searchScroll=createSearchScroll(),playerMotion=createPlayerMotion(nowDialog);
  let routeKey;
  let titleFrame=0;
  function refreshTitleMarquees(){
    if(typeof requestAnimationFrame!=='function'){measureTitleMarquees(document);return;}
    if(titleFrame)return;
    titleFrame=requestAnimationFrame(()=>{titleFrame=0;measureTitleMarquees(document);});
  }
  window.addEventListener('resize',refreshTitleMarquees);
  document.fonts?.ready.then(refreshTitleMarquees);
  const toggleLike = (...args) => context.playlists.toggleLike(...args);
  const chooseFolder = (...args) => context.importer.chooseFolder(...args);
  const selectFiles = (...args) => context.importer.selectFiles(...args);
  const togglePlay = (...args) => context.playback.togglePlay(...args);
  const nextTrack = (...args) => context.playback.nextTrack(...args);
  const previousTrack = (...args) => context.playback.previousTrack(...args);
  const toggleShuffle = (...args) => context.playback.toggleShuffle(...args);
  const updatePositionState = (...args) => context.playback.updatePositionState(...args);
  const saveSession = (...args) => context.playback.saveSession(...args);
  const checkOffline = (...args) => context.offline.checkOffline(...args);
  const artworkURLs = new Map();
  let toastTimer;

  function toast(message, error = false, duration) {
    clearTimeout(toastTimer);
    const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false;try{el.showPopover?.();}catch{}
    toastTimer = setTimeout(() => { el.hidden = true;try{el.hidePopover?.();}catch{} }, duration || (error ? 6500 : 4500));
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
    if(p?.artwork)return artwork({...p,id:'playlist:'+p.id},extra);
    // Stable per-playlist folds: different covers without saved image blobs.
    let seed=0;for(const char of p?.id||'playlist')seed=(Math.imul(seed,31)+char.charCodeAt(0))>>>0;
    const angle=seed%360,delay=-(seed%190)/10,duration=16+seed%13;
    return `<span class="artwork playlist-art ${extra}" aria-hidden="true" style="--fold-angle:${angle}deg;--fold-delay:${delay}s;--fold-duration:${duration}s;--fold-x:${25+seed%50}%"><i class="fold-sheet"></i><i class="fold-glint"></i></span>`;
  }
  function route(name, id = '') {
    state.search = ''; $('#searchInput').value = '';
    const hash = `#${name}${id ? '/'+encodeURIComponent(id) : ''}`;
    if (location.hash !== hash) location.hash = hash;
    else readRoute();
  }
  function readRoute() {
    const [name, ...parts] = location.hash.slice(1).split('/');
    const view = ['library','liked','playlists','playlist','album','settings'].includes(name) ? name : 'library';
    let detail;try { detail=decodeURIComponent(parts.join('/')); } catch { detail=''; }
    const nextKey=view+'/'+detail;
    const commit=()=>{
      state.view=view;state.detail=detail;state.search='';$('#searchInput').value='';
      searchScroll.reset();document.body.dataset.view=view;document.body.classList.remove('search-visible');render();main.scrollTop=0;window.scrollTo({top:0});routeKey=nextKey;
    };
    motion.change(commit);
  }
  function currentList() {
    let list;
    if (state.search) {
      const query = state.search.toLowerCase().trim();
      list = (state.view==='playlist' ? (playlist(state.detail)?.trackIds||[]).map(byId).filter(Boolean) : trackArray()).filter(t => `${t.title} ${t.artist} ${t.album} ${t.name}`.toLowerCase().includes(query));
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
  function viewKey(){return [state.view,state.detail||'',state.search||''].join('|');}
  function contextName() {
    if (state.search) return `Search: ${state.search}`;
    if (state.view === 'liked') return 'Liked songs';
    if (state.view === 'playlist') return playlist(state.detail)?.name || 'Playlist';
    if (state.view === 'album') return currentList()[0]?.album || 'Album';
    return 'Your library';
  }
  function renderSidebar() {
    $('#likedCount').textContent = trackArray().filter(t=>t.liked).length;
    $('#sidebarPlaylists').innerHTML = state.playlists.length ? state.playlists.map(p=>`<button class="sidebar-playlist ${state.view==='playlist'&&state.detail===p.id?'active':''}" data-view="playlist" data-playlist-id="${esc(p.id)}" data-id="${esc(p.id)}">${collectionArt(p)}<span><strong>${esc(p.name)}</strong><small>${plural(p.trackIds.length,'song')}</small></span></button>`).join('') : '';
    $$('button[data-view],a[data-view]').forEach(el=> { const selected = !state.search && el.dataset.view === state.view && (!el.dataset.id || el.dataset.id === state.detail); el.classList.toggle('active',selected); if(selected)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current'); });
  }
  function header(title,meta,eyebrow='ON THIS DEVICE', action='add-music',label='Add music') {
    return `<div class="view-header"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1>${meta?`<p class="view-meta">${meta}</p>`:''}</div>${action?`<button class="button quiet" data-action="${action}">${icon('plus')}<span class="button-label">${label}</span></button>`:''}</div>`;
  }
  function sortControl() {
    return `<label class="sort-label">${icon('list')}<select id="sortSelect" aria-label="Sort songs">${[['added','Recently added'],['title','Title'],['artist','Artist'],['album','Album']].map(([v,l])=>`<option value="${v}" ${state.sort===v?'selected':''}>${l}</option>`).join('')}</select>${icon('down')}</label>`;
  }
  function trackRows(list) {
    return `<div class="track-list"><table class="track-table"><thead><tr><th class="num">#</th><th class="title-col">Title</th><th class="album-col">Album</th><th class="like-col"><span class="sr-only">Liked</span></th><th class="duration-col" aria-label="Duration">${icon('clock')}</th><th class="more-col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${list.map((t,i)=>`<tr data-track-row="${t.id}" class="${state.queue.current===t.id?'current':''}"><td class="number-cell"><button class="number-button" data-action="play-track" data-id="${t.id}" aria-label="Play ${esc(t.title)}">${state.queue.current===t.id?icon(!audio.paused?'pause':'play'):i+1}</button></td><td><button class="track-cell" data-action="play-track" data-id="${t.id}">${artwork(t)}<span class="track-text"><span class="song-title">${esc(t.title)}</span><span class="song-artist">${esc(t.artist)}</span></span></button></td><td class="album-cell"><button class="album-text" data-view="album" data-id="${esc(albumKey(t))}">${esc(t.album)}</button></td><td class="table-like"><button class="icon-button like-button ${t.liked?'liked':''}" data-action="like" data-id="${t.id}" aria-label="${t.liked?'Unlike':'Like'} ${esc(t.title)}" aria-pressed="${!!t.liked}">${icon('heart')}</button></td><td class="duration-cell" data-duration-id="${t.id}">${formatTime(t.duration)}</td><td><button class="icon-button" data-action="track-menu" data-id="${t.id}" aria-label="Actions for ${esc(t.title)}">${icon('vertical')}</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  function emptyLibrary() {
    return `<section class="empty-library"><div class="empty-icon">${icon('folder')}</div><h2>Your music belongs here.</h2><p>Connect a folder or choose audio files to start your library.</p><div class="actions-row"><button class="button primary" data-action="choose-folder">${icon('folder')}Choose a folder</button><button class="button" data-action="choose-files">${icon('plus')}Choose files</button></div><p class="empty-footer">${icon('shield')}Music stays on your device. No uploads. No account for your music.</p></section>`;
  }
  function playlistTiles() {
    return state.playlists.map(p=>`<div class="playlist-tile" data-playlist-id="${esc(p.id)}"><button class="collection-card" data-view="playlist" data-id="${esc(p.id)}">${collectionArt(p)}<strong>${esc(p.name)}</strong><small>${plural(p.trackIds.length,'song')}</small></button><button class="icon-button tile-menu" data-action="playlist-menu" data-id="${esc(p.id)}" aria-label="Options for ${esc(p.name)}">${icon('vertical')}</button></div>`).join('');
  }
  function positionMenu(anchor) {
    if (!anchor?.getBoundingClientRect) return;
    const rect=anchor.getBoundingClientRect();
    modal.classList.add('context-menu');
    const width=Math.min(350,window.innerWidth-24);
    modal.style.setProperty('width',`${width}px`);
    modal.style.setProperty('left',`${Math.max(12,Math.min(rect.left,window.innerWidth-width-12))}px`);
    const height=modal.getBoundingClientRect().height;
    modal.style.setProperty('top',`${Math.max(12,Math.min(rect.bottom+6,window.innerHeight-height-12))}px`);
  }
  function renderLibrary() {
    const list=currentList(), allCount=state.tracks.size;
    const searching=!!state.search;
    let html=header(searching?'Search results':'Your library',searching?`<span>${plural(list.length,'song')} found</span>`:`<span>${plural(allCount,'song')}</span><span>${formatBytes(trackArray().reduce((s,t)=>s+t.size,0))}</span>`,searching?'YOUR MUSIC':'ON THIS DEVICE');
    if(!searching)html+=`<section class="library-playlists" aria-labelledby="libraryPlaylistsTitle"><div class="section-heading"><h2 id="libraryPlaylistsTitle">Playlists</h2><button class="icon-button" data-action="new-playlist" aria-label="Create playlist">${icon('plus')}</button></div><div class="grid">${playlistTiles()}</div></section>`;
    html+=`<div class="toolbar"><div class="pills"><button class="pill ${state.tab==='songs'||searching?'active':''}" data-action="tab" data-tab="songs">Songs</button>${!searching?`<button class="pill ${state.tab==='albums'?'active':''}" data-action="tab" data-tab="albums">Albums</button>`:''}</div>${list.length?sortControl():''}</div>`;
    if(!allCount) return html+emptyLibrary();
    if(!list.length) return html+'<div class="empty-small"><h2>No songs found</h2><p>Try another title, artist, album, or filename.</p></div>';
    if(state.tab==='albums'&&!searching) {
      const albums=new Map(); for(const t of list){ const key=albumKey(t); if(!albums.has(key))albums.set(key,[]);albums.get(key).push(t); }
      return html+`<div class="grid">${[...albums].sort((a,b)=>a[1][0].album.localeCompare(b[1][0].album)).map(([key,ts])=>`<button class="collection-card" data-view="album" data-id="${esc(key)}">${artwork(ts.find(t=>t.artwork)||ts[0],'','album')}<strong>${esc(ts[0].album)}</strong><small>${esc(ts[0].artist)} · ${plural(ts.length,'song')}</small></button>`).join('')}</div>`;
    }
    html+=`<div class="collection-actions"><button class="play-circle" data-action="play-view" aria-label="Play library">${icon('play')}</button><button class="button quiet" data-action="shuffle-view">${icon('shuffle')}Shuffle</button></div>`;
    return html+trackRows(list);
  }
  function renderCollection() {
    const list=currentList(), isLiked=state.view==='liked', isAlbum=state.view==='album', p=playlist(state.detail);
    if(state.view==='playlist'&&!p) return header('Playlist not found','', 'YOUR MUSIC','new-playlist','Create playlist')+'<p class="view-meta">Choose another playlist from your library.</p>';
    const title=isLiked?'Liked songs':isAlbum?list[0]?.album||'Album':p.name;
    const art=isLiked?artwork(null,'lime','heart'):isAlbum?artwork(list.find(t=>t.artwork)||list[0],'','album'):collectionArt(p);
    let html=`<div class="collection-header">${art}<div><p class="eyebrow">${isAlbum?'ALBUM':'PLAYLIST'}</p><h1>${esc(title)}</h1><p class="view-meta">${isAlbum?`<span>${esc(list[0]?.artist||'')}</span>`:''}<span>${plural(list.length,'song')}</span>${totalDuration(list)?`<span>${totalDuration(list)}</span>`:''}</p></div></div><div class="collection-actions"><button class="play-circle" data-action="play-view" aria-label="Play ${esc(title)}" ${!list.length?'disabled':''}>${icon('play')}</button><button class="icon-button shuffle-control ${state.queue.shuffle?'active':''}" data-action="shuffle-view" aria-label="Shuffle ${esc(title)}" ${!list.length?'disabled':''}>${icon('shuffle')}</button>${p?`<button class="button quiet" data-action="edit-playlist-tracks" data-id="${p.id}">${icon('plus')}Add songs</button><button class="icon-button" data-action="playlist-menu" data-id="${p.id}" aria-label="Playlist options">${icon('vertical')}</button>`:''}${p?`<button class="icon-button" data-action="search-toggle" aria-label="Search this playlist">${icon('search')}</button>`:''}${isAlbum?`<button class="button quiet" data-action="album-cover">Change cover</button>`:''}${isLiked&&list.length?sortControl():''}</div>`;
    if(list.length)return html+trackRows(list);
    return html+`<div class="empty-small"><h2>${isLiked?'Keep your favorites close.':'Make it your own.'}</h2><p>${isLiked?'Tap the heart on any song to save it here.':'Add songs from your library to this playlist.'}</p><button class="button ${p?'primary':'quiet'}" ${p?`data-action="edit-playlist-tracks" data-id="${p.id}"`:'data-view="library"'}>${p?'Add songs':'Browse your library'}</button></div>`;
  }
  function renderPlaylists() {
    return header('Your playlists',`<span>${plural(state.playlists.length,'playlist')}</span>`,'MADE BY YOU','new-playlist','Create playlist')+`<div class="grid">${playlistTiles()}<button class="collection-card new-card" data-action="new-playlist"><span>${icon('plus')}<strong>Create a playlist</strong><small>Give your songs a place.</small></span></button></div>`;
  }
  function renderSettings() {
    const bytes=trackArray().reduce((sum,t)=>sum+t.size,0), info=state.storage;
    return header('Offline & settings','Everything for listening on this device.','SQUIDIFY',null)+`<div class="settings-grid">${context.enhancements.settingsPanel()}<section class="settings-card"><h2>Ready when you are</h2><div class="status-line">${icon(state.shellReady?'check':'download')}<span>${state.shellReady?'App available offline':'Offline app is not ready yet'}</span></div><p>${state.shellReady?'The app is saved in this browser. Imported music and playlists work without an internet connection.':'Open Squidify online once and keep it open until this status changes. Offline setup needs a secure browser connection.'}</p><div class="stat-line"><span>App version</span><strong>${RELEASE_LABEL}</strong></div><div class="stat-line"><span>Saved songs</span><strong>${state.tracks.size}</strong></div><div class="stat-line"><span>Connection</span><strong>${navigator.onLine?'Online':'Offline'}</strong></div><button class="button" data-action="check-offline">${icon('check')}Check offline readiness</button><p class="small-note">After setup, try Airplane Mode and reopen the app before relying on it away from home.</p></section><section class="settings-card"><h2>On your Home Screen</h2>${standalone()?'<div class="status-line">'+icon('check')+'Running as an installed app</div>':''}<ol>${isIOS?'<li>Open this link in Safari.</li><li>Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Keep <strong>Open as Web App</strong> on if shown.</li>':'<li>Open this link in your regular browser.</li><li>Use the browser menu and choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>.</li>'}<li>Open Squidify from its new icon, then import your music there.</li></ol>${state.installPrompt?'<button class="button primary" data-action="install">Install Squidify</button>':''}<p class="small-note">Your browser tab and installed app may have separate storage. Set up your library inside the version you’ll use.</p></section><section class="settings-card"><h2>Music storage</h2><div class="stat-line"><span>Audio saved</span><strong>${formatBytes(bytes)}</strong></div>${info.quota?`<div class="stat-line"><span>Browser storage used</span><strong>${formatBytes(info.usage)} / ${formatBytes(info.quota)}</strong></div><div class="storage-bar"><span style="width:${Math.min(100,(info.usage||0)/info.quota*100)}%"></span></div>`:''}<div class="stat-line"><span>Storage protection</span><strong>${info.persistent?'Persistent storage granted':'Managed by your browser'}</strong></div><button class="button" data-action="persist">${icon('shield')}${info.persistent?'Check storage protection':'Request storage protection'}</button><p class="small-note">Keep your original music files. Clearing website data or removing the app can erase saved music and playlists. Browsers may also reclaim unprotected storage.</p></section><section class="settings-card"><h2>Local folders</h2><p>${'showDirectoryPicker' in window?'Folder connections can be remembered in this browser. Rescan to add new songs; existing copies and playlists stay intact.':'This browser uses file imports. Choose a folder if supported, or select multiple audio files. Saved copies stay available after you close the app.'}</p><button class="button primary" data-action="add-music">${icon('plus')}Add music</button>${state.folders.map(f=>`<div class="folder-row">${icon('folder')}<span>${esc(f.name)}</span><button class="button" data-action="rescan" data-id="${esc(f.id)}">Rescan</button><button class="icon-button" data-action="forget-folder" data-id="${esc(f.id)}" aria-label="Forget connection to ${esc(f.name)}">${icon('close')}</button></div>`).join('')}<p class="small-note">Choose files downloaded to your device. Cloud-only files need a connection before they can be imported.</p></section><section class="settings-card"><h2>Playback</h2><p>Balanced shuffle plays each queued song once and separates artists and albums where possible. Previous returns through the actual played order.</p><p>Lock Screen and headphone controls use your browser’s media support. Your phone can still pause or suspend browser playback in the background.</p><p class="small-note">MP3, AAC/M4A, WAV, FLAC, Ogg and other browser-supported audio. Codec support varies by device. Protected subscription downloads cannot be played.</p>${isIOS?'<p class="small-note">Use your phone’s volume buttons to adjust volume.</p>':''}</section><section class="settings-card"><h2>At your fingertips</h2><div class="key-help"><kbd>Space</kbd> Play / pause<br><kbd>←</kbd> <kbd>→</kbd> Seek 5 seconds<br><kbd>Shift</kbd> + <kbd>←</kbd> / <kbd>→</kbd> Previous / next<br><kbd>S</kbd> Balanced shuffle &nbsp; <kbd>L</kbd> Like song<br><kbd>/</kbd> Search your music</div><details><summary>About your music</summary><p>Squidify reads local audio and copies it into this app’s storage on this device. Your music is never sent to a server. Changes in Squidify do not modify the original files.</p></details></section></div>`;
  }
  function render() {
    if(state.pickerOpen)return;
    if(!state.ready)return;
    if((state.search && state.view!=='playlist') || state.view==='library')main.innerHTML=renderLibrary();
    else if(['liked','playlist','album'].includes(state.view))main.innerHTML=renderCollection();
    else if(state.view==='playlists')main.innerHTML=renderPlaylists();
    else main.innerHTML=renderSettings();
    renderSidebar(); renderPlayer(); if(!$('#queuePanel').hidden)renderQueue();
  }

  function setModal(content, className = '') {
    // Keep the same input nodes alive when switching dialogs.
    $('#fileInputs').append(fileInput,folderInput);
    modal.removeAttribute('style');
    modal.className=`modal ${className}`; modal.innerHTML=content;
    if(!modal.open)modal.showModal();
    $('#modalTitle')?.focus({preventScroll:true});
  }
  const modalHead = title => `<div class="modal-head"><h2 id="modalTitle" tabindex="-1" autofocus>${esc(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="Close">${icon('close')}</button></div>`;
  function addMusicDialog() {
    if(state.busy)return toast('Finish the current import first.');
    setModal(modalHead('Add your music')+`<p>Choose a folder or audio files.</p>${state.importReport?'<button class="button quiet" data-action="import-results">Import results</button>':''}<label for="fileInput">Audio files</label><div id="filePickerSlot"></div><label for="folderInput">Music folder</label>${'showDirectoryPicker' in window?`<button type="button" class="import-choice" data-action="choose-folder">${icon('folder')}<span><strong>Connect a folder</strong><small>Include songs in its subfolders</small></span></button>`:'<div id="folderPickerSlot"></div>'}<p class="small-note">MP3, AAC/M4A, WAV, FLAC, Ogg/Opus, AIFF, MP4 and WebM. Playback depends on your device’s codecs. Protected subscription downloads are not supported. Mixed imports keep valid songs and report skipped or unreadable files individually.</p>`);
    $('#filePickerSlot').append(fileInput);
    if(!('showDirectoryPicker' in window))$('#folderPickerSlot').append(folderInput);
  }
  function trackMenu(id, anchor) {
    const t=byId(id);if(!t)return;
    const p=state.view==='playlist'?playlist(state.detail):null;
    setModal(modalHead('Song options')+`<div class="menu-track">${artwork(t)}<div><span class="song-title">${esc(t.title)}</span><span class="song-artist">${esc(t.artist)}</span></div></div><button class="menu-item" data-action="edit-track" data-id="${id}">${icon('edit')}Edit song details</button><button class="menu-item" data-action="like" data-id="${id}">${icon('heart')}${t.liked?'Remove from liked songs':'Add to liked songs'}</button><button class="menu-item" data-action="playlist-picker" data-id="${id}">${icon('plus')}Add to playlist</button><button class="menu-item" data-action="play-next" data-id="${id}">${icon('next')}Play next</button><button class="menu-item" data-action="add-queue" data-id="${id}">${icon('queue')}Add to queue</button>${p?`<hr class="menu-separator"><button class="menu-item" data-action="move-playlist-track" data-id="${id}" data-delta="-1" ${p.trackIds.indexOf(id)===0?'disabled':''}>${icon('up')}Move up in playlist</button><button class="menu-item" data-action="move-playlist-track" data-id="${id}" data-delta="1" ${p.trackIds.indexOf(id)===p.trackIds.length-1?'disabled':''}>${icon('down')}Move down in playlist</button><button class="menu-item" data-action="remove-playlist-track" data-id="${id}">${icon('close')}Remove from this playlist</button>`:''}<hr class="menu-separator"><button class="menu-item danger" data-action="confirm-remove-track" data-id="${id}">${icon('trash')}Remove from this device</button><p class="small-note">${esc(t.album)} · ${formatTime(t.duration)}<br>${esc(t.name)} · ${formatBytes(t.size)}</p>`);
    positionMenu(anchor);
  }
  function highlightCurrent() {
    $$('[data-track-row]').forEach((row,i)=>{const current=row.dataset.trackRow===state.queue.current;row.classList.toggle('current',current);const button=$('.number-button',row);if(button)button.innerHTML=current?icon(!audio.paused&&!playback.isPriming()?'pause':'play'):i+1;});
  }
  function renderPlayer() {
    if(state.pickerOpen)return;
    const t=byId(state.queue.current),playing=!audio.paused&&!playback.isPriming();
    const title=t?.title||'Nothing playing yet',titleNode=$('#nowTitle');
    if(titleNode.dataset.title!==title){titleNode.innerHTML=`<span class="scroll-title-text">${esc(title)}</span>`;titleNode.dataset.title=title;titleNode.setAttribute('title',title);}
    $('#nowArtist').textContent=t?.artist||'Choose something from your library';
    const art=playerArtwork(t);$('#nowArtwork').innerHTML=art;
    $('#playerLike').disabled=!t;$('#playerLike').classList.toggle('liked',!!t?.liked);$('#playerLike').setAttribute('aria-label',t?.liked?'Unlike current song':'Like current song');
    $$('[data-action="toggle-play"]').forEach(b=>{b.innerHTML=icon(playing?'pause':'play');b.setAttribute('aria-label',playing?'Pause':'Play');});
    $$('[data-action="play-view"]').forEach(b=>{const pause=playing&&playback.isCurrentView();b.innerHTML=icon(pause?'pause':'play');b.setAttribute('aria-label',`${pause?'Pause':'Play'} ${contextName()}`);b.setAttribute('aria-pressed',String(pause));});
    $$('.shuffle-control').forEach(b=>{b.classList.toggle('active',state.queue.shuffle);b.setAttribute('aria-pressed',String(state.queue.shuffle));if(b.dataset.action==='shuffle')b.setAttribute('aria-label',state.queue.shuffle?'Disable balanced shuffle':'Enable balanced shuffle');});
    $$('.repeat-control').forEach(b=>{b.classList.toggle('active',state.queue.repeat!=='off');b.setAttribute('aria-label',`Repeat ${state.queue.repeat}`);b.title=`Repeat ${state.queue.repeat}`;const one=$('b',b);if(one)one.hidden=state.queue.repeat!=='one';});
    $$('[data-action="next"],[data-action="previous"]').forEach(b=>b.disabled=!t);
    $('#muteButton').innerHTML=icon(audio.muted?'muted':'volume');$('#muteButton').setAttribute('aria-label',audio.muted?'Unmute':'Mute');
    $('#volumeInput').value=audio.muted?0:audio.volume;$('#volumeInput').style.setProperty('--pct',`${(audio.muted?0:audio.volume)*100}%`);
    highlightCurrent();updateProgress();context.enhancements?.renderOutput();context.enhancements?.drawWave();
    refreshTitleMarquees();
  }
  function updateProgress() {
    if(state.pickerOpen)return;
    const {duration,time:current,ready}=playback.progress();
    $$('.elapsed').forEach(el=>el.textContent=formatTime(current));$$('.duration').forEach(el=>el.textContent=duration?formatTime(duration):'0:00');
    $$('[data-seek]').forEach(el=>{if(el.dataset.dragging)return;el.disabled=!duration||!ready;el.max=duration||100;el.value=current;el.style.setProperty('--pct',`${duration?current/duration*100:0}%`);el.setAttribute('aria-valuetext',`${formatTime(current)} of ${formatTime(duration||0)}`);});
    updatePositionState();
  }
  function renderNowPlaying() {
    const t=byId(state.queue.current);if(!t)return;
    nowDialog.innerHTML=`<div class="now-top"><button class="icon-button" data-action="close-now" aria-label="Close now playing">${icon('down')}</button><p>${esc(state.queue.context)}</p><button class="icon-button" data-action="current-menu" aria-label="Song options">${icon('vertical')}</button></div>${playerArtwork(t,'full-art')}<div class="full-title-row"><div><h2 id="fullTitle" class="scrolling-title" title="${esc(t.title)}"><span class="scroll-title-text">${esc(t.title)}</span></h2><p>${esc(t.artist)}</p></div><button class="icon-button like-button ${t.liked?'liked':''}" data-action="like-current" aria-label="${t.liked?'Unlike':'Like'} song" aria-pressed="${!!t.liked}">${icon('heart')}</button></div><div class="scrubber"><span class="time elapsed">0:00</span><input data-seek type="range" min="0" max="100" step=".1" value="0" aria-label="Playback position"><span class="time duration">0:00</span></div><div class="playback-buttons"><button class="icon-button shuffle-control" data-action="shuffle" aria-label="Balanced shuffle">${icon('shuffle')}</button><button class="icon-button" data-action="previous" aria-label="Previous song">${icon('previous')}</button><button class="main-play" data-action="toggle-play" aria-label="Play">${icon('play')}</button><button class="icon-button" data-action="next" aria-label="Next song">${icon('next')}</button><button class="icon-button repeat-control" data-action="repeat" aria-label="Repeat off">${icon('repeat')}<b hidden>1</b></button></div><div class="now-footer">${outputControl()}<button class="icon-button" data-action="queue" aria-label="Open queue">${icon('queue')}</button></div><canvas class="audio-wave full-wave" width="780" height="140" aria-label="Audio waveform"></canvas>`;
    renderPlayer();
  }
  function renderQueue() {
    const panel=$('#queuePanel'),q=state.queue,current=byId(q.current);
    const item=(id,i,now=false)=>{const t=byId(id);if(!t)return '';return `<div class="queue-item ${now?'current':''}"><button class="track-cell" data-action="queue-jump" data-index="${i}">${artwork(t)}<span class="track-text"><span class="song-title">${esc(t.title)}</span><span class="song-artist">${esc(t.artist)}</span></span></button>${!now?`<button class="icon-button" data-action="queue-up" data-index="${i}" aria-label="Move ${esc(t.title)} earlier" ${i===q.index+1?'disabled':''}>${icon('up')}</button><button class="icon-button" data-action="queue-remove" data-index="${i}" aria-label="Remove ${esc(t.title)} from queue">${icon('close')}</button>`:''}</div>`;};
    panel.innerHTML=`<div class="panel-head"><h2 tabindex="-1">Queue</h2><button class="icon-button" data-action="queue" aria-label="Close queue">${icon('close')}</button></div>${current?`<p class="queue-heading">Now playing</p>${item(current.id,q.index,true)}<p class="queue-heading">Up next · ${Math.max(0,q.order.length-q.index-1)}</p><p class="queue-description">${esc(q.context)}${q.shuffle?' · Balanced shuffle':''}</p>${q.order.slice(q.index+1).map((id,i)=>item(id,q.index+1+i)).join('')||'<p class="queue-description">You’re at the end of the queue.</p>'}<div class="queue-controls"><button class="button" data-action="clear-queue">Clear upcoming</button><button class="button" data-action="save-queue">Save as playlist</button></div>`:'<p class="queue-description">Play a song to start a queue. Add more from any song’s menu.</p>'}`;
  }
  function renderOfflineBadge() {
    const badge=$('#offlineBadge');badge.classList.toggle('ready',state.shellReady);
    badge.classList.toggle('downloading',!!state.updateDownloading);
    badge.innerHTML=icon(state.updateDownloading?'download':state.shellReady?'check':'download')+`<span>${state.updateDownloading?'Downloading…':state.shellReady?(navigator.onLine?'Offline ready':'Listening offline'):'Offline setup'}</span>`;
  }

  function bindEvents(actions) {
  main.addEventListener('scroll',()=>{const action=searchScroll.update(main.scrollTop,state.view==='playlist');if(action==='hide'&&document.activeElement!==$('#searchInput'))document.body.classList.remove('search-visible');if(action==='show')document.body.classList.add('search-visible');},{passive:true});
  bindGestures({ document, window, nowDialog, beginPlayerDrag:playerMotion.interrupt,
    run: (name,id) => {
      if(name==='gesture-previous')return playback.previousTrack(false);
      return Promise.resolve(actions[name]?.({dataset:{id}})).catch(report);
    },
    openMenu: item => {
      const id=item.dataset.trackRow||item.dataset.playlistId;
      const name=item.dataset.trackRow?'track-menu':'playlist-menu';
      actions[name]({dataset:{id},anchor:item});
    }
  });
  modal.addEventListener('click',event=>{if(event.target===modal){const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modal.close();}});
  document.addEventListener('click',event=>{
    if(event.target===fileInput||event.target===folderInput){
      if(state.busy){event.preventDefault();toast('Finish the current import first.');return;}
      state.pickerOpen=true;return;
    }
    const button=event.target.closest('button[data-action],button[data-view],a[data-view]');if(!button){if(event.target.closest('#player')&&!event.target.closest('input'))actions['now-playing']();return;}if(button.disabled)return;
    event.preventDefault();
    if(button.dataset.view){route(button.dataset.view,button.dataset.id||'');return;}
    const action=actions[button.dataset.action];if(action)Promise.resolve(action(button)).catch(e=>report(e));
  });
  document.addEventListener('input',event=>{
    const el=event.target;
    if(el.dataset.eq){context.enhancements.updateEqualizer(el.dataset.eq,el.value);return;}
    if(el.id==='searchInput'){state.search=el.value;render();}
    if(el.id==='pickerSearch')$$('.picker-track',modal).forEach(row=>{row.hidden=!row.dataset.search.includes(el.value.toLowerCase().trim());});
    if(el.id==='volumeInput'){audio.volume=Number(el.value);audio.muted=false;el.style.setProperty('--pct',`${audio.volume*100}%`);saveSession();}
    if(el.matches('[data-seek]')){const value=Number(el.value);if(Number.isFinite(audio.duration)){audio.currentTime=Math.min(value,audio.duration);updateProgress();saveSession();}}
  });
  document.addEventListener('change',event=>{if(event.target.dataset.eq)context.enhancements.saveSettings();});
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!$('#queuePanel').hidden){$('#queuePanel').hidden=true;return;}
    if(modal.open||['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)||event.target.isContentEditable||event.altKey||event.ctrlKey||event.metaKey)return;
    if(event.key===' '&&event.target.closest('button,a'))return;
    if(event.key===' '){event.preventDefault();togglePlay();}
    if(event.key==='ArrowRight'){event.preventDefault();if(event.shiftKey)nextTrack();else if(Number.isFinite(audio.duration))audio.currentTime=Math.min(audio.duration,audio.currentTime+5);}
    if(event.key==='ArrowLeft'){event.preventDefault();if(event.shiftKey)previousTrack();else if(audio.src)audio.currentTime=Math.max(0,audio.currentTime-5);}
    if(event.key.toLowerCase()==='s')toggleShuffle();
    if(event.key.toLowerCase()==='l')toggleLike(state.queue.current).catch(report);
    if(event.key==='/'){event.preventDefault();document.body.classList.add('search-visible');$('#searchInput').focus();}
  });
  window.addEventListener('hashchange',readRoute);
  window.addEventListener('online',renderOfflineBadge);window.addEventListener('offline',renderOfflineBadge);
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.installPrompt=e;if(state.view==='settings')render();});
  window.addEventListener('appinstalled',()=>{state.installPrompt=null;toast('Squidify installed. Open it from your Home Screen.');if(state.view==='settings')render();});
  document.addEventListener('visibilitychange',()=>{document.documentElement?.classList.toggle('page-hidden',document.hidden);if(document.hidden)saveSession(true);else if(!state.pickerOpen){renderPlayer();if(nowDialog.open)renderNowPlaying();}});
  }

  function releaseArtwork(id) { if(artworkURLs.has(id)){URL.revokeObjectURL(artworkURLs.get(id));artworkURLs.delete(id);} }

  const actions = {
  'add-music':()=>addMusicDialog(),
  'choose-folder':()=>chooseFolder(),
  'choose-files':()=>selectFiles(),
  'close-modal':()=>modal.close(),
  'close-now':()=>playerMotion.close(),
  'search-toggle':()=>{document.body.classList.toggle('search-visible');if(document.body.classList.contains('search-visible'))$('#searchInput').focus();},
  'audio-output':()=>context.enhancements.chooseOutput(),
  'reset-equalizer':()=>context.enhancements.resetEqualizer(),
  'pause-equalizer-preview':b=>context.enhancements.pausePreview(b),
  'cancel-import':()=>{state.stopImport=true;},
  'track-menu':b=>trackMenu(b.dataset.id,b.anchor||b),
  'current-menu':()=>{nowDialog.close();trackMenu(state.queue.current);},
  'tab':b=>{state.tab=b.dataset.tab;motion.change(render);},
  'now-playing':()=>{if(!state.queue.current)return;playerMotion.open(renderNowPlaying);context.enhancements?.drawWave();if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>context.enhancements?.drawWave());},
  'queue':()=>{nowDialog.close();const panel=$('#queuePanel');panel.hidden=!panel.hidden;if(!panel.hidden){renderQueue();$('.panel-head h2',panel).focus({preventScroll:true});}},
  'confirm-remove-track':b=>{const t=byId(b.dataset.id);if(!t)return;setModal(modalHead('Remove this song?')+`<p>Remove ${esc(t.title)} from Squidify and all its playlists? The original audio file will stay untouched.</p><div class="modal-actions"><button class="button" data-action="close-modal">Cancel</button><button class="button danger" data-action="remove-track" data-id="${t.id}">Remove song</button></div>`);},
  'persist':async()=>{const granted=await navigator.storage?.persist?.().catch(()=>false);state.storage=await db.storageInfo();render();toast(granted?'Storage protection granted.':"Your browser decides storage protection. Installing Squidify may help.");},
  'check-offline':async()=>{const ready=await checkOffline(true);state.storage=await db.storageInfo();render();toast(ready?'The app is cached. Imported songs are saved on this device.':'Offline setup is incomplete. Open the app online in your regular browser.',!ready);},
  'install':async()=>{if(!state.installPrompt)return;await state.installPrompt.prompt();await state.installPrompt.userChoice;state.installPrompt=null;render();}
  };

  function artworkURL(t) { if(!t?.artwork)return undefined; if(!artworkURLs.has(t.id))artworkURLs.set(t.id,URL.createObjectURL(t.artwork)); return artworkURLs.get(t.id); }

  function outputControl(){return `<button class="icon-button output-control" data-action="audio-output" aria-label="Audio output — managed by your device" title="Audio output">${icon('bluetooth')}</button>`;}
  function playerArtwork(t,extra=''){const p=playlist(state.queue.playlistId);return p?collectionArt(p,extra):artwork(t,extra);}
  function mediaArtwork(){const p=playlist(state.queue.playlistId);return p?context.enhancements.playlistMediaArt(p):null;}
  return { motion, outputControl, mediaArtwork, toast, report, paintIcons, collectionArt, route, readRoute, currentList, viewKey, contextName, header, render, setModal, modalHead, positionMenu, addMusicDialog, highlightCurrent, renderPlayer, updateProgress, renderNowPlaying, renderQueue, renderOfflineBadge, releaseArtwork, artworkURL, bindEvents, actions };
}
