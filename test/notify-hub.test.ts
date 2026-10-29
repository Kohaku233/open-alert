import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { encryptSecret } from '../src/notifications/crypto.js';
import type { ChannelAdapter, RouteOptions } from '../src/notifications/hub.js';
import {
  createNotifyHub,
  DEFAULT_ROUTE_OPTIONS,
  ensureHubSchema,
  HubError,
  inQuietHours,
  pushoverAdapter,
  routeOptionsSchema,
} from '../src/notifications/hub.js';
import { createSQLite } from '../src/db/sqlite.js';
import type { ChannelRecord } from '../src/contracts/db.js';

const key = 'ab'.repeat(32);
const shared = 'T'.repeat(30);
const config = loadConfig({
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  AUTH_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEY: key,
  EMAIL_PROVIDER: 'console',
  SQLITE_PATH: ':memory:',
  PUSHOVER_APP_TOKEN: shared,
});
const fallback = { priority: 1, retry: 60, expire: 600, sound: 'siren' };
const route = (patch: Partial<RouteOptions> = {}): RouteOptions => ({ ...DEFAULT_ROUTE_OPTIONS, ...patch });
type Sent = { to: string; title: string; body: string; priority: number; url?: string };

/** Fake provider that records what it was asked to send. */
function fakeAdapter(sent: Sent[], outcome: 'sent' | 'failed' | 'uncertain' = 'sent'): ChannelAdapter<{ to: string }> {
  return {
    type: 'fake',
    configSchema: z.strictObject({ to: z.string().min(1) }) as z.ZodType<{ to: string }>,
    async validate(c) {
      if (c.to === 'bad') throw new Error('rejected');
    },
    async send(c, message, options) {
      sent.push({
        to: c.to,
        title: message.title,
        body: message.body,
        priority: options.priority,
        ...(message.url ? { url: message.url } : {}),
      });
      return { outcome, code: outcome === 'sent' ? null : `provider_${outcome}` };
    },
    summary(c) {
      return { to: c.to };
    },
  };
}

