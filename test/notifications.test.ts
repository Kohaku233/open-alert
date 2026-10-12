import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { encryptSecret, decryptSecret, createNotifications, sendPushover, validatePushoverChannel, getPushoverSounds } from '../src/notifications/index.js';
import { boundedJson } from '../src/notifications/http.js';
import type { Fetch } from '../src/notifications/http.js';
import { DEFAULT_NOTIFICATION } from '../src/contracts/domain.js';
const key='ab'.repeat(32),user='u1',creds={userKey:'U'.repeat(30),appToken:'T'.repeat(30)};
const config=loadConfig({NODE_ENV:'test',APP_URL:'http://localhost:3000',AUTH_SECRET:'a'.repeat(32),ENCRYPTION_KEY:key,EMAIL_PROVIDER:'console',SQLITE_PATH:':memory:',PUSHOVER_APP_TOKEN:creds.appToken});
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
test('AES-GCM randomized envelopes authenticate user/field/key and canonical key bytes',async()=>{
 const one=await encryptSecret(key,user,'userKey',creds.userKey),two=await encryptSecret(key,user,'userKey',creds.userKey);
 assert.notEqual(one.iv,two.iv);assert.notEqual(one.ciphertext,two.ciphertext);
 assert.equal(await decryptSecret(key,user,'userKey',one),creds.userKey);
 assert.equal(await decryptSecret(Buffer.from(key,'hex').toString('base64'),user,'userKey',one),creds.userKey);
 await assert.rejects(decryptSecret(key,'u2','userKey',one),/secret_authentication_failed/);
 await assert.rejects(decryptSecret(key,user,'appToken',one),/secret_authentication_failed/);
 await assert.rejects(decryptSecret('cd'.repeat(32),user,'userKey',one),/secret_authentication_failed/);
 await assert.rejects(encryptSecret('bad-key',user,'userKey',creds.userKey),/invalid_encryption_key/);
 await assert.rejects(decryptSecret(key,user,'userKey',{...one,iv:'bad'}),/invalid_envelope/);
 assert.equal(JSON.stringify(one).includes(creds.userKey),false);
});
test('fixed validation does not send; tests priority zero and private token overrides shared',async()=>{
 const calls:{url:string;body:URLSearchParams}[]=[];
 const fetch:Fetch=async(input,init)=>{assert.equal(init?.redirect,'manual');assert.ok(init?.signal);calls.push({url:String(input),body:new URLSearchParams(String(init?.body))});return response({status:1,request:'id'});};
 const service=createNotifications(config,{fetch});
 const channel={userId:user,generation:0,updatedAt:1,userKey:await encryptSecret(key,user,'userKey',creds.userKey),privateAppToken:null};
 await service.validate(user,channel);assert.equal(calls[0]!.url,'https://api.pushover.net/1/users/validate.json');assert.equal(calls[0]!.body.has('message'),false);
 assert.equal((await service.test(user,channel)).outcome,'sent');assert.equal(calls[1]!.body.get('priority'),'0');assert.equal(calls[1]!.body.has('retry'),false);
 const privateToken='P'.repeat(30);await service.test(user,{...channel,privateAppToken:await encryptSecret(key,user,'appToken',privateToken)});
 assert.equal(calls[2]!.body.get('token'),privateToken);assert.equal((await service.test('u2',channel)).outcome,'failed');assert.equal(calls.length,3);
});
test('provider validates status/receipt, rejects 32-char credentials and never leaks errors',async()=>{
 await assert.rejects(validatePushoverChannel({...creds,userKey:'U'.repeat(32)}),/invalid_channel/);
 assert.equal((await sendPushover(creds,'message','title',DEFAULT_NOTIFICATION,{fetch:async()=>response({status:1,request:'id',receipt:'R'.repeat(30)})})).outcome,'sent');
 for(const [body,status,expected] of [[{status:0,errors:[creds.appToken]},400,'failed'],[{status:1,request:'id'},200,'uncertain'],[{status:0},500,'uncertain'],[{status:1,request:'id',receipt:'malformed'},200,'uncertain']] as const){const result=await sendPushover(creds,'message','title',DEFAULT_NOTIFICATION,{fetch:async()=>response(body,status)});assert.equal(result.outcome,expected);assert.equal(JSON.stringify(result).includes(creds.appToken),false);}
 const result=await sendPushover(creds,'message','title',DEFAULT_NOTIFICATION,{fetch:async()=>{throw new Error(creds.appToken);}});assert.equal(result.outcome,'uncertain');assert.equal(JSON.stringify(result).includes(creds.appToken),false);
});
test('bounded transport handles abort-ignoring fetch and body, byte overflow and redirects',async()=>{
 const started=performance.now();await assert.rejects(boundedJson('https://example.com',{}, {timeoutMs:20,maxBytes:128,fetch:()=>new Promise(()=>{})}),/request_timeout/);assert.ok(performance.now()-started<1000);
 await assert.rejects(boundedJson('https://example.com',{}, {timeoutMs:20,maxBytes:128,fetch:async()=>new Response(new ReadableStream({start(){}}))}),/request_timeout/);
 await assert.rejects(boundedJson('https://example.com',{}, {timeoutMs:100,maxBytes:8,fetch:async()=>response({too:'large'})}),/response_too_large/);
 await assert.rejects(boundedJson('https://example.com',{}, {timeoutMs:100,maxBytes:128,fetch:async()=>new Response(null,{status:302,headers:{location:'https://attacker.invalid'}})}),/redirect_rejected/);
});
test('sounds uses official GET and a bounded frozen dictionary',async()=>{
 const sounds=await getPushoverSounds(creds.appToken,{fetch:async(url,init)=>{assert.equal(init?.method,'GET');assert.ok(String(url).startsWith('https://api.pushover.net/1/sounds.json?token='));return response({status:1,sounds:{siren:'Siren'}});}});assert.equal(sounds.siren,'Siren');assert.ok(Object.isFrozen(sounds));
});
