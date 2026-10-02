// Models audio-clock scheduling and one media source per native element.
// It verifies transport/routing contracts, not browser rendering or audibility.
export function audioContextFixture(){
  const instances=[];
  class Param {
    constructor(){this.value=1;this.events=[];}
    cancelScheduledValues(time){this.events.push({kind:'cancel',time});}
    setValueAtTime(value,time){this.value=value;this.events.push({kind:'set',value,time});}
    setTargetAtTime(value,time,constant){this.value=value;this.events.push({kind:'target',value,time,constant});}
    linearRampToValueAtTime(value,time){this.value=value;this.events.push({kind:'ramp',value,time});}
    setValueCurveAtTime(values,time,duration){this.events.push({kind:'curve',values:[...values],time,duration});}
  }
  class AudioContext {
    constructor(){this.state='running';this.currentTime=10;this.destination={};this.gains=[];this.sources=new Map();this.listeners=[];instances.push(this);}
    createGain(){const node={gain:new Param(),connect(destination){this.destination=destination;},disconnect(){}};this.gains.push(node);return node;}
    createMediaElementSource(element){if(this.sources.has(element))throw new Error('Already routed');const node={connect(destination){this.destination=destination;}};this.sources.set(element,node);return node;}
    addEventListener(name,callback){if(name==='statechange')this.listeners.push(callback);}
    resume(){this.state='running';return Promise.resolve();}
    close(){this.state='closed';this.listeners.forEach(fn=>fn());return Promise.resolve();}
    suspend(){this.state='suspended';this.listeners.forEach(fn=>fn());}
  }
  return {AudioContext,instances};
}
