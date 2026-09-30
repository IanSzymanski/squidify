// Small FFT over decoded samples: native media playback remains untouched.
export const BAND_COUNT=18;
export function spectrumAt(channel,center,sampleRate){
 const n=256,re=new Float32Array(n),im=new Float32Array(n);
 for(let i=0;i<n;i++)re[i]=(channel[Math.round(center)-n/2+i]||0)*(.5-.5*Math.cos(2*Math.PI*i/(n-1)));
 for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)[re[i],re[j]]=[re[j],re[i]];}
 for(let len=2;len<=n;len<<=1){const angle=-2*Math.PI/len;for(let i=0;i<n;i+=len){for(let j=0;j<len/2;j++){const c=Math.cos(angle*j),s=Math.sin(angle*j),a=i+j,b=a+len/2,tr=re[b]*c-im[b]*s,ti=re[b]*s+im[b]*c;re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;}}}
 const levels=new Float32Array(BAND_COUNT),max=sampleRate/2;
 for(let b=0;b<BAND_COUNT;b++){const lo=55*Math.pow(max/55,b/BAND_COUNT),hi=55*Math.pow(max/55,(b+1)/BAND_COUNT);let peak=0;
  for(let k=Math.max(1,Math.floor(lo*n/sampleRate));k<=Math.min(n/2-1,Math.ceil(hi*n/sampleRate));k++)peak=Math.max(peak,Math.hypot(re[k],im[k])*4/n);
  levels[b]=Math.max(0,Math.min(1,(20*Math.log10(Math.max(1e-5,peak))+60)/60));
 }
 return levels;
}
export const followLevel=(current,target)=>current+(target-current)*(target>current?.92:.48);

// One apex per zone, joined directly: no synthetic shoulders or boundary dips.
// Optional bounds keep the outer baseline still on the full-width player canvas.
export function equalizerPoints(levels,width,height,motionStart=0,motionEnd=width){
 const zones=12,baseline=height-3,amplitude=Math.max(1,height-8),points=[{x:0,y:baseline}],peaks=[];
 const from=Math.max(0,Math.min(width,motionStart)),to=Math.max(from,Math.min(width,motionEnd));
 if(to<=from)return [{x:0,y:baseline},{x:width,y:baseline}];
 for(let zone=0;zone<zones;zone++){
  const start=zone*BAND_COUNT/zones,end=(zone+1)*BAND_COUNT/zones;let energy=0;
  for(let b=Math.floor(start);b<Math.ceil(end);b++){
   const weight=Math.min(end,b+1)-Math.max(start,b);
   energy+=(levels[b]||0)**2*weight;
  }
  peaks.push(Math.min(1,Math.sqrt(energy/(end-start))));
 }
 const strongest=Math.max(...peaks);
 if(from>0)points.push({x:from,y:baseline});
 for(let zone=0;zone<zones;zone++){
  // Preserve overall loudness while making quieter zones recede from the leader.
  const peak=strongest>0?strongest*Math.pow(peaks[zone]/strongest,2.4):0;
  points.push({x:from+(zone+.5)/zones*(to-from),y:baseline-peak*amplitude});
 }
 points.push({x:to,y:baseline});
 if(to<width)points.push({x:width,y:baseline});
 return points;
}

// Shape-preserving cubic tangents round the actual peaks without flattening
// every intermediate point or overshooting into a new valley. End tangents are
// zero so the moving contour joins the protected outer baseline smoothly.
export function equalizerTangents(points){
 const slopes=points.slice(1).map((p,i)=>(p.y-points[i].y)/(p.x-points[i].x));
 return points.map((p,i)=>{
  if(i===0||i===points.length-1||slopes[i-1]*slopes[i]<=0)return 0;
  const before=p.x-points[i-1].x,after=points[i+1].x-p.x;
  const w1=2*after+before,w2=after+2*before;
  return (w1+w2)/(w1/slopes[i-1]+w2/slopes[i]);
 });
}
