export const MAX_AUDIO_BYTES=50*1024*1024;
const VIDEO_ID=/^[A-Za-z0-9_-]{11}$/;
const JOB_ID=/^[a-f0-9]{48}$/;
export function youtubeURL(value){
  if(typeof value!=='string'||value.length>2048)throw new Error('Enter a YouTube video link.');
  value=value.trim();if(VIDEO_ID.test(value))return `https://www.youtube.com/watch?v=${value}`;
  let url;try{url=new URL(value);}catch{throw new Error('Enter a YouTube video link.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)throw new Error('Enter a YouTube video link.');
  let id;
  if(url.hostname==='youtu.be')id=url.pathname.slice(1);
  else if(['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(url.hostname)){
    if(url.pathname==='/watch'){const ids=url.searchParams.getAll('v');if(ids.length===1)id=ids[0];}
    else id=url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  }
  if(!VIDEO_ID.test(id||''))throw new Error('Use a single YouTube video, Shorts, Music or youtu.be link.');
  return `https://www.youtube.com/watch?v=${id}`;
}
export function converterConfig(endpoint,token){
  let url;try{url=new URL(String(endpoint).trim());}catch{throw new Error('Enter the HTTPS address of your converter service.');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Use an HTTPS service address without a password, query or fragment.');
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(String(token).trim()))throw new Error('Enter the service access key (32–256 letters, numbers, hyphens or underscores).');
  return {endpoint:url.href.replace(/\/+$/,''),token:String(token).trim()};
}
export const audioFilename=title=>(String(title||'YouTube audio').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g,' ').trim().replace(/\.mp3$/i,'').slice(0,150)||'YouTube audio')+'.mp3';

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
  const json=(path,options={})=>request(path,options,async response=>{
    if(!(response.headers.get('content-type')||'').includes('application/json'))throw new Error('This address did not return a Squidify converter response.');
    try{return JSON.parse(new TextDecoder().decode(await bytes(response,65536)));}catch(error){throw new Error('The converter returned an unreadable response.');}
  });
  return {
    async check(signal){const value=await json('api/health',{signal});if(value.service!=='squidify-converter'||value.api_version!==1)throw new Error('This address is not a compatible Squidify converter.');if(!value.ready)throw new Error('The service is running, but its conversion tools are unavailable.');return value;},
    async start(url,signal){const value=await json('api/convert',{method:'POST',body:{url:youtubeURL(url)},signal});jobPath(value.job_id);return value.job_id;},
    status:(id,signal)=>json(jobPath(id),{signal}),
    cancel:(id,signal)=>json(jobPath(id),{method:'DELETE',signal}),
    complete:(id,signal)=>json(jobPath(id)+'/complete',{method:'POST',signal}),
    download(id,title,signal,onProgress){jobPath(id);return request(`api/download/${id}`,{signal},async response=>{
      if(!(response.headers.get('content-type')||'').toLowerCase().startsWith('audio/mpeg'))throw new Error('The service did not return MP3 audio.');
      const data=await bytes(response,MAX_AUDIO_BYTES,onProgress);
      if(data.length<4||!((data[0]===73&&data[1]===68&&data[2]===51)||(data[0]===255&&(data[1]&224)===224)))throw new Error('The converted audio is empty or is not a valid MP3 file.');
      return new File([data],audioFilename(title),{type:'audio/mpeg',lastModified:0});
    },120000);}
  };
}
