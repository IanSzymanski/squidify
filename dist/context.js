import { PlayQueue } from './core.js';
import { createAudioOutput } from './audio-output.js';

// Created once per app. Saved records keep the original storage schema.
export function createContext() {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const main = $('#main'), primaryAudio = $('#audio'), modal = $('#modal'), nowDialog = $('#nowDialog');
  const fileInput = $('#fileInput'), folderInput = $('#folderInput');
  const state = { tracks: new Map(), playlists: [], folders: [], queue: new PlayQueue(), view: 'library', detail: '', search: '', tab: 'songs', sort: 'added', busy: false, stopImport: false, shellReady: false, updateDownloading: false, storage: {}, installPrompt: null, ready: false };
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const audio=createAudioOutput(primaryAudio,()=>{
    const element=document.createElement('audio');element.setAttribute('playsinline','');document.body.append(element);return element;
  });
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const trackArray = () => [...state.tracks.values()];
  const byId = id => state.tracks.get(id);
  const playlist = id => state.playlists.find(p => p.id === id);
  const idToken = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  const totalDuration = list => { const s = list.reduce((sum,t) => sum + (t.duration || 0),0); return s ? s < 3600 ? `${Math.round(s/60)} min` : `${Math.floor(s/3600)} hr ${Math.round(s%3600/60)} min` : ''; };

  return { $, $$, main, audio, modal, nowDialog, fileInput, folderInput, state, isIOS, standalone, trackArray, byId, playlist, idToken, plural, totalDuration };
}
