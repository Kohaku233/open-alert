import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
test('external readiness probe distinguishes ready, not-ready, malformed and oversized responses',async()=>{
 let kind='ready';
 const server=createServer((_req,res)=>{if(kind==='oversized'){res.end('x'.repeat(20000));return;}if(kind==='malformed'){res.end('<html>private error</html>');return;}res.writeHead(kind==='ready'?200:503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,data:{state:kind}}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 try{for(const value of ['ready','not_ready','malformed','oversized']){kind=value;const result=await new Promise<{ok:boolean;out:string}>(r=>execFile(process.execPath,[resolve('scripts/monitor-check.mjs'),`http://127.0.0.1:${port}`],{timeout:12000},(error,out)=>r({ok:!error,out})));assert.equal(result.ok,value==='ready');const report=JSON.parse(result.out);assert.equal(report.ready,value==='ready');assert.ok(!result.out.includes('private error'));}}
 finally{await new Promise<void>(r=>server.close(()=>r()));}
});
