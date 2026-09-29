import * as db from './storage.js';
import { escapeHTML as esc } from './core.js';
import { icon } from './icons.js';

export function createPlaylists(context) {
  const { $, audio, modal, nowDialog, state, trackArray, byId, playlist, idToken, plural, totalDuration } = context;
  const toast = (...args) => context.ui.toast(...args);
  const report = (...args) => context.ui.report(...args);
  const collectionArt = (...args) => context.ui.collectionArt(...args);
  const route = (...args) => context.ui.route(...args);
  const render = (...args) => context.ui.render(...args);
  const setModal = (...args) => context.ui.setModal(...args);
  const addMusicDialog = (...args) => context.ui.addMusicDialog(...args);
  const renderNowPlaying = (...args) => context.ui.renderNowPlaying(...args);
  const modalHead = (...args) => context.ui.modalHead(...args);

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
  function playlistMenu(id,anchor) {
    const p=playlist(id);if(!p)return;
    setModal(modalHead(p.name)+`<p class="menu-info">${plural(p.trackIds.length,'song')}${totalDuration(p.trackIds.map(byId).filter(Boolean))?' · '+totalDuration(p.trackIds.map(byId).filter(Boolean)):''}<br>Created ${esc(new Date(p.createdAt).toLocaleDateString())}</p><button class="menu-item" data-action="rename-playlist" data-id="${id}">${icon('edit')}Rename playlist</button><button class="menu-item" data-action="edit-playlist-tracks" data-id="${id}">${icon('plus')}Add songs</button><button class="menu-item" data-action="move-playlist" data-id="${id}" data-delta="-1" ${state.playlists.indexOf(p)===0?'disabled':''}>${icon('up')}Move playlist up</button><button class="menu-item" data-action="move-playlist" data-id="${id}" data-delta="1" ${state.playlists.indexOf(p)===state.playlists.length-1?'disabled':''}>${icon('down')}Move playlist down</button><button class="menu-item" data-action="export-playlist" data-id="${id}">${icon('download')}Export playlist</button><hr class="menu-separator"><button class="menu-item danger" data-action="confirm-delete-playlist" data-id="${id}">${icon('trash')}Delete playlist</button>`);
    context.ui.positionMenu(anchor);
  }
  function editTrack(id) {
    const t=byId(id);if(!t)return;
    setModal(modalHead('Edit song details')+`<form id="editTrackForm" data-id="${esc(id)}">${['title','artist','album'].map(key=>`<label for="track-${key}">${key[0].toUpperCase()+key.slice(1)}</label><input class="text-input" id="track-${key}" name="${key}" value="${esc(t[key]||'')}" maxlength="300" required>`).join('')}<div class="modal-actions"><button type="button" class="button" data-action="close-modal">Cancel</button><button type="submit" class="button primary">Save</button></div></form>`);
    $('#track-title').focus();
  }
  async function saveTrackDetails(form) {
    const t=byId(form.dataset.id);if(!t)return;
    const values=Object.fromEntries(['title','artist','album'].map(key=>[key,$('#track-'+key).value.trim().slice(0,300)]));
    if(Object.values(values).some(value=>!value))return toast('Enter a title, artist, and album.');
    const updated={...t,...values};await db.put('tracks',updated);state.tracks.set(t.id,updated);
    modal.close();render();if(nowDialog.open)renderNowPlaying();context.playback.updateMediaSession();toast('Song details saved.');
  }
  async function movePlaylist(id,delta) {
    const i=state.playlists.findIndex(p=>p.id===id),j=i+Number(delta);
    if(i<0||!Number.isInteger(j)||j<0||j>=state.playlists.length)return;
    const next=[...state.playlists];[next[i],next[j]]=[next[j],next[i]];
    await db.setSetting('playlistOrder',next.map(p=>p.id));
    state.playlists=next;modal.close();render();
  }
  async function toggleLike(id) {
    const t=byId(id);if(!t)return;
    const updated={...t,liked:!t.liked};await db.put('tracks',updated);state.tracks.set(id,updated);
    render();if(nowDialog.open)renderNowPlaying();if(modal.open)modal.close();
  }


  function bindEvents() {
  document.addEventListener('submit',event=>{
    if(event.target.id==='editTrackForm'){event.preventDefault();saveTrackDetails(event.target).catch(e=>report(e,'Could not save song details. Please try again.'));}
    if(event.target.id==='playlistForm'){event.preventDefault();savePlaylistForm(event.target).catch(e=>report(e,'Could not save the playlist. Your name is still here; try again.'));}
    if(event.target.id==='addTracksForm'){
      event.preventDefault();const form=event.target,p=playlist(form.dataset.id);if(!p)return;
      const ids=new FormData(form).getAll('track').filter(id=>byId(id));if(!ids.length)return toast('Select at least one song.');
      const next={...p,trackIds:[...new Set([...p.trackIds,...ids])]};
      db.put('playlists',next).then(()=>{Object.assign(p,next);modal.close();render();toast(`${plural(ids.length,'song')} added.`);}).catch(e=>report(e));
    }
  });
  }

  const actions = {
  'new-playlist':b=>playlistForm(null,b.dataset.track),
  'rename-playlist':b=>playlistForm(b.dataset.id),
  'playlist-picker':b=>playlistPicker(b.dataset.id),
  'add-to-playlist':b=>addToPlaylist(b.dataset.id,b.dataset.track),
  'edit-playlist-tracks':b=>editPlaylistTracks(b.dataset.id),
  'playlist-menu':b=>playlistMenu(b.dataset.id,b.anchor||b),
  'move-playlist':b=>movePlaylist(b.dataset.id,b.dataset.delta),
  'edit-track':b=>editTrack(b.dataset.id),
  'like':b=>toggleLike(b.dataset.id),
  'like-current':()=>toggleLike(state.queue.current),
  'save-queue':async()=>{const ids=[...new Set(state.queue.order)].filter(id=>byId(id));if(!ids.length)return;const p={id:idToken(),name:`Queue ${new Date().toLocaleDateString()}`,trackIds:ids,color:'purple',createdAt:Date.now()};await db.put('playlists',p);state.playlists.push(p);render();toast('Queue saved as a playlist.');},
  'move-playlist-track':async b=>{const p=playlist(state.detail);if(!p)return;const ids=[...p.trackIds],i=ids.indexOf(b.dataset.id),j=i+Number(b.dataset.delta);if(i<0||j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];await db.put('playlists',{...p,trackIds:ids});p.trackIds=ids;modal.close();render();},
  'remove-playlist-track':async b=>{const p=playlist(state.detail);if(!p)return;const ids=p.trackIds.filter(id=>id!==b.dataset.id);await db.put('playlists',{...p,trackIds:ids});p.trackIds=ids;modal.close();render();toast('Removed from playlist.');},
  'confirm-delete-playlist':b=>{const p=playlist(b.dataset.id);if(!p)return;setModal(modalHead('Delete this playlist?')+`<p>Delete ${esc(p.name)}? Your songs will stay in your library.</p><div class="modal-actions"><button class="button" data-action="close-modal">Cancel</button><button class="button danger" data-action="delete-playlist" data-id="${p.id}">Delete playlist</button></div>`);},
  'delete-playlist':async b=>{await db.remove('playlists',b.dataset.id);state.playlists=state.playlists.filter(p=>p.id!==b.dataset.id);modal.close();route('playlists');toast('Playlist deleted.');},
  'export-playlist':b=>{const p=playlist(b.dataset.id);if(!p)return;const content='#EXTM3U\n'+p.trackIds.map(byId).filter(Boolean).map(t=>`#EXTINF:${Math.round(t.duration||-1)},${(t.artist+' - '+t.title).replace(/[\r\n]/g,' ')}\n${t.path.replace(/[\r\n]/g,' ')}`).join('\n');const url=URL.createObjectURL(new Blob([content],{type:'audio/x-mpegurl;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=p.name.replace(/[^\w -]/g,'').slice(0,80)+'.m3u';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);modal.close();toast('Playlist exported. Audio files are not included.');}
  };

  async function createFromTool(input) {if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>100||!Array.isArray(input.trackIds)||input.trackIds.some(id=>typeof id!=='string'||!byId(id)))throw new Error('Use a nonempty name of up to 100 characters and existing track IDs.');const p={id:idToken(),name:input.name.trim(),trackIds:[...new Set(input.trackIds)],color:'purple',createdAt:Date.now()};await db.put('playlists',p);state.playlists.push(p);route('playlist',p.id);render();return{id:p.id,name:p.name,songCount:p.trackIds.length};}

  return { saveTrackDetails, toggleLike, savePlaylistForm, addToPlaylist, createFromTool, bindEvents, actions };
}
