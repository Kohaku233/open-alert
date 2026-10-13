#!/usr/bin/env node
/** Offline-only verification: never deploy, load keys, or contact an exchange. */
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,cp} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {prepareTestExecution} from './test-staging.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Always stage only the allowlisted execution inputs: never copy .env or .dev.vars.
const execution=await prepareTestExecution(root,{local:true});
const evidence=resolve(root,'test-output','ccxt-runtime');await mkdir(evidence,{recursive:true});
// This preload denies Node egress, including Undici and proxy use. Local workerd
// control sockets are allowed; workerd exchange egress is exclusively handled by
// the tests' Miniflare outboundService mocks, which reject every unknown route.
const guard=join(execution.root,'scripts','.ccxt-offline-guard.mjs');
await writeFile(guard,`import net from 'node:net';import dns from 'node:dns';
const denied=()=>{throw new Error('CCXT_VERIFY_EXTERNAL_NETWORK_DENIED');};
globalThis.fetch=async()=>denied();
const local=host=>['localhost','127.0.0.1','::1','[::1]'].includes(host);
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const first=args[0];const host=typeof first==='object'?first.host:typeof args[1]==='string'?args[1]:'localhost';if(host&&!local(host))return denied();return connect.apply(this,args);};
const lookup=dns.lookup;dns.lookup=function(host,...args){if(!local(host))return denied();return lookup.call(this,host,...args);};
`);
const env={...process.env,WRANGLER_SEND_METRICS:'false',CI:'true',NODE_OPTIONS:`--import=${guard}`};
for(const key of Object.keys(env))if(/proxy|cloudflare|cf_api|resend|pushover|smtp|auth_secret|encryption_key|bootstrap_token/i.test(key)&&key!=='WRANGLER_SEND_METRICS')delete env[key];
const results=[];
async function run(name,args,budget=55000){
 const at=Date.now();let output='',timedOut=false;
 const child=spawn(process.execPath,args,{cwd:execution.root,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 const terminate=signal=>{try{if(process.platform==='win32')child.kill(signal);else process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
 child.stdout.on('data',chunk=>{output+=chunk;process.stdout.write(chunk);});child.stderr.on('data',chunk=>{output+=chunk;process.stderr.write(chunk);});
 let escalation;const timer=setTimeout(()=>{timedOut=true;terminate('SIGTERM');escalation=setTimeout(()=>terminate('SIGKILL'),2000);},budget);
 const close=await new Promise((resolveClose,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolveClose({code,signal}));});clearTimeout(timer);clearTimeout(escalation);
 await writeFile(join(evidence,name+'.log'),output);
 const result={name,...close,timedOut,elapsedMs:Date.now()-at};results.push(result);
 if(close.code!==0||close.signal||timedOut)throw new Error(`${name} failed`);
}
let ok=false;
try {
 await run('bundle-default',['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--outdir','dist/worker-default']);
 await run('bundle-minified',['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--minify','--outdir','dist/worker']);
 const measurements={};
 for(const [name,path] of [['default','dist/worker-default/cloudflare.js'],['minified','dist/worker/cloudflare.js']]){
  const bytes=await readFile(join(execution.root,path));measurements[name]={uncompressedBytes:bytes.length,gzipBytes:gzipSync(bytes).length,withinRequested3MiBGzipGate:gzipSync(bytes).length<=3*1024*1024};
 }
 await writeFile(join(evidence,'bundle-sizes.json'),JSON.stringify(measurements,null,2)+'\n');
 if(!measurements.minified.withinRequested3MiBGzipGate)throw new Error('minified_bundle_exceeds_requested_3MiB_gate');
 await run('startup',['node_modules/wrangler/bin/wrangler.js','check','startup','--args=--minify','--outfile',join(evidence,'startup.cpuprofile')]);
 for(const file of ['runtime-cloudflare-ccxt.test.ts','runtime-cloudflare.test.ts'])await run(file.replace('.test.ts',''),['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1','test/'+file]);
 if(execution.staged){await mkdir(resolve(root,'dist/worker'),{recursive:true});await cp(join(execution.root,'dist/worker/cloudflare.js'),resolve(root,'dist/worker/cloudflare.js'));}
 ok=true;
} catch(error){console.error(error.message);process.exitCode=1;}
finally {
 await writeFile(join(evidence,'result.json'),JSON.stringify({ok,results,scope:'offline mocks only; local profile is not hosted CPU/memory/startup quota evidence'},null,2)+'\n');
 // Avoid persisting the generated preload in a normal local installation.
 const {rm}=await import('node:fs/promises');await rm(guard,{force:true});await execution.cleanup();
}
console.log(`CCXT runtime offline verification: ${ok?'PASS':'FAIL'}; evidence ${evidence}`);
