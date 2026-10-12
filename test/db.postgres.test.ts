import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { PostgresDatabase } from '../src/db/postgres.js';
const fixture=()=>{
 const calls:{text:string;values?:unknown[]}[]=[]; let releases=0; const client={async query(input:string|{text:string;values?:unknown[];types?:{getTypeParser(oid:number): (s:string)=>unknown}}) { const call=typeof input==='string'?{text:input}:input;calls.push(call); if(call.text==='FAIL') throw new Error('failed');return {rowCount:call.text==='ZERO'?0:1,rows:call.text.startsWith('SELECT')?[{value:call.types?.getTypeParser(20)('42')}]:[]}; },release(){releases++;}};
 const pool={query:client.query.bind(client),async connect(){return client;},async end(){}}; return {db:new PostgresDatabase(pool as unknown as Pool),calls,releases:()=>releases};
};
test('PG canonical binding and safe bigint parsing',async()=>{ const s=fixture(); assert.deepEqual(await s.db.query('SELECT ?',[null]),[{value:42}]); assert.equal(s.calls[0]!.text,'SELECT $1');assert.deepEqual(s.calls[0]!.values,[null]); });
test('PG checks out one client, ordered zero change counts and commits',async()=>{const s=fixture(); assert.deepEqual(await s.db.atomic([{sql:'ONE',params:['bound']},{sql:'ZERO'}]),[1,0]);assert.deepEqual(s.calls.map(c=>c.text),['BEGIN','ONE','ZERO','COMMIT']); assert.equal(s.releases(),1); });
test('PG statement failure and CAS miss both roll back and release',async()=>{const s=fixture();await assert.rejects(s.db.atomic([{sql:'ONE'},{sql:'FAIL'}])); assert.deepEqual(s.calls.map(c=>c.text),['BEGIN','ONE','FAIL','ROLLBACK']); const t=fixture(); assert.equal(await t.db.atomicCAS([{sql:'ONE',expectedChanges:1},{sql:'ZERO',expectedChanges:1}]),false);assert.deepEqual(t.calls.map(c=>c.text),['BEGIN','ONE','ZERO','ROLLBACK']);assert.equal(t.releases(),1);});
