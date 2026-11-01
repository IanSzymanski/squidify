export const MAX_AUDIO_BYTES=50*1024*1024;
export const MAX_PLAYLIST_ENTRIES=500;
const VIDEO_ID=/^[A-Za-z0-9_-]{11}$/;
const LIST_ID=/^[A-Za-z0-9_-]{12,64}$/;
const JOB_ID=/^[a-f0-9]{48}$/;
const YOUTUBE_HOSTS=['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'];
// The converter sends MP3, or YouTube's original AAC audio in an .m4a without re-encoding.
const AUDIO_TYPES={'audio/mpeg':'mp3','audio/mp4':'m4a'};
const watchURL=id=>`https://www.youtube.com/watch?v=${id}`;
function parseYouTube(value){
  if(typeof value!=='string'||value.length>2048)throw new Error('Enter a YouTube video link.');
  value=value.trim();if(VIDEO_ID.test(value))return {video:value,list:null,mix:false};
  let url;try{url=new URL(value);}catch{throw new Error('Enter a YouTube video link.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)throw new Error('Enter a YouTube video link.');
  let id,list=null,mix=false;const youtube=url.hostname==='youtu.be'||YOUTUBE_HOSTS.includes(url.hostname);
  if(url.hostname==='youtu.be')id=url.pathname.slice(1);
  else if(YOUTUBE_HOSTS.includes(url.hostname)){
    if(url.pathname==='/watch'){const ids=url.searchParams.getAll('v');if(ids.length===1)id=ids[0];}
    else id=url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  }
  if(youtube){const lists=url.searchParams.getAll('list');if(lists.length===1&&LIST_ID.test(lists[0])){if(lists[0].startsWith('RD'))mix=true;else list=lists[0];}}
  return {video:VIDEO_ID.test(id||'')?id:null,list,mix};
}
// A single video. Playlist parameters are ignored, so a song opened from a playlist converts on its own.
export function youtubeURL(value){
  const {video}=parseYouTube(value);
  if(!video)throw new Error('Use a single YouTube video, Shorts, Music or youtu.be link.');
  return watchURL(video);
}
// A video, a playlist, or both (a video opened from inside a playlist). Mixes never end, so they count as the video alone.
export function youtubeTarget(value){
  const {video,list,mix}=parseYouTube(value);
  if(!video&&!list)throw new Error(mix?'YouTube Mix playlists never end, so they can’t be converted. Use a regular playlist.':'Use a YouTube video or playlist link.');
  return {video:video?watchURL(video):null,playlist:list?`https://www.youtube.com/playlist?list=${list}`:null};
}
export function converterConfig(endpoint,token){
  let url;try{url=new URL(String(endpoint).trim());}catch{throw new Error('Enter the HTTPS address of your converter service.');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Use an HTTPS service address without a password, query or fragment.');
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(String(token).trim()))throw new Error('Enter the service access key (32–256 letters, numbers, hyphens or underscores).');
  return {endpoint:url.href.replace(/\/+$/,''),token:String(token).trim()};
}
export const audioFilename=(title,ext='mp3')=>(String(title||'YouTube audio').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g,' ').trim().replace(/\.(mp3|m4a)$/i,'').slice(0,150)||'YouTube audio')+'.'+ext;
const isMP3=data=>data.length>=4&&((data[0]===73&&data[1]===68&&data[2]===51)||(data[0]===255&&(data[1]&224)===224));
const isMP4=data=>data.length>=12&&String.fromCharCode(...data.subarray(4,8))==='ftyp';

export function createConverterClient(config,{fetcher=(...args)=>fetch(...args)}={}){
  const {endpoint,token}=converterConfig(config.endpoint,config.token);
  const jobPath=id=>{if(!JOB_ID.test(id))throw new Error('The converter returned an invalid job reference.');return `api/jobs/${id}`;};
  async function request(path,{method='GET',body,signal}={},consume,timeout=20000){
    const controller=new AbortController(),abort=()=>controller.abort();
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    signal?.addEventListener('abort',abort,{once:true});
    let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
    try{
      const response=await fetcher(`${endpoint}/${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:controller.signal,mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'});
      if(!response.ok){let data;try{data=JSON.parse(new TextDecoder().decode(await bytes(response,65536)));}catch{}const error=new Error(data?.error||(response.status===401?'The service access key was not accepted.':`Converter request failed (${response.status}).`));error.status=response.status;throw error;}
      return await consume(response);
    }catch(error){if(timedOut)throw new Error('The converter took too long to respond. Retry this conversion.');if(signal?.aborted)throw new DOMException('Cancelled','AbortError');if(error instanceof TypeError)throw new Error('Cannot reach the converter. Check its address, connection and allowed Squidify origin.');throw error;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  async function bytes(response,limit,onProgress){
    const declared=Number(response.headers.get('content-length'))||0;
    if(declared>limit){await response.body?.cancel();throw new Error('The converted file is larger than the allowed limit.');}
    if(!response.body?.getReader)throw new Error('This browser cannot receive the converted audio.');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error('The converted file is larger than the allowed limit.');chunks.push(value);onProgress?.(size,declared);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    if(declared&&size!==declared)throw new Error('The audio transfer was incomplete. Retry this conversion.');
    const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
  }
  const json=(path,options={},timeout)=>request(path,options,async response=>{
    if(!(response.headers.get('content-type')||'').includes('application/json'))throw new Error('This address did not return a Squidify converter response.');
    try{return JSON.parse(new TextDecoder().decode(await bytes(response,1048576)));}catch(error){throw new Error('The converter returned an unreadable response.');}
  },timeout);
  return {
    async check(signal){const value=await json('api/health',{signal});if(value.service!=='squidify-converter'||value.api_version!==1)throw new Error('This address is not a compatible Squidify converter.');if(!value.ready)throw new Error('The service is running, but its conversion tools are unavailable.');return value;},
    async start(url,signal){const value=await json('api/convert',{method:'POST',body:{url:youtubeURL(url),format:'original'},signal});jobPath(value.job_id);return value.job_id;},
    // Lists a playlist's videos without converting anything. Large playlists take a while to read.
    async playlist(url,signal){
      let value;try{value=await json('api/playlist',{method:'POST',body:{url},signal},120000);}
      catch(error){if(error.status===404||error.status===405)throw new Error('This converter can’t read playlists yet. Update it, or convert videos one at a time.');throw error;}
      if(!Array.isArray(value?.entries))throw new Error('The converter returned an unreadable playlist.');
      const entries=value.entries.filter(entry=>VIDEO_ID.test(entry?.id||'')).slice(0,MAX_PLAYLIST_ENTRIES).map(entry=>({id:entry.id,title:String(entry.title||'YouTube video').slice(0,200)}));
      return {title:String(value.title||'YouTube playlist').trim().slice(0,100)||'YouTube playlist',entries,unavailable:Math.max(0,Number(value.unavailable)||0),truncated:!!value.truncated};
    },
    status:(id,signal)=>json(jobPath(id),{signal}),
    cancel:(id,signal)=>json(jobPath(id),{method:'DELETE',signal}),
    complete:(id,signal)=>json(jobPath(id)+'/complete',{method:'POST',signal}),
    download(id,title,signal,onProgress){jobPath(id);return request(`api/download/${id}`,{signal},async response=>{
      const type=(response.headers.get('content-type')||'').toLowerCase().split(';')[0].trim(),ext=AUDIO_TYPES[type];
      if(!ext)throw new Error('The service did not return MP3 or M4A audio.');
      const data=await bytes(response,MAX_AUDIO_BYTES,onProgress);
      if(!(ext==='mp3'?isMP3:isMP4)(data))throw new Error(`The converted audio is empty or is not a valid ${ext.toUpperCase()} file.`);
      return new File([data],audioFilename(title,ext),{type,lastModified:0});
    },120000);}
  };
}
