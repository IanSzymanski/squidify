import { COVER_STYLES, COVER_LAYERS, coverDesign, coverOptions } from './cover-art.js';
import { escapeHTML as esc } from './core.js';
import * as db from './storage.js';

export function createCoverEditor(context,onSave){
  const {state,playlist,modal,nowDialog}=context;
  let target=null,draft=null,busy=false,revision=0,previewURL=null;
  const input=document.createElement('input');input.type='file';input.accept='image/jpeg,image/png,image/webp,image/avif,image/gif';input.hidden=true;document.body.append(input);
  const tracksFor=id=>[...state.tracks.values()].filter(t=>`${t.album}\u241f${t.artist}`===id);
  const releasePreview=()=>{if(previewURL)URL.revokeObjectURL(previewURL);previewURL=null;};
  modal.addEventListener('close',()=>{revision++;releasePreview();});
  function coverDialog(kind,id){
    if(busy)return;revision++;releasePreview();target={kind,id};
    const tracks=kind==='album'?tracksFor(id):[];
    const p=kind==='playlist'?playlist(id):tracks[0]&&{...tracks[0],...(tracks[0].albumCover||{}),id:'album:'+id,name:tracks[0].album,trackIds:tracks.map(t=>t.id)};
    if(!p)return;
    draft={...p,coverDesign:coverDesign(p)};show();
  }
  const select=(name,label,options,value)=>`<label for="cover-${name}">${label}</label><select id="cover-${name}" class="text-input" name="${name}">${options.map(([v,t])=>`<option value="${v}" ${String(value)===String(v)?'selected':''}>${t}</option>`).join('')}</select>`;
  const range=(name,label,min,max,value,unit='')=>`<label class="cover-range" for="cover-${name}"><span>${label}<output>${value}${unit}</output></span><input id="cover-${name}" name="${name}" type="range" min="${min}" max="${max}" value="${value}" data-unit="${unit}"></label>`;
  function show(){
    const d=coverDesign(draft),o=coverOptions(draft);
    context.ui.setModal(context.ui.modalHead(target.kind==='playlist'?'Playlist artwork':'Album artwork')+`<form id="coverSettingsForm"><div class="cover-editor-layout"><div class="cover-preview-column"><div class="cover-preview" aria-label="Live cover preview"></div><div class="cover-editor-actions"><button type="button" class="button" data-action="choose-cover">Upload image / GIF</button><button type="button" class="button" data-action="vary-cover">Randomize cover</button><button type="button" class="button quiet" data-action="remove-cover">Use generated artwork</button>${target.kind==='album'&&(draft.originalArtwork||draft.artwork)?'<button type="button" class="button quiet" data-restore-cover>Restore embedded cover</button>':''}</div><p class="small-note">JPEG, PNG, WebP, AVIF or GIF · up to 25 MB. Saved on this device. GIF animation is preserved.</p><p class="small-note">Changes apply when you save.</p></div><div class="cover-controls">
      ${draft.artwork?`<h3>Image placement</h3>${range('imageX','Horizontal crop',0,100,d.imageX,'%')}${range('imageY','Vertical crop',0,100,d.imageY,'%')}${range('imageScale','Zoom',100,200,d.imageScale,'%')}<p class="small-note">Randomize adjusts the placement of your uploaded image.</p>`:`${select('style','Composition',COVER_STYLES.map((n,i)=>[i,n]),o.style)}<div class="cover-colors">${['Primary','Secondary','Background'].map((n,i)=>`<label>${n}<input type="color" name="color${i}" value="${d.colors[i]}"></label>`).join('')}</div><h3>Objects & effects</h3><div class="cover-features">${COVER_LAYERS.map(key=>`<label class="cover-toggle"><input type="checkbox" name="feature-${key}" ${d.layers[key].enabled?'checked':''}>${key==='stars'?'Sparkles':key[0].toUpperCase()+key.slice(1)}</label>`).join('')}</div>${select('object','Place an object',COVER_LAYERS.map(k=>[k,k==='stars'?'Sparkles':k[0].toUpperCase()+k.slice(1)]),'ribbons')}<div data-layer-controls></div><p class="small-note">Drag on the preview to move the selected object, or use the sliders.</p>`}
      <h3>Animation</h3>${select('motion','Motion',[['drift','Subtle drift'],['breathe','Soft breathing'],['off','Still']],d.motion)}${range('speed','Cycle length',8,60,d.speed,'s')}${draft.artwork?.type==='image/gif'?'<p class="small-note">Motion controls the cover movement; the GIF keeps its original animation.</p>':''}
      <h3>Cover text</h3><label class="cover-toggle"><input name="title" type="checkbox" ${o.title?'checked':''}>Show ${target.kind} name</label><label class="cover-toggle"><input name="info" type="checkbox" ${o.info?'checked':''}>Show song count and duration</label>${select('textPosition','Text placement',[['top','Top'],['center','Center'],['bottom','Bottom']],d.textPosition)}
      </div></div><div class="modal-actions"><button type="button" class="button" data-action="close-modal">Cancel</button><button type="submit" class="button primary">Save artwork</button></div></form>`,'cover-editor-modal');
    modal.querySelector('[data-restore-cover]')?.addEventListener('click',()=>saveCover(draft.originalArtwork===undefined?draft.artwork:draft.originalArtwork));
    renderLayerControls();preview();bindDrag();
  }
  function preview(){
    const el=modal.querySelector('.cover-preview');if(!el||!draft)return;
    if(draft.artwork&&!previewURL)previewURL=URL.createObjectURL(draft.artwork);
    el.innerHTML=context.ui.collectionArt({...draft,coverPreviewURL:previewURL});
  }
  function renderLayerControls(){const form=modal.querySelector('#coverSettingsForm'),el=form?.querySelector('[data-layer-controls]');if(!el)return;const l=draft.coverDesign.layers[form.elements.object.value];el.innerHTML=range('x','Horizontal position',-100,100,l.x,'%')+range('y','Vertical position',-100,100,l.y,'%')+range('scale','Size',25,200,l.scale,'%')+range('rotation','Rotation',-180,180,l.rotation,'°')+range('opacity','Opacity',0,100,l.opacity,'%');}
  modal.addEventListener('input',e=>{
    const form=e.target.closest('#coverSettingsForm');if(!form||!draft||busy)return;
    const n=e.target.name,v=e.target.value,d=draft.coverDesign;
    if(n==='object'){renderLayerControls();return;}
    if(n==='style'){draft.coverStyle=Number(v);delete d.layers;draft.coverDesign=coverDesign(draft);COVER_LAYERS.forEach(k=>{form.elements['feature-'+k].checked=draft.coverDesign.layers[k].enabled;});renderLayerControls();}
    else if(n.startsWith('color'))d.colors[Number(n.slice(-1))]=v;
    else if(n.startsWith('feature-'))d.layers[n.slice(8)].enabled=e.target.checked;
    else if(['x','y','scale','rotation','opacity'].includes(n))d.layers[form.elements.object.value][n]=Number(v);
    else if(['imageX','imageY','imageScale','speed'].includes(n))d[n]=Number(v);
    else if(['motion','textPosition'].includes(n))d[n]=v;
    else if(n==='title')draft.coverTitle=e.target.checked;
    else if(n==='info')draft.coverInfo=e.target.checked;
    const output=e.target.closest('label')?.querySelector('output');if(output)output.textContent=v+(e.target.dataset.unit||'');preview();
  });
  function bindDrag(){
    const el=modal.querySelector('.cover-preview');let drag;
    el.style.touchAction='none';
    el.addEventListener('pointerdown',e=>{if(busy||draft.artwork)return;const object=modal.querySelector('[name="object"]').value,l=draft.coverDesign.layers[object];drag={id:e.pointerId,x:e.clientX,y:e.clientY,startX:l.x,startY:l.y,object,width:el.clientWidth};el.setPointerCapture(e.pointerId);});
    el.addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.id)return;const l=draft.coverDesign.layers[drag.object];l.x=Math.round(Math.max(-100,Math.min(100,drag.startX+(e.clientX-drag.x)/drag.width*200)));l.y=Math.round(Math.max(-100,Math.min(100,drag.startY+(e.clientY-drag.y)/drag.width*200)));renderLayerControls();preview();});
    for(const event of ['pointerup','pointercancel'])el.addEventListener(event,()=>{drag=null;});
  }
  function randomize(){
    if(!draft||busy)return;const rand=(a,b)=>Math.round(a+Math.random()*(b-a));
    if(draft.artwork){Object.assign(draft.coverDesign,{imageX:rand(10,90),imageY:rand(10,90),imageScale:rand(105,145)});}
    else {draft.coverVariation=(Number(draft.coverVariation)||0)+1;draft.coverStyle=rand(0,COVER_STYLES.length-1);const palettes=[['#0eedb5','#ae00ff','#080a16'],['#5cdfff','#f981cf','#090e20'],['#ffaa73','#aa78ff','#170c24'],['#e0ff98','#30d8cb','#071b20']];draft.coverDesign={...draft.coverDesign,colors:palettes[rand(0,3)],layers:undefined};draft.coverDesign=coverDesign(draft);for(const l of Object.values(draft.coverDesign.layers)){l.x=rand(-40,40);l.y=rand(-40,40);l.rotation=rand(-90,90);l.scale=rand(65,140);}}
    show();
  }
  function chooseCover(){if(busy)return;state.pickerOpen=true;input.click();}
  input.addEventListener('cancel',()=>{state.pickerOpen=false;});
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];input.value='';state.pickerOpen=false;if(!file||!draft||busy)return;
    const token=++revision;
    try{
      if(file.size>25*1024*1024)throw new Error('Choose an image or GIF smaller than 25 MB.');
      if(!/^image\/(jpeg|png|webp|avif|gif)$/.test(file.type))throw new Error('Choose a JPEG, PNG, WebP, AVIF or GIF.');
      const url=URL.createObjectURL(file);
      try{const img=new Image();img.src=url;await img.decode();if(!img.naturalWidth||!img.naturalHeight)throw new Error('This image could not be read.');}finally{URL.revokeObjectURL(url);}
      if(token!==revision||!modal.open)return;
      releasePreview();draft.artwork=file;draft.coverDesign.imageX=50;draft.coverDesign.imageY=50;draft.coverDesign.imageScale=100;show();
    }catch(error){context.ui.toast(error.message||'This image could not be read.',true);}
  });
  function saveCover(blob=null){if(!draft||busy)return;releasePreview();draft.artwork=blob;show();}
  async function saveCoverSettings(form,vary=false){
    if(vary){randomize();return;}if(!draft||!target||busy)return;busy=true;
    const buttons=[...form.querySelectorAll('button,input,select')];buttons.forEach(b=>b.disabled=true);
    try{
      const settings={coverStyle:draft.coverStyle,coverVariation:draft.coverVariation,coverTitle:draft.coverTitle,coverInfo:draft.coverInfo,coverDesign:coverDesign(draft)};
      if(target.kind==='playlist'){
        const p=playlist(target.id);if(!p)throw new Error('This playlist no longer exists.');
        const next={...p,...settings,artwork:draft.artwork||null};await db.put('playlists',next);Object.assign(p,next);context.ui.releaseArtwork('playlist:'+p.id);
      }else{
        const tracks=tracksFor(target.id);if(!tracks.length)throw new Error('This album no longer exists.');
        const next=tracks.map(t=>({...t,originalArtwork:t.originalArtwork===undefined?t.artwork:t.originalArtwork,artwork:draft.artwork||null,albumCover:settings}));await db.putTracks(next);
        for(const t of next){state.tracks.set(t.id,t);context.ui.releaseArtwork(t.id);}context.ui.releaseArtwork('playlist:album:'+target.id);
      }
      onSave();modal.close();context.ui.render();if(nowDialog.open)context.ui.renderNowPlaying();context.playback.updateMediaSession();context.ui.toast('Artwork saved.');
      db.storageInfo().then(info=>{state.storage=info;}).catch(()=>{});
    }finally{busy=false;buttons.forEach(b=>b.disabled=false);}
  }
  return {coverDialog,saveCoverSettings,chooseCover,saveCover};
}