async function setup(legacyUsers: string[] = []) {
  const db = await createSQLite(':memory:', true);
  await db.execute('CREATE TABLE "user" (id TEXT PRIMARY KEY)');
  await db.execute('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await db.execute('CREATE TABLE channels (user_id TEXT PRIMARY KEY)');
  for (const id of ['u1', 'u2']) await db.execute('INSERT INTO "user"(id) VALUES(?)', [id]);
  const legacy = new Map<string, ChannelRecord>();
  for (const id of legacyUsers) {
    await db.execute('INSERT INTO channels(user_id) VALUES(?)', [id]);
    legacy.set(id, {
      userId: id,
      generation: 0,
      updatedAt: 1,
      userKey: await encryptSecret(key, id, 'userKey', 'U'.repeat(30)),
      privateAppToken: null,
    });
  }
  await ensureHubSchema(db);
  await ensureHubSchema(db);
  const repositories = { channels: { get: async (id: string) => legacy.get(id) ?? null }, settings: {} } as never;
  return { db, repositories };
}

test('route options default dailyLimit to 10 and reject values outside the route cap', () => {
  assert.deepEqual(routeOptionsSchema.parse({ notification: null, quiet: null }), DEFAULT_ROUTE_OPTIONS);
  assert.equal(routeOptionsSchema.safeParse({ notification: null, quiet: null, dailyLimit: 0 }).success, false);
  assert.equal(routeOptionsSchema.safeParse({ notification: null, quiet: null, dailyLimit: 51 }).success, false);
  assert.equal(routeOptionsSchema.safeParse({ notification: null, quiet: null, dailyLimit: 5.5 }).success, false);
});

test('legacy Pushover migration is idempotent and exposes a normal editable/deletable channel routed to all sources', async () => {
  const { db, repositories } = await setup(['u1']);
  try {
    const hub = createNotifyHub({ db, config, repositories, now: () => 1000 });
    assert.equal(await hub.migrateLegacy(), 1);
    await hub.migrateLegacy();

    const channels = await hub.channels('u1');
    assert.equal(channels.length, 1);
    const [channel] = channels;
    assert.equal(channel!.legacy, false);
    assert.equal(channel!.configured, true);
    assert.equal(channel!.summary.tokenSource, 'shared');
    assert.equal(JSON.stringify(channel).includes('U'.repeat(30)), false, 'credentials never leave the hub');

    const routes = await hub.routes('u1');
    assert.deepEqual(routes.map(r => r.source).sort(), ['anomaly_crypto', 'anomaly_tradfi', 'price_alert']);
    assert(routes.every(r => r.channelId === channel!.id && r.enabled));
    assert(routes.every(r => r.options.dailyLimit === 10));
    assert.equal(await hub.anomalyReachable('u1'), true);

    const edited = await hub.patchChannel('u1', channel!.id, channel!.generation, { name: 'Primary phone' });
    assert.equal(edited.name, 'Primary phone');
    assert.equal(edited.legacy, false);
    assert.equal(edited.generation, 1);

    await hub.removeChannel('u1', edited.id);
    assert.deepEqual(await hub.channels('u1'), []);
    assert.deepEqual(await hub.routes('u1'), []);

    assert.deepEqual(await hub.channels('u2'), []);
    assert.equal(await hub.anomalyReachable('u2'), false);
  } finally {
    await db.close();
  }
});

test('dispatch fans out per source, de-duplicates channels, applies route profiles, quiet hours and channel enablement', async () => {
  const { db, repositories } = await setup();
  try {
    const sent: Sent[] = [];
    let t = Date.UTC(2026, 9, 29, 12, 0);
    const hub = createNotifyHub({
      db,
      config,
      repositories,
      now: () => t,
      adapters: { pushover: pushoverAdapter, fake: fakeAdapter(sent) },
    });
    const a = await hub.createChannel('u1', { type: 'fake', name: 'A', config: { to: 'a' } });
    const b = await hub.createChannel('u1', { type: 'fake', name: 'B', config: { to: 'b' } });
    await assert.rejects(
      hub.createChannel('u1', { type: 'fake', name: 'X', config: { to: 'bad' } }),
      (e: unknown) => e instanceof HubError && e.code === 'notification_failed',
    );
    await assert.rejects(
      hub.createChannel('u1', { type: 'fake', name: 'X', config: { nope: 1 } }),
      (e: unknown) => e instanceof HubError && e.code === 'invalid_request',
    );

    await hub.setRoutes('u1', [
      { source: 'anomaly_crypto', channelId: a.id, enabled: true, options: route({ notification: { ...fallback, priority: 2 } }) },
      { source: 'anomaly_tradfi', channelId: a.id, enabled: true, options: route() },
      {
        source: 'anomaly_tradfi',
        channelId: b.id,
        enabled: true,
        options: route({ quiet: { from: '11:00', to: '13:00', offsetMinutes: 0 } }),
      },
    ]);

    const first = await hub.dispatch(
      'u1',
      ['anomaly_crypto', 'anomaly_tradfi'],
      { title: 'T', body: 'B', severity: 'warning' },
      fallback,
    );
    assert.equal(first.outcome, 'sent');
    assert.equal(first.channels, 1);
    assert.deepEqual(
      sent.map(({ to, priority }) => ({ to, priority })),
      [{ to: 'a', priority: 2 }],
      'A sends once with the first source profile while B is quiet',
    );

    t = Date.UTC(2026, 9, 29, 14, 0);
    sent.length = 0;
    await hub.dispatch('u1', ['anomaly_tradfi'], { title: 'T2', body: 'B', severity: 'warning' }, fallback);
    assert.deepEqual(sent.map(s => [s.to, s.priority]).sort(), [['a', 1], ['b', 1]]);

    await hub.patchChannel('u1', b.id, b.generation, { enabled: false });
    sent.length = 0;
    await hub.dispatch('u1', ['anomaly_tradfi'], { title: 'T3', body: 'B', severity: 'warning' }, fallback);
    assert.deepEqual(sent.map(s => s.to), ['a']);
    await assert.rejects(
      hub.patchChannel('u1', b.id, b.generation, { name: 'stale' }),
      (e: unknown) => e instanceof HubError && e.code === 'generation_conflict',
    );

    await hub.removeChannel('u1', a.id);
    assert.equal((await hub.routes('u1')).some(r => r.channelId === a.id), false);
    await assert.rejects(
      hub.setRoutes('u2', [{ source: 'anomaly_crypto', channelId: b.id, enabled: true, options: route() }]),
      (e: unknown) => e instanceof HubError && e.code === 'not_found',
    );
    const none = await hub.dispatch('u2', ['anomaly_crypto'], { title: 'T', body: 'B', severity: 'info' }, fallback);
    assert.equal(none.outcome, 'skipped');
    assert.equal(none.code, 'no_route');
  } finally {
    await db.close();
  }
});

test('quiet hours and delivery history record skipped and successful route outcomes', async () => {
  const { db, repositories } = await setup();
  try {
    const sent: Sent[] = [];
    let t = Date.UTC(2026, 9, 29, 12, 0);
    const hub = createNotifyHub({
      db,
      config,
      repositories,
      now: () => t,
      adapters: { fake: fakeAdapter(sent) },
    });
    const channel = await hub.createChannel('u1', { type: 'fake', name: 'Quiet phone', config: { to: 'phone' } });
    await hub.setRoutes('u1', [{
      source: 'anomaly_crypto',
      channelId: channel.id,
      enabled: true,
      options: route({ quiet: { from: '11:00', to: '13:00', offsetMinutes: 0 } }),
    }]);

    const quiet = await hub.dispatch(
      'u1',
      ['anomaly_crypto'],
      { title: 'Quiet event', body: 'B', severity: 'warning' },
      fallback,
      'quiet-event',
    );
    assert.deepEqual(quiet, { outcome: 'skipped', code: 'quiet_hours', channels: 0 });
    assert.equal(sent.length, 0);
    let logs = await hub.deliveries('u1');
    assert.equal(logs.length, 1);
    assert.deepEqual(
      { source: logs[0]!.source, channelName: logs[0]!.channelName, title: logs[0]!.title, outcome: logs[0]!.outcome, code: logs[0]!.code },
      { source: 'anomaly_crypto', channelName: 'Quiet phone', title: 'Quiet event', outcome: 'skipped', code: 'quiet_hours' },
    );

    t = Date.UTC(2026, 9, 29, 14, 0);
    const delivered = await hub.dispatch(
      'u1',
      ['anomaly_crypto'],
      { title: 'Delivered event', body: 'B', severity: 'warning' },
      fallback,
      'after-quiet',
    );
    assert.deepEqual(delivered, { outcome: 'sent', code: null, channels: 1 });
    logs = await hub.deliveries('u1');
    assert.equal(logs.length, 2);
    assert.equal(logs[0]!.title, 'Delivered event');
    assert.equal(logs[0]!.outcome, 'sent');
    assert.equal(logs[1]!.code, 'quiet_hours');
  } finally {
    await db.close();
  }
});

test('route dailyLimit caps each channel independently and logs the blocked delivery', async () => {
  const { db, repositories } = await setup();
  try {
    const sent: Sent[] = [];
    const t = Date.UTC(2026, 9, 29, 12, 0);
    const hub = createNotifyHub({
      db,
      config,
      repositories,
      now: () => t,
      adapters: { fake: fakeAdapter(sent) },
    });
    const capped = await hub.createChannel('u1', { type: 'fake', name: 'Capped', config: { to: 'capped' } });
    const open = await hub.createChannel('u1', { type: 'fake', name: 'Open', config: { to: 'open' } });
    await hub.setRoutes('u1', (['anomaly_crypto', 'anomaly_tradfi'] as const).flatMap(source => [
      { source, channelId: capped.id, enabled: true, options: route({ dailyLimit: 2 }) },
      { source, channelId: open.id, enabled: true, options: route({ dailyLimit: 5 }) },
    ]));

    for (let i = 1; i <= 3; i++) {
      await hub.dispatch(
        'u1',
        ['anomaly_crypto'],
        { title: `Event ${i}`, body: 'B', severity: 'warning' },
        fallback,
        `cap-${i}`,
      );
    }

    assert.deepEqual(sent.map(s => s.to).sort(), ['capped', 'capped', 'open', 'open', 'open']);
    const logs = await hub.deliveries('u1');
    const blocked = logs.find(log => log.title === 'Event 3' && log.channelName === 'Capped');
    assert.equal(blocked?.outcome, 'skipped');
    assert.equal(blocked?.code, 'daily_limit');
    assert.equal(logs.filter(log => log.channelName === 'Open').length, 3);
  } finally {
    await db.close();
  }
});

test('event retry is idempotent per channel: failed retries once, uncertain and sent never replay', async () => {
  const { db, repositories } = await setup();
  try {
    const calls: string[] = [];
    const outcomes = new Map<string, Array<'sent' | 'failed' | 'uncertain'>>([
      ['a', ['uncertain', 'sent']],
      ['b', ['failed', 'sent']],
    ]);
    const adapter: ChannelAdapter<{ to: string }> = {
      type: 'fake',
      configSchema: z.strictObject({ to: z.string() }) as z.ZodType<{ to: string }>,
      async validate() {},
      async send(c) {
        calls.push(c.to);
        const outcome = outcomes.get(c.to)?.shift() ?? 'sent';
        return { outcome, code: outcome === 'sent' ? null : `provider_${outcome}` };
      },
      summary(c) {
        return { to: c.to };
      },
    };
    const hub = createNotifyHub({
      db,
      config,
      repositories,
      now: () => Date.UTC(2026, 9, 29, 12, 0),
      adapters: { fake: adapter },
    });
    const a = await hub.createChannel('u1', { type: 'fake', name: 'A', config: { to: 'a' } });
    const b = await hub.createChannel('u1', { type: 'fake', name: 'B', config: { to: 'b' } });
    await hub.setRoutes('u1', [
      { source: 'anomaly_crypto', channelId: a.id, enabled: true, options: route() },
      { source: 'anomaly_crypto', channelId: b.id, enabled: true, options: route() },
    ]);
    const message = { title: 'Retry once', body: 'B', severity: 'warning' as const };

    await hub.dispatch('u1', ['anomaly_crypto'], message, fallback, 'same-event');
    assert.deepEqual(calls, ['a', 'b']);
    await hub.dispatch('u1', ['anomaly_crypto'], message, fallback, 'same-event');
    assert.deepEqual(calls, ['a', 'b', 'b']);
    await hub.dispatch('u1', ['anomaly_crypto'], message, fallback, 'same-event');
    assert.deepEqual(calls, ['a', 'b', 'b']);

    const logs = await hub.deliveries('u1');
    assert.equal(logs.length, 2);
    assert.equal(logs.find(log => log.channelName === 'A')?.outcome, 'uncertain');
    assert.equal(logs.find(log => log.channelName === 'B')?.outcome, 'sent');
  } finally {
    await db.close();
  }
});

test('channel test is rate limited per channel and records the outcome', async () => {
  const { db, repositories } = await setup();
  try {
    const sent: Sent[] = [];
    let t = 1_000_000;
    const hub = createNotifyHub({
      db,
      config,
      repositories,
      now: () => t,
      adapters: { fake: fakeAdapter(sent) },
    });
    const a = await hub.createChannel('u1', { type: 'fake', name: 'A', config: { to: 'a' } });
    assert.equal((await hub.test('u1', a.id)).outcome, 'sent');
    assert.equal(sent[0]!.priority, 0);
    await assert.rejects(hub.test('u1', a.id), (e: unknown) => e instanceof HubError && e.code === 'rate_limited');
    t += 30_001;
    assert.equal((await hub.test('u1', a.id)).outcome, 'sent');
    const after = (await hub.channels('u1')).find(c => c.id === a.id)!;
    assert.equal(after.lastOutcome, 'sent');
    assert.equal((await hub.deliveries('u1')).filter(log => log.source === 'test').length, 2);
    await assert.rejects(hub.test('u2', a.id), (e: unknown) => e instanceof HubError && e.code === 'not_found');
  } finally {
    await db.close();
  }
});

test('quiet hours wrap midnight and honour the user offset', () => {
  const q = { from: '23:00', to: '07:00', offsetMinutes: 480 };
  assert.equal(inQuietHours(q, Date.UTC(2026, 9, 29, 16, 30)), true);
  assert.equal(inQuietHours(q, Date.UTC(2026, 9, 29, 0, 0)), false);
  assert.equal(inQuietHours(q, Date.UTC(2026, 9, 29, 15, 0)), true);
  assert.equal(inQuietHours(null, 0), false);
});
