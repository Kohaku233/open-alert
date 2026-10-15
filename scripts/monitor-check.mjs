#!/usr/bin/env node
// One-shot external readiness probe. Scheduling and notification delivery are opt-in operator tasks.
const args=process.argv.slice(2),url=args[0]??'https://cryptotool.bar';
try {
  const origin=new URL(url);
  if(!['https:','http:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Use an origin URL without credentials or a path');
  const at=Date.now(),response=await fetch(new URL('/api/readiness',origin),{redirect:'error',signal:AbortSignal.timeout(10000)});
  const length=Number(response.headers.get('content-length')??0);if(length>16384)throw Error('Oversized readiness response');
  const reader=response.body?.getReader(),chunks=[];let size=0;
  if(!reader)throw Error('Missing readiness body');
  try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>16384)throw Error('Oversized readiness response');chunks.push(item.value);}}finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const body=JSON.parse(new TextDecoder().decode(bytes));const ready=response.status===200&&body?.ok===true&&body?.data?.state==='ready';
  console.log(JSON.stringify({event:'open_alert_external_probe',at,status:response.status,ready,durationMs:Date.now()-at}));
  if(!ready)process.exitCode=1;
} catch {console.log(JSON.stringify({event:'open_alert_external_probe',at:Date.now(),ready:false,error:'probe_unavailable'}));process.exitCode=1;}
