import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { encryptSecret } from '../src/notifications/crypto.js';
import type { ChannelAdapter } from '../src/notifications/hub.js';
import { createNotifyHub, ensureHubSchema, inQuietHours, pushoverAdapter, HubError } from '../src/notifications/hub.js';
import { createSQLite } from '../src/db/sqlite.js';
import type { ChannelRecord } from '../src/contracts/db.js';
import { z } from 'zod';

const key = 'ab'.repeat(32), shared = 'T'.repeat(30);
const config = loadConfig({ NODE_ENV: 'test', APP_URL: 'http://localhost:3000', AUTH_SECRET: 'a'.repeat(32), ENCRYPTION_KEY: key, EMAIL_PROVIDER: 'console', SQLITE_PATH: ':memory:', PUSHOVER_APP_TOKEN: shared });
const fallback = { priority: 1, retry: 60, expire: 600, sound: 'siren' };

/** Fake provider that records what it was asked to send. */
function fakeAdapter(sent: { to: string; title: string; priority: number }[], outcome: 'sent' | 'failed' = 'sent'): ChannelAdapter<{ to: string }> {
  return { type: 'fake', configSchema: z.strictObject({ to: z.string().min(1) }) as z.ZodType<{ to: string }>, async validate(c) { if (c.to === 'bad') throw new Error('rejected'); },
    async send(c, m, o) { sent.push({ to: c.to, title: m.title, priority: o.priority }); return { outcome, code: outcome === 'sent' ? null : 'provider_rejected' }; }, summary(c) { return { to: c.to }; } };
}
async function setup(legacyUsers: string[] = []) {
  const db = await createSQLite(':memory:', true);
  await db.execute('CREATE TABLE "user" (id TEXT PRIMARY KEY)');
  await db.execute('CREATE TABLE channels (user_id TEXT PRIMARY KEY)');
  for (const id of ['u1', 'u2']) await db.execute('INSERT INTO "user"(id) VALUES(?)', [id]);
  const legacy = new Map<string, ChannelRecord>();
  for (const id of legacyUsers) {
    await db.execute('INSERT INTO channels(user_id) VALUES(?)', [id]);
    legacy.set(id, { userId: id, generation: 0, updatedAt: 1, userKey: await encryptSecret(key, id, 'userKey', 'U'.repeat(30)), privateAppToken: null });
  }
  await ensureHubSchema(db); await ensureHubSchema(db);
  const repositories = { channels: { get: async (id: string) => legacy.get(id) ?? null }, settings: {} } as never;
  return { db, repositories };
}

test('legacy Pushover users migrate once: linked channel routed to both anomaly sources, price alerts listed read-only', async () => {
  const { db, repositories } = await setup(['u1']);
  try {
    let t = 1000;
    const hub = createNotifyHub({ db, config, repositories, now: () => t });
    assert.equal(await hub.migrateLegacy(), 1);
    assert.equal(await hub.migrateLegacy(), 0);
    const [channel] = await hub.channels('u1');
    assert.equal(channel!.legacy, true); assert.equal(channel!.configured, true); assert.equal(channel!.summary.tokenSource, 'shared');
    assert.equal(JSON.stringify(channel).includes('U'.repeat(30)), false, 'credentials never leave the hub');
    const routes = await hub.routes('u1');
    assert.deepEqual(routes.map(r => r.source), ['price_alert', 'anomaly_crypto', 'anomaly_tradfi']);
    assert.equal(await hub.anomalyReachable('u1'), true);
    // A user without Pushover gets the linked row too, but it is unconfigured, so nothing is reachable.
    assert.equal(await hub.anomalyReachable('u2'), false);
    await assert.rejects(hub.removeChannel('u1', channel!.id), (e: unknown) => e instanceof HubError && e.code === 'invalid_request');
    t += 1;
  } finally { await db.close(); }
});

