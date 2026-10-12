import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { SqlDatabase } from '../src/contracts/db.js';
import { createSQLite } from '../src/db/sqlite.js';
import { D1SqlDatabase } from '../src/db/d1.js';
import { migrateAuth } from '../src/auth/migrations.js';
import { consumeAuthLimit, privateLimitKey } from '../src/auth/limits.js';

const start = 1_800_000_000_000;
const minute = 60_000;
type Bucket = { count: number; last_request: number };

for (const driver of ['sqlite', 'd1'] as const) {
  describe(`fixed auth windows on real ${driver}`, () => {
    let db: SqlDatabase;
    let second: SqlDatabase;
    let directory: string;
    let mf: Miniflare;
    before(async () => {
      if (driver === 'sqlite') {
        directory = await mkdtemp(join(tmpdir(), 'open-alert-limits-'));
        const path = join(directory, 'limits.sqlite');
        db = await createSQLite(path);
        second = await createSQLite(path);
      } else {
        mf = new Miniflare({ workers: [{ config: { name: 'limits-test', compatibilityDate: '2026-10-11', manifest: { mainModule: 'index.js', modulesRoot: '/', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch(){return new Response("fixture")} }' } } }, env: { DB: { type: 'd1', id: 'open-alert-limits-local-test' } } } }] });
        db = new D1SqlDatabase(await mf.getD1Database('DB') as unknown as D1Database);
        second = new D1SqlDatabase(await mf.getD1Database('DB') as unknown as D1Database);
      }
      // Real generated auth schema; D1 migrations execute through the actual batch adapter.
      await migrateAuth(db, 'tables', start);
    });
    after(async () => {
      await second?.close();
      await db?.close();
      if (mf) await mf.dispose();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    const read = async (key: string) => (await db.query<Bucket>('SELECT count,last_request FROM rate_limit WHERE "key"=?', [key]))[0]!;
    const keyFor = (prefix: string) => privateLimitKey(prefix, 'fixture-user', 'fixture-limit-secret');

    test('three calls every five seconds for ten minutes never falsely throttle', async () => {
      const key = await keyFor('api-user');
      let calls = 0;
      for (let elapsed = 0; elapsed < 10 * minute; elapsed += 5_000) {
        for (let call = 0; call < 3; call++) {
          assert.deepEqual(await consumeAuthLimit(db, key, 120, minute, start + elapsed), { allowed: true, retryAfter: 0 });
          calls++;
        }
        assert.equal((await read(key)).last_request, start + Math.floor(elapsed / minute) * minute);
      }
      assert.equal(calls, 360);
      assert.deepEqual(await read(key), { count: 36, last_request: start + 9 * minute });
    });

    test('allows 120, denies 121, rejection never extends and exact expiry resets', async () => {
      const key = await keyFor('api-boundary');
      for (let i = 0; i < 120; i++) {
        assert.equal((await consumeAuthLimit(db, key, 120, minute, start + i * 100)).allowed, true);
      }
      assert.deepEqual(await read(key), { count: 120, last_request: start });
      assert.deepEqual(await consumeAuthLimit(db, key, 120, minute, start + 12_000), { allowed: false, retryAfter: 48 });
      assert.deepEqual(await consumeAuthLimit(db, key, 120, minute, start + minute - 1), { allowed: false, retryAfter: 1 });
      assert.deepEqual(await read(key), { count: 120, last_request: start });
      assert.deepEqual(await consumeAuthLimit(second, key, 120, minute, start + minute), { allowed: true, retryAfter: 0 });
      assert.deepEqual(await read(key), { count: 1, last_request: start + minute });
    });

    test('independent instances cannot exceed max during concurrent insert, increment or expiry', async () => {
      const key = await keyFor('concurrent');
      const wave = async (now: number) => {
        const claims = await Promise.all(Array.from({ length: 160 }, (_, i) => consumeAuthLimit(i % 2 ? second : db, key, 120, minute, now)));
        assert.equal(claims.filter(result => result.allowed).length, 120);
        assert.equal(claims.filter(result => !result.allowed).length, 40);
        assert.deepEqual(await read(key), { count: 120, last_request: now });
      };
      await wave(start);
      const denied = await Promise.all([db, second].map(instance => consumeAuthLimit(instance, key, 120, minute, start + minute - 1)));
      assert.ok(denied.every(result => !result.allowed && result.retryAfter === 1));
      await wave(start + minute);
    });

    test('email cooldown and hourly budgets retain their original maxima and window starts', async () => {
      const cooldown = await keyFor('email-cooldown');
      const hour = await keyFor('email-hour');
      for (let i = 0; i < 10; i++) {
        const now = start + i * minute;
        assert.equal((await consumeAuthLimit(db, cooldown, 1, minute, now)).allowed, true);
        assert.deepEqual(await consumeAuthLimit(second, cooldown, 1, minute, now + minute - 1), { allowed: false, retryAfter: 1 });
        assert.equal((await consumeAuthLimit(db, hour, 10, 60 * minute, now)).allowed, true);
      }
      assert.deepEqual(await read(hour), { count: 10, last_request: start });
      assert.deepEqual(await consumeAuthLimit(db, hour, 10, 60 * minute, start + 10 * minute), { allowed: false, retryAfter: 3_000 });
      assert.deepEqual(await consumeAuthLimit(second, hour, 10, 60 * minute, start + 60 * minute - 1), { allowed: false, retryAfter: 1 });
      assert.deepEqual(await consumeAuthLimit(db, hour, 10, 60 * minute, start + 60 * minute), { allowed: true, retryAfter: 0 });
      assert.deepEqual(await read(hour), { count: 1, last_request: start + 60 * minute });
      const attempts = await keyFor('email-attempts');
      for (let i = 0; i < 10; i++) assert.equal((await consumeAuthLimit(db, attempts, 10, minute, start + i * 1_000)).allowed, true);
      assert.equal((await consumeAuthLimit(db, attempts, 10, minute, start + minute - 1)).allowed, false);
      assert.equal((await consumeAuthLimit(db, attempts, 10, minute, start + minute)).allowed, true);
    });

    test('legacy last-request buckets recover without versioning or resetting other buckets', async () => {
      const key = await keyFor('api-legacy');
      const lastSuccess = start + 55_000;
      await db.execute('INSERT INTO rate_limit(id,"key",count,last_request) VALUES(?,?,?,?)', ['legacy', key, 119, lastSuccess]);
      assert.equal((await consumeAuthLimit(db, key, 120, minute, lastSuccess + 5_000)).allowed, true);
      assert.deepEqual(await read(key), { count: 120, last_request: lastSuccess });
      assert.equal((await consumeAuthLimit(second, key, 120, minute, lastSuccess + minute - 1)).allowed, false);
      assert.equal((await consumeAuthLimit(db, key, 120, minute, lastSuccess + minute)).allowed, true);
      assert.deepEqual(await read(key), { count: 1, last_request: lastSuccess + minute });
    });

    test('one SQL statement claims each request; app keys leave native IP/path rows distinct', async () => {
      const native = '192.0.2.1/email-otp/send-verification-otp';
      await db.execute('INSERT INTO rate_limit(id,"key",count,last_request) VALUES(?,?,?,?)', ['native', native, 5, start]);
      const key = await keyFor('statement');
      assert.ok(key.startsWith('app-auth:statement:'));
      let statements = 0;
      const instrumented: SqlDatabase = {
        driver: db.driver,
        async query<T extends object>(sql: string, params?: Parameters<SqlDatabase['query']>[1]): Promise<T[]> {
          statements++;
          return db.query<T>(sql, params);
        },
        async execute() { assert.fail('claim must use UPSERT RETURNING'); },
        async atomic() { assert.fail('claim must be one statement'); },
        async atomicCAS() { assert.fail('claim must be one statement'); },
        async close() {},
      };
      assert.equal((await consumeAuthLimit(instrumented, key, 2, minute, start)).allowed, true);
      assert.equal(statements, 1);
      assert.equal((await consumeAuthLimit(instrumented, key, 2, minute, start + 10_000)).allowed, true);
      assert.equal(statements, 2);
      assert.deepEqual(await consumeAuthLimit(instrumented, key, 2, minute, start + 20_000), { allowed: false, retryAfter: 40 });
      assert.equal(statements, 4); // Rejection only reads the unchanged start to calculate Retry-After.
      assert.deepEqual(await read(native), { count: 5, last_request: start });
    });
  });
}
