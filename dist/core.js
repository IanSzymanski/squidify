// A shuffle bag: every track once, with artist/album separation where possible.
export function balancedShuffle(ids, tracks, previous = [], random = Math.random) {
  const unique = [...new Set(ids)];
  const map = tracks instanceof Map ? tracks : new Map(tracks.map(t => [t.id, t]));
  const artist = id => {
    const value = map.get(id)?.artist?.trim().toLowerCase();
    return value && value !== 'unknown artist' ? value : `track:${id}`;
  };
  const album = id => map.get(id)?.album?.trim().toLowerCase();
  const bag = unique.map(id => ({ id, jitter: random() }));
  const result = [];
  const recent = [...previous];
  while (bag.length) {
    const last = recent.at(-1);
    let candidates = bag.filter(t => t.id !== last && artist(t.id) !== artist(last));
    if (!candidates.length) candidates = bag.filter(t => t.id !== last);
    if (!candidates.length) candidates = bag;
    const farther = candidates.filter(t => !recent.slice(-2).some(id => artist(id) === artist(t.id)));
    if (farther.length) candidates = farther;
    const differentAlbums = candidates.filter(t => !album(last) || album(t.id) !== album(last));
    if (differentAlbums.length) candidates = differentAlbums;
    // Larger artist groups get a gentle early bias so they do not pile up at the end.
    const counts = new Map();
    for (const t of bag) counts.set(artist(t.id), (counts.get(artist(t.id)) || 0) + 1);
    candidates.sort((a, b) => (counts.get(artist(b.id)) + b.jitter * 2) - (counts.get(artist(a.id)) + a.jitter * 2));
    const chosen = candidates[0];
    result.push(chosen.id);
    recent.push(chosen.id);
    bag.splice(bag.indexOf(chosen), 1);
  }
  return result;
}

export class PlayQueue {
  constructor(saved = {}) {
    this.source = saved.source || [];
    this.order = saved.order || [];
    this.index = Number.isInteger(saved.index) ? saved.index : -1;
    this.shuffle = !!saved.shuffle;
    this.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off';
    this.context = saved.context || 'Your library';
  }
  get current() { return this.order[this.index] || null; }
  start(ids, startId, tracks, context = 'Your library') {
    this.source = [...new Set(ids)];
    if (!this.source.length) { this.order = []; this.index = -1; return null; }
    const id = this.source.includes(startId) ? startId : this.source[0];
    this.order = this.shuffle ? [id, ...balancedShuffle(this.source.filter(x => x !== id), tracks, [id])] : [...this.source];
    this.index = this.order.indexOf(id);
    this.context = context;
    return this.current;
  }
  setShuffle(enabled, tracks) {
    this.shuffle = enabled;
    if (this.index < 0) return;
    const past = this.order.slice(0, this.index + 1);
    const future = this.order.slice(this.index + 1);
    this.order = [...past, ...(enabled ? balancedShuffle(future, tracks, past.slice(-2)) : [...new Set([...this.source, ...future])].filter(id => future.includes(id)))];
  }
  next(tracks, manual = false) {
    if (!manual && this.repeat === 'one' && this.current) return this.current;
    if (this.index + 1 < this.order.length) return this.order[++this.index];
    if (this.repeat === 'all' && this.source.length) {
      const previous = this.order.slice(-2);
      this.order = this.shuffle ? balancedShuffle(this.source, tracks, previous) : [...this.source];
      this.index = 0;
      return this.current;
    }
    return null;
  }
  previous() {
    if (this.index > 0) this.index--;
    return this.current;
  }
  add(id, next = false) {
    if (!this.source.includes(id)) this.source.push(id);
    const existing = this.order.indexOf(id, this.index + 1);
    if (existing >= 0) this.order.splice(existing, 1);
    if (next) this.order.splice(this.index + 1, 0, id);
    else this.order.push(id);
  }
  removeAt(index) {
    if (index <= this.index || index >= this.order.length) return;
    const [id] = this.order.splice(index, 1);
    this.source = this.source.filter(x => x !== id);
  }
  prune(valid) {
    const current = this.current;
    const before = this.order.slice(0, this.index).filter(id => valid.has(id)).length;
    this.source = this.source.filter(id => valid.has(id));
    this.order = this.order.filter(id => valid.has(id));
    this.index = current && valid.has(current) ? before : -1;
  }
  toJSON() { return { source: this.source, order: this.order, index: this.index, shuffle: this.shuffle, repeat: this.repeat, context: this.context }; }
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
export function formatBytes(bytes = 0) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
export function escapeHTML(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
