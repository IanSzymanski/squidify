const NAME = 'squidify-local-v1';
let connection;
export function openDB() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['tracks', 'media', 'playlists', 'folders', 'settings']) db.createObjectStore(name, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = null; };
      resolve(request.result);
    };
    request.onerror = () => { connection = null; reject(request.error); };
    request.onblocked = () => { connection = null; reject(new Error('Close other Squidify tabs, then reopen the app.')); };
  });
  return connection;
}
async function operation(stores, mode, run) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Could not save on this device.'));
    tx.onabort = () => reject(tx.error || new Error('Storage operation was interrupted.'));
    run(tx, value => { result = value; });
  });
}
export const all = store => operation([store], 'readonly', (tx, done) => { tx.objectStore(store).getAll().onsuccess = e => done(e.target.result); });
export const get = (store, id) => operation([store], 'readonly', (tx, done) => { tx.objectStore(store).get(id).onsuccess = e => done(e.target.result); });
export const put = (store, record) => operation([store], 'readwrite', tx => { tx.objectStore(store).put(record); });
export const remove = (store, id) => operation([store], 'readwrite', tx => { tx.objectStore(store).delete(id); });
export function saveTrack(track, blob) {
  return operation(['tracks', 'media'], 'readwrite', tx => {
    tx.objectStore('tracks').put(track);
    tx.objectStore('media').put({ id: track.id, blob });
  });
}
export function deleteTrack(id) {
  return operation(['tracks', 'media', 'playlists'], 'readwrite', tx => {
    tx.objectStore('tracks').delete(id);
    tx.objectStore('media').delete(id);
    const ps = tx.objectStore('playlists');
    ps.openCursor().onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor) return;
      if (cursor.value.trackIds.includes(id)) cursor.update({ ...cursor.value, trackIds: cursor.value.trackIds.filter(x => x !== id) });
      cursor.continue();
    };
  });
}
export const setting = async (id, fallback) => (await get('settings', id))?.value ?? fallback;
export const setSetting = (id, value) => put('settings', { id, value });
export async function storageInfo() {
  const estimate = await navigator.storage?.estimate?.().catch(() => ({})) || {};
  const persistent = await navigator.storage?.persisted?.().catch(() => false) || false;
  return { ...estimate, persistent };
}
// Album cover updates are atomic: quota failures preserve every previous cover.
export const putTracks = tracks => operation(['tracks'], 'readwrite', tx => {for(const track of tracks)tx.objectStore('tracks').put(track);});
