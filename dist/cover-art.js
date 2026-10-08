import { escapeHTML as esc } from './core.js';

export const COVER_STYLES = ['Prism', 'Aurora', 'Halo', 'Stardust', 'Silk', 'Aurora prism', 'Luminous silk', 'Celestial'];
export function coverSeed(p) {
  let seed=0;for(const c of `${p.id || 'playlist'}:${Number(p.coverVariation)||0}`)seed=(Math.imul(seed,31)+c.charCodeAt(0))>>>0;
  return seed;
}
export const COVER_LAYERS = ['glow','ribbons','prism','halo','stars'];
const clamp=(v,min,max,fallback)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Number(v))):fallback;
export function coverDesign(p) {
  const d=p.coverDesign||{}, style=coverOptions(p).style;
  const color=(v,f)=>/^#[0-9a-f]{6}$/i.test(v||'')?v:f;
  const enabled={glow:true,ribbons:[0,1,4,5,6,7].includes(style),prism:[0,5].includes(style),halo:[2,6,7].includes(style),stars:[3,5,7].includes(style)};
  return {colors:[color(d.colors?.[0],'#0eedb5'),color(d.colors?.[1],'#ae00ff'),color(d.colors?.[2],'#080a16')],motion:['off','drift','breathe'].includes(d.motion)?d.motion:'drift',speed:clamp(d.speed,8,60,22),textPosition:['top','center','bottom'].includes(d.textPosition)?d.textPosition:'bottom',imageX:clamp(d.imageX,0,100,50),imageY:clamp(d.imageY,0,100,50),imageScale:clamp(d.imageScale,100,200,100),layers:Object.fromEntries(COVER_LAYERS.map(key=>{const l=d.layers?.[key]||{};return [key,{enabled:typeof l.enabled==='boolean'?l.enabled:enabled[key],x:clamp(l.x,-100,100,0),y:clamp(l.y,-100,100,0),scale:clamp(l.scale,25,200,100),rotation:clamp(l.rotation,-180,180,0),opacity:clamp(l.opacity,0,100,100)}]}))};
}
export function coverPresentation(p){const d=coverDesign(p);return `--cover-speed:${d.speed}s;--image-x:${d.imageX}%;--image-y:${d.imageY}%;--image-scale:${d.imageScale/100};--cover-bg:${d.colors[2]}`;}
export function coverOptions(p) {
  const seed=coverSeed(p),saved=Number(p.coverStyle);
  return {seed,style:p.coverStyle!=null&&Number.isInteger(saved)&&saved>=0&&saved<COVER_STYLES.length?saved:seed%COVER_STYLES.length,title:p.coverTitle!==false,info:p.coverInfo!==false};
}
export function coverSVG(p, layer=null) {
  const {seed,style}=coverOptions(p);let n=seed;
  const rand=()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/4294967296;};
  const angle=seed%360,fold=[0,4,5,6,7].includes(style),aurora=[1,5,7].includes(style),halo=true,stars=true;
  const ribbons=Array.from({length:aurora?5:3},(_,i)=>{const y=50+i*85+rand()*40;return `<path d="M -100 ${y+140} C 80 ${y-210}, 210 ${y+220}, 610 ${y-90}" fill="none" stroke="url(#iridescent)" stroke-width="${fold?32+rand()*95:18+rand()*50}" opacity="${.35+rand()*.5}" ${aurora?'filter="url(#soft)"':''}/>`;}).join('');
  const sparkles=stars?Array.from({length:26},()=>{const x=25+rand()*460,y=20+rand()*460,r=1+rand()*2;return `<circle cx="${x}" cy="${y}" r="${r}" fill="#dcfff8" opacity="${.3+rand()*.7}"/>${r>2.5?`<path d="M ${x-7} ${y} h 14 M ${x} ${y-7} v 14" stroke="#ffffff" stroke-width=".8"/>`:''}`;}).join(''):'';
  const design=coverDesign(p);
  const wrap=(key,content)=>{const l=design.layers[key];return l.enabled&&(!layer||layer===key)?`<g opacity="${l.opacity/100}" transform="translate(${l.x*2.56} ${l.y*2.56}) translate(256 256) rotate(${l.rotation}) scale(${l.scale/100}) translate(-256 -256)">${key==='stars'||key==='glow'?content:`<g transform="rotate(${angle} 256 256)">${content}</g>`}</g>`:'';};
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="iridescent" x2="1" y2="1"><stop stop-color="#0eedb5"/><stop offset=".25" stop-color="#d8fff5"/><stop offset=".42" stop-color="#479da8"/><stop offset=".6" stop-color="#ae00ff"/><stop offset=".78" stop-color="#f6bdfb"/><stop offset="1" stop-color="#0eedb5"/></linearGradient><radialGradient id="glow"><stop stop-color="${seed%2?'#ae00ff':'#0eedb5'}" stop-opacity=".65"/><stop offset="1" stop-color="#080a16" stop-opacity="0"/></radialGradient><filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="17"/></filter></defs>${layer?'':`<rect width="512" height="512" fill="${design.colors[2]}"/>`}${wrap('glow',`<ellipse cx="${150+seed%220}" cy="180" rx="330" ry="300" fill="url(#glow)"/>`)}${wrap('ribbons',ribbons)}${wrap('prism','<path d="M -90 350 L 240 -100 L 310 235 L 620 170 L 320 610 Z" fill="url(#iridescent)" opacity=".8"/><path d="M 240 -100 L 310 235 L 320 610 L 265 260 Z" fill="#060b24" opacity=".65"/>')}${wrap('halo','<ellipse cx="256" cy="256" rx="185" ry="125" fill="none" stroke="url(#iridescent)" stroke-width="38" filter="url(#soft)"/><ellipse cx="256" cy="256" rx="185" ry="125" fill="none" stroke="url(#iridescent)" stroke-width="4"/>')}${wrap('stars',sparkles)}</svg>`.replaceAll('#0eedb5',design.colors[0]).replaceAll('#ae00ff',design.colors[1]);
}
export function coverURL(p,layer=null){return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(coverSVG(p,layer));}
export function coverImages(p){const d=coverDesign(p);return COVER_LAYERS.filter(k=>d.layers[k].enabled).map((key,i)=>`<img class="cover-layer layer-${key}" style="--layer-delay:-${i*3}s" src="${coverURL(p,key)}" alt="" loading="lazy">`).join('');}

export function coverText(p,info='') {
  const opts=coverOptions(p);
  return opts.title||opts.info?`<span class="cover-copy text-${coverDesign(p).textPosition}">${opts.title?`<span class="cover-name">${esc(p.name)}</span>`:''}${opts.info?`<span class="cover-info">${esc(info)}</span>`:''}</span>`:'';
}
