import { escapeHTML as esc } from './core.js';

export const COVER_STYLES = ['Prism', 'Aurora', 'Halo', 'Stardust', 'Silk', 'Aurora prism', 'Luminous silk', 'Celestial'];
export function coverSeed(p) {
  let seed=0;for(const c of `${p.id || 'playlist'}:${Number(p.coverVariation)||0}`)seed=(Math.imul(seed,31)+c.charCodeAt(0))>>>0;
  return seed;
}
export function coverOptions(p) {
  const seed=coverSeed(p),saved=Number(p.coverStyle);
  return {seed,style:p.coverStyle!=null&&Number.isInteger(saved)&&saved>=0&&saved<COVER_STYLES.length?saved:seed%COVER_STYLES.length,title:p.coverTitle!==false,info:p.coverInfo!==false};
}
export function coverSVG(p) {
  const {seed,style}=coverOptions(p);let n=seed;
  const rand=()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/4294967296;};
  const angle=seed%360,fold=[0,4,5,6,7].includes(style),aurora=[1,5,7].includes(style),halo=[2,6,7].includes(style),stars=[3,5,7].includes(style);
  const ribbons=Array.from({length:aurora?5:fold?3:0},(_,i)=>{const y=50+i*85+rand()*40;return `<path d="M -100 ${y+140} C 80 ${y-210}, 210 ${y+220}, 610 ${y-90}" fill="none" stroke="url(#iridescent)" stroke-width="${fold?32+rand()*95:18+rand()*50}" opacity="${.35+rand()*.5}" ${aurora?'filter="url(#soft)"':''}/>`;}).join('');
  const sparkles=stars?Array.from({length:26},()=>{const x=25+rand()*460,y=20+rand()*460,r=1+rand()*2;return `<circle cx="${x}" cy="${y}" r="${r}" fill="#dcfff8" opacity="${.3+rand()*.7}"/>${r>2.5?`<path d="M ${x-7} ${y} h 14 M ${x} ${y-7} v 14" stroke="#ffffff" stroke-width=".8"/>`:''}`;}).join(''):'';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="iridescent" x2="1" y2="1"><stop stop-color="#0eedb5"/><stop offset=".25" stop-color="#d8fff5"/><stop offset=".42" stop-color="#479da8"/><stop offset=".6" stop-color="#ae00ff"/><stop offset=".78" stop-color="#f6bdfb"/><stop offset="1" stop-color="#0eedb5"/></linearGradient><radialGradient id="glow"><stop stop-color="${seed%2?'#ae00ff':'#0eedb5'}" stop-opacity=".65"/><stop offset="1" stop-color="#080a16" stop-opacity="0"/></radialGradient><filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="17"/></filter></defs><rect width="512" height="512" fill="#080a16"/><ellipse cx="${150+seed%220}" cy="180" rx="330" ry="300" fill="url(#glow)"/><g transform="rotate(${angle} 256 256)">${ribbons}${[0,5].includes(style)?'<path d="M -90 350 L 240 -100 L 310 235 L 620 170 L 320 610 Z" fill="url(#iridescent)" opacity=".8"/><path d="M 240 -100 L 310 235 L 320 610 L 265 260 Z" fill="#060b24" opacity=".65"/>':''}${halo?'<ellipse cx="256" cy="256" rx="185" ry="125" fill="none" stroke="url(#iridescent)" stroke-width="38" filter="url(#soft)"/><ellipse cx="256" cy="256" rx="185" ry="125" fill="none" stroke="url(#iridescent)" stroke-width="4"/>':''}${style===3?'<ellipse cx="256" cy="256" rx="80" ry="230" fill="url(#glow)"/>':''}</g>${sparkles}</svg>`;
}
export function coverURL(p){return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(coverSVG(p));}
export function coverText(p,info='') {
  const opts=coverOptions(p);
  return opts.title||opts.info?`<span class="cover-copy">${opts.title?`<span class="cover-name">${esc(p.name)}</span>`:''}${opts.info?`<span class="cover-info">${esc(info)}</span>`:''}</span>`:'';
}
