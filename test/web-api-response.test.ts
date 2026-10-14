import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, errorText, request } from '../web/api.js';

test('response parsing distinguishes missing metadata, proxy failures, expired sessions and uncertain writes', async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'https://example.test/', origin: 'https://example.test' } } });
  let response: Response;
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return response;});
  const failure=async(path='/api/auth-capabilities',method='GET')=> {
    try {await request(path,method);assert.fail('Expected response failure');}
    catch(error) {assert(error instanceof AppError);return error;}
  };
  try {
    response=Response.json({ok:true,data:{google:true}});
    assert.deepEqual(await request('/api/auth-capabilities'),{google:true});
    response=Response.json({ok:true,data:{google:false},requestId:null});
    assert.deepEqual(await request('/api/auth-capabilities'),{google:false});
    response=Response.json({ok:false,error:{code:'generation_conflict',message:'Changed'}},{status:409,headers:{'X-Request-ID':'trace-123'}});
    const conflict=await failure();assert.equal(conflict.code,'generation_conflict');assert.equal(conflict.requestId,'trace-123');
    response=Response.json({message:'Sign in required'},{status:401});
    assert.equal((await failure()).code,'unauthenticated');
    response=new Response('<html>Bad gateway</html>',{status:502,headers:{'CF-Ray':'abc-HKG'}});
    const proxy=await failure();assert.equal(proxy.code,'service_unavailable');assert.match(errorText(proxy),/HTTP 502/);assert.equal(proxy.requestId,'abc-HKG');
    response=Response.json({upstream:'unavailable'},{status:503});
    assert.equal((await failure()).code,'service_unavailable');
    response=new Response('<html>Verify</html>',{status:403,headers:{'cf-mitigated':'challenge'}});
    assert.equal((await failure()).code,'upstream_challenge');
    for(const invalid of [null,[],{ok:true},{ok:false,error:null},{ok:false,error:{code:7,message:'invalid'}}]) {
      response=Response.json(invalid);assert.equal((await failure()).code,'invalid_response');
    }
    response=new Response('<html>Gateway timeout</html>',{status:504});
    const before=calls;const write=await failure('/api/alerts','POST');
    assert.equal(write.code,'request_uncertain');assert.equal(calls,before+1,'Never automatically replay a mutation');
    response=Response.json({ok:true},{status:200});
    assert.equal((await failure('/api/alerts','POST')).code,'request_uncertain');
    response=new Response('Too many requests',{status:429,headers:{'Retry-After':'2'}});
    assert.equal((await failure()).code,'rate_limited');
  } finally {
    if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');
  }
});
