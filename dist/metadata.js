const ascii = bytes => new TextDecoder('latin1').decode(bytes);
const utf8 = bytes => new TextDecoder().decode(bytes);
const synchsafe = b => ((b[0] & 127) << 21) | ((b[1] & 127) << 14) | ((b[2] & 127) << 7) | (b[3] & 127);
const uint32 = b => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
const clean = s => s.replace(/\u0000/g, '').trim();
function textFrame(bytes) {
  if (!bytes.length) return '';
  const enc = bytes[0];
  try { return clean(new TextDecoder(enc === 0 ? 'latin1' : enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : 'utf-8').decode(bytes.subarray(1))); } catch { return ''; }
}
function skipTerminator(bytes, start, wide = false) {
  for (let p = start; p < bytes.length - (wide ? 1 : 0); p += wide ? 2 : 1) {
    if (bytes[p] === 0 && (!wide || bytes[p + 1] === 0)) return p + (wide ? 2 : 1);
  }
  return bytes.length;
}
function picture(bytes, v2 = false) {
  let pos = 1;
  let mime;
  if (v2) { mime = ascii(bytes.subarray(pos, pos + 3)).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg'; pos += 3; }
  else { const end = skipTerminator(bytes, pos); mime = ascii(bytes.subarray(pos, end - 1)); pos = end; }
  pos++; // picture type
  pos = skipTerminator(bytes, pos, bytes[0] === 1 || bytes[0] === 2);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime) || bytes.length - pos > 1500000 || pos >= bytes.length) return null;
  return new Blob([bytes.subarray(pos)], { type: mime });
}
export function parseID3(bytes) {
  if (ascii(bytes.subarray(0, 3)) !== 'ID3') return {};
  const version = bytes[3];
  if (![2, 3, 4].includes(version)) return {};
  const result = {};
  const end = Math.min(bytes.length, 10 + synchsafe(bytes.subarray(6, 10)));
  let offset = 10;
  if (bytes[5] & 64 && version !== 2) offset += version === 4 ? synchsafe(bytes.subarray(10, 14)) : uint32(bytes.subarray(10, 14)) + 4;
  const names = { TIT2:'title', TT2:'title', TPE1:'artist', TP1:'artist', TALB:'album', TAL:'album', TRCK:'trackNumber', TRK:'trackNumber' };
  while (offset + (version === 2 ? 6 : 10) <= end) {
    const headerSize = version === 2 ? 6 : 10;
    const id = ascii(bytes.subarray(offset, offset + (version === 2 ? 3 : 4)));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const size = version === 2 ? ((bytes[offset+3]<<16) | (bytes[offset+4]<<8) | bytes[offset+5]) : version === 4 ? synchsafe(bytes.subarray(offset+4, offset+8)) : uint32(bytes.subarray(offset+4, offset+8));
    if (size <= 0 || offset + headerSize + size > end) break;
    const data = bytes.subarray(offset + headerSize, offset + headerSize + size);
    const unsupported = version === 3 ? bytes[offset+9] & 0xe0 : version === 4 ? bytes[offset+9] & 0x4d : 0;
    if (!unsupported) {
      if (names[id]) result[names[id]] = textFrame(data).slice(0, 500);
      if ((id === 'APIC' || id === 'PIC') && !result.artwork) result.artwork = picture(data, version === 2);
      if (id === 'TLEN') result.duration = Number(textFrame(data)) / 1000 || undefined;
    }
    offset += headerSize + size;
  }
  return result;
}
function parseFLAC(bytes) {
  if (ascii(bytes.subarray(0, 4)) !== 'fLaC') return {};
  const result = {};
  let p = 4;
  while (p + 4 <= bytes.length) {
    const last = !!(bytes[p] & 128), type = bytes[p] & 127;
    const size = (bytes[p+1] << 16) | (bytes[p+2] << 8) | bytes[p+3];
    const b = bytes.subarray(p+4, p+4+size);
    if (b.length < size) break;
    if (type === 0 && b.length >= 18) {
      const rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const samples = (b[13] & 15) * 4294967296 + uint32(b.subarray(14,18));
      if (rate) result.duration = samples / rate;
    }
    if (type === 4) {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      let q = 4 + dv.getUint32(0, true);
      if (q + 4 <= b.length) {
        const count = dv.getUint32(q, true); q += 4;
        for (let i = 0; i < Math.min(count,1000) && q+4 <= b.length; i++) {
          const len = dv.getUint32(q,true); q+=4;
          if (q+len > b.length) break;
          const line = utf8(b.subarray(q,q+len)); q+=len;
          const eq = line.indexOf('=');
          const field = {TITLE:'title', ARTIST:'artist', ALBUM:'album', TRACKNUMBER:'trackNumber'}[line.slice(0,eq).toUpperCase()];
          if (field) result[field] = clean(line.slice(eq+1)).slice(0,500);
        }
      }
    }
    if (type === 6 && b.length > 32) {
      let q = 4, len = uint32(b.subarray(q,q+4)); q+=4;
      const mime = ascii(b.subarray(q,q+len)); q+=len;
      if (q+4 <= b.length) {
        len=uint32(b.subarray(q,q+4)); q+=4+len+16;
        if (q+4<=b.length) {
          len=uint32(b.subarray(q,q+4)); q+=4;
          if (len<=1500000 && q+len<=b.length && ['image/jpeg','image/png','image/webp'].includes(mime)) result.artwork=new Blob([b.subarray(q,q+len)],{type:mime});
        }
      }
    }
    p += 4 + size;
    if (last) break;
  }
  return result;
}
function parseMP4Atoms(bytes, result = {}, level = 0) {
  if (level > 8) return result;
  let p = 0;
  while (p + 8 <= bytes.length) {
    const size = uint32(bytes.subarray(p,p+4));
    const type = ascii(bytes.subarray(p+4,p+8));
    if (size < 8 || p+size > bytes.length) break;
    const data = bytes.subarray(p+8,p+size);
    if (['moov','udta','ilst','trak','mdia'].includes(type)) parseMP4Atoms(data,result,level+1);
    if (type === 'meta') parseMP4Atoms(data.subarray(4),result,level+1);
    if (type === 'mdhd' && data.length >= 20 && data[0] === 0) {
      const scale=uint32(data.subarray(12,16)), duration=uint32(data.subarray(16,20));
      if(scale) result.duration=duration/scale;
    }
    const field = {'©nam':'title','©ART':'artist','aART':'artist','©alb':'album'}[type];
    if (field || type === 'covr' || type === 'trkn') {
      if (data.length >= 16 && ascii(data.subarray(4,8)) === 'data') {
        const value=data.subarray(16);
        if(field && !result[field]) result[field]=clean(utf8(value)).slice(0,500);
        if(type === 'trkn' && value.length >= 4) result.trackNumber=(value[2]<<8)|value[3];
        if(type === 'covr' && value.length<=1500000) {
          const kind=uint32(data.subarray(8,12));
          if([13,14].includes(kind)) result.artwork=new Blob([value],{type:kind===14?'image/png':'image/jpeg'});
        }
      }
    }
    p += size;
  }
  return result;
}
export const audioExtensions = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|aiff|aif|mp4|webm)$/i;
export function isAudio(file) { return file.type?.startsWith('audio/') || audioExtensions.test(file.name); }
export function mimeFor(file) {
  const ext=file.name.split('.').pop().toLowerCase();
  return {mp3:'audio/mpeg',m4a:'audio/mp4',mp4:'audio/mp4',aac:'audio/aac',flac:'audio/flac',wav:'audio/wav',ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/ogg',aiff:'audio/aiff',aif:'audio/aiff',webm:'audio/webm'}[ext] || file.type || 'application/octet-stream';
}
export async function fingerprint(file) {
  const head = await file.slice(0,65536).arrayBuffer();
  const tail = await file.slice(Math.max(0,file.size-65536)).arrayBuffer();
  const payload = new Uint8Array(8+head.byteLength+tail.byteLength);
  new DataView(payload.buffer).setBigUint64(0,BigInt(file.size));
  payload.set(new Uint8Array(head),8); payload.set(new Uint8Array(tail),8+head.byteLength);
  const digest = await crypto.subtle.digest('SHA-256',payload);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function readMetadata(file, path = '') {
  const filename = file.name.replace(/\.[^.]+$/,'');
  const split = filename.split(' - ');
  const fallback = { title: (split.length>1 ? split.slice(1).join(' - ') : filename).replace(/^\d{1,3}[. _-]+/,''), artist:split.length>1?split[0]:'Unknown artist', album:path.includes('/') ? path.split('/').at(-2) : 'Unknown album' };
  try {
    const bytes = new Uint8Array(await file.slice(0,3*1024*1024).arrayBuffer());
    let tags = {...parseID3(bytes), ...parseFLAC(bytes)};
    if(ascii(bytes.subarray(4,8))==='ftyp') {
      let pos=0;
      for(let n=0;n<100 && pos+8<=file.size;n++) {
        const head=new Uint8Array(await file.slice(pos,pos+16).arrayBuffer());
        let size=uint32(head.subarray(0,4));
        const type=ascii(head.subarray(4,8));
        let hdr=8;
        if(size===1 && head.length>=16){size=Number(new DataView(head.buffer).getBigUint64(8));hdr=16;}
        if(size<hdr || pos+size>file.size) break;
        if(type==='moov' && size<8*1024*1024) { tags={...tags,...parseMP4Atoms(new Uint8Array(await file.slice(pos+hdr,pos+size).arrayBuffer()))}; break; }
        pos+=size;
      }
    }
    if(!tags.title && file.size>=128) {
      const tail=new Uint8Array(await file.slice(-128).arrayBuffer());
      if(ascii(tail.subarray(0,3))==='TAG') tags={...tags,title:clean(ascii(tail.subarray(3,33))),artist:clean(ascii(tail.subarray(33,63))),album:clean(ascii(tail.subarray(63,93)))};
    }
    return {...fallback,...Object.fromEntries(Object.entries(tags).filter(([,v])=>v))};
  } catch { return fallback; }
}
