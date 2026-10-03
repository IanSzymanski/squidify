// Source positions are seconds in the original file. Timeline seconds include
// playback rate and overlap. Playlist order is the only source of sequence order.
export const clamp = (value, min, max, fallback = min) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback));
export const copy = value => JSON.parse(JSON.stringify(value));
export const pairKey = (a, b) => JSON.stringify([a, b]);
export const defaultEffects = () => ({ gain: 0, bass: 0, treble: 0, pan: 0, reverb: 0, delay: 0, distortion: 0 });
export function cleanEffects(fx = {}) {
  return Object.fromEntries(Object.entries(defaultEffects()).map(([key, value]) => [key, clamp(fx[key], ...({gain:[-24,6],bass:[-12,12],treble:[-12,12],pan:[-1,1]}[key] || [0,1]), value)]));
}
export function cleanClip(saved, track) {
  const duration = Math.max(.05, Number(track.duration) || 1);
  const start = clamp(saved?.in, 0, duration - .05);
  return { id: saved?.id || `clip-${track.id}`, trackId: track.id, sourceDuration: duration, in: start,
    out: clamp(saved?.out ?? duration, start + .05, duration), rate: clamp(saved?.rate ?? 1, .5, 2, 1), effects: cleanEffects(saved?.effects) };
}
export function reconcileMix(saved, order, tracks) {
  if (saved?.version > 1) throw new Error('This mix was made in a newer Squidify. Update the app before editing it.');
  const clips = {}, transitions = {};
  for (const id of order) { const track = tracks.get(id); if (track) clips[id] = cleanClip(saved?.clips?.[id], track); }
  // Retain pair edits when moving songs away and back, but never apply one
  // neighbor's transition to a different song.
  for (const [key, transition] of Object.entries(saved?.transitions || {})) {
    transitions[key] = { duration: clamp(transition.duration, 0, 30), curve: ['linear','equal-power','smooth'].includes(transition.curve) ? transition.curve : 'equal-power' };
  }
  return { version: 1, clips, transitions };
}
export function buildTimeline(mix, order) {
  const entries = order.filter(id => mix.clips[id]).map(id => ({ ...mix.clips[id], length: (mix.clips[id].out - mix.clips[id].in) / mix.clips[id].rate, start: 0, end: 0, incoming: 0, outgoing: 0 }));
  let end = 0;
  entries.forEach((entry, index) => {
    const previous = entries[index - 1];
    const transition = previous && mix.transitions[pairKey(previous.trackId, entry.trackId)];
    // Half-length limits prevent three clips from playing simultaneously.
    entry.incoming = previous ? Math.min(transition?.duration || 0, previous.length / 2, entry.length / 2) : 0;
    entry.inCurve = transition?.curve || 'equal-power';
    if (previous) { previous.outgoing = entry.incoming; previous.outCurve = entry.inCurve; }
    entry.start = end - entry.incoming; entry.end = entry.start + entry.length; end = entry.end;
  });
  return { entries, duration: end };
}
export function fadeValue(progress, incoming, curve) {
  const x = clamp(progress, 0, 1);
  if (curve === 'equal-power') return incoming ? Math.sin(x * Math.PI / 2) : Math.cos(x * Math.PI / 2);
  const y = curve === 'smooth' ? x*x*(3-2*x) : x;
  return incoming ? y : 1-y;
}
export function envelopeAt(entry, time) {
  if (time < entry.start || time >= entry.end) return 0;
  if (entry.incoming && time < entry.start + entry.incoming) return fadeValue((time-entry.start)/entry.incoming, true, entry.inCurve);
  if (entry.outgoing && time > entry.end-entry.outgoing) return fadeValue((time-(entry.end-entry.outgoing))/entry.outgoing, false, entry.outCurve);
  return 1;
}
export function moveOrder(order, id, targetId, after = false) {
  if (id === targetId || !order.includes(id) || !order.includes(targetId)) return [...order];
  const next = order.filter(item => item !== id), index = next.indexOf(targetId) + (after ? 1 : 0);
  next.splice(index, 0, id); return next;
}
export function timeLabel(seconds, precise = false) {
  const units = precise ? 100 : 1, ticks = Math.floor(Math.max(0, Number(seconds) || 0)*units + .000001);
  return `${Math.floor(ticks / (60*units))}:${((ticks % (60*units))/units).toFixed(precise ? 2 : 0).padStart(precise ? 5 : 2, '0')}`;
}
export function parseTime(value) {
  const parts = String(value).trim().split(':');
  if (parts.length > 2 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.length === 2 ? Number(parts[0])*60 + Number(parts[1]) : Number(parts[0]);
}