test('dispatch fans out per source, de-duplicates channels, applies route profiles and quiet hours', async () => {
  const { db, repositories } = await setup();
  try {
    const sent: { to: string; title: string; priority: number }[] = [];
    let t = Date.UTC(2026, 9, 29, 12, 0);
    const hub = createNotifyHub({ db, config, repositories, now: () => t, adapters: { pushover: pushoverAdapter, fake: fakeAdapter(sent) } });
    const a = await hub.createChannel('u1', { type: 'fake', name: 'A', config: { to: 'a' } });
    const b = await hub.createChannel('u1', { type: 'fake', name: 'B', config: { to: 'b' } });
    await assert.rejects(hub.createChannel('u1', { type: 'fake', name: 'X', config: { to: 'bad' } }), (e: unknown) => e instanceof HubError && e.code === 'notification_failed');
    await assert.rejects(hub.createChannel('u1', { type: 'fake', name: 'X', config: { nope: 1 } }), (e: unknown) => e instanceof HubError && e.code === 'invalid_request');
    const legacy = (await hub.channels('u1')).find(c => c.legacy)!;
    await hub.setRoutes('u1', [
      { source: 'anomaly_crypto', channelId: a.id, enabled: true, options: { notification: { ...fallback, priority: 2 }, quiet: null } },
      { source: 'anomaly_tradfi', channelId: a.id, enabled: true, options: { notification: null, quiet: null } },
      // Quiet 11:00-13:00 UTC: skipped at 12:00.
      { source: 'anomaly_tradfi', channelId: b.id, enabled: true, options: { notification: null, quiet: { from: '11:00', to: '13:00', offsetMinutes: 0 } } },
      { source: 'anomaly_crypto', channelId: legacy.id, enabled: false, options: { notification: null, quiet: null } },
    ]);
    const r1 = await hub.dispatch('u1', ['anomaly_crypto', 'anomaly_tradfi'], { title: 'T', body: 'B', severity: 'warning' }, fallback);
    assert.equal(r1.outcome, 'sent'); assert.equal(r1.channels, 1);
    assert.deepEqual(sent, [{ to: 'a', title: 'T', priority: 2 }], 'A once, with the first source profile; B quiet; legacy disabled');
    t = Date.UTC(2026, 9, 29, 14, 0); sent.length = 0;
    await hub.dispatch('u1', ['anomaly_tradfi'], { title: 'T2', body: 'B', severity: 'warning' }, fallback);
    assert.deepEqual(sent.map(s => [s.to, s.priority]).sort(), [['a', 1], ['b', 1]], 'null profile follows the fallback');
    // Disabled channel receives nothing.
    await hub.patchChannel('u1', b.id, b.generation, { enabled: false }); sent.length = 0;
    await hub.dispatch('u1', ['anomaly_tradfi'], { title: 'T3', body: 'B', severity: 'warning' }, fallback);
    assert.deepEqual(sent.map(s => s.to), ['a']);
    await assert.rejects(hub.patchChannel('u1', b.id, b.generation, { name: 'stale' }), (e: unknown) => e instanceof HubError && e.code === 'generation_conflict');
    // Removing a channel drops its routes; foreign channel ids are refused.
    await hub.removeChannel('u1', a.id);
    assert.equal((await hub.routes('u1')).some(r => r.channelId === a.id), false);
    await assert.rejects(hub.setRoutes('u2', [{ source: 'anomaly_crypto', channelId: b.id, enabled: true, options: { notification: null, quiet: null } }]), (e: unknown) => e instanceof HubError && e.code === 'not_found');
    const none = await hub.dispatch('u2', ['anomaly_crypto'], { title: 'T', body: 'B', severity: 'info' }, fallback);
    assert.equal(none.outcome, 'skipped');
  } finally { await db.close(); }
});

test('channel test is rate limited per channel and records the outcome', async () => {
  const { db, repositories } = await setup();
  try {
    const sent: { to: string; title: string; priority: number }[] = [];
    let t = 1_000_000;
    const hub = createNotifyHub({ db, config, repositories, now: () => t, adapters: { fake: fakeAdapter(sent) } });
    const a = await hub.createChannel('u1', { type: 'fake', name: 'A', config: { to: 'a' } });
    assert.equal((await hub.test('u1', a.id)).outcome, 'sent');
    assert.equal(sent[0]!.priority, 0);
    await assert.rejects(hub.test('u1', a.id), (e: unknown) => e instanceof HubError && e.code === 'rate_limited');
    t += 30_001;
    assert.equal((await hub.test('u1', a.id)).outcome, 'sent');
    const after = (await hub.channels('u1')).find(c => c.id === a.id)!;
    assert.equal(after.lastOutcome, 'sent');
    await assert.rejects(hub.test('u2', a.id), (e: unknown) => e instanceof HubError && e.code === 'not_found');
  } finally { await db.close(); }
});

test('quiet hours wrap midnight and honour the user offset', () => {
  const q = { from: '23:00', to: '07:00', offsetMinutes: 480 }; // Beijing
  assert.equal(inQuietHours(q, Date.UTC(2026, 9, 29, 16, 30)), true); // 00:30 local
  assert.equal(inQuietHours(q, Date.UTC(2026, 9, 29, 0, 0)), false); // 08:00 local
  assert.equal(inQuietHours(q, Date.UTC(2026, 9, 29, 15, 0)), true); // 23:00 local
  assert.equal(inQuietHours(null, 0), false);
});
