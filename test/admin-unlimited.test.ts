import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createApp } from '../src/api/index.js';
import type { ApiDependencies } from '../src/api/ports.js';
import { createAnomalyStore, ensureAnomalySchema } from '../src/anomaly/store.js';
import { loadConfig } from '../src/config.js';
import { migrateApp } from '../src/db/migrations.js';
import { createRepositories } from '../src/db/repositories.js';
import { createSQLite } from '../src/db/sqlite.js';
import type { Repositories, SqlDatabase } from '../src/contracts/db.js';
import type { ComponentHealth, PriceTick } from '../src/contracts/domain.js';
import type { MarketSource } from '../src/markets/source.js';
import type { ChannelAdapter } from '../src/notifications/hub.js';
import {
  createNotifyHub,
  DEFAULT_ROUTE_OPTIONS,
  ensureHubSchema,
  HubError,
} from '../src/notifications/hub.js';
import { encryptSecret } from '../src/notifications/crypto.js';
import { createScheduler } from '../src/scheduler/index.js';

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const ENCRYPTION_KEY = 'ab'.repeat(32);
const good: ComponentHealth = { state: 'healthy', lastSuccessAt: NOW, code: null };
const fallback = { priority: 1, retry: 60, expire: 600, sound: 'siren' } as const;

function config(overrides: Readonly<Record<string, unknown>> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    APP_URL: 'http://localhost:3000',
    AUTH_SECRET: 'a'.repeat(32),
    ENCRYPTION_KEY,
    EMAIL_PROVIDER: 'console',
    SQLITE_PATH: ':memory:',
    ...overrides,
  });
}

async function setup(
  overrides: Readonly<Record<string, unknown>> = {},
  roles: Readonly<Record<string, 'user' | 'admin'>> = { admin: 'admin', user: 'user' },
  hub = false,
) {
  const db = await createSQLite(':memory:', true);
  await db.execute('CREATE TABLE "user" (id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT \'user\')');
  await db.execute('CREATE TABLE IF NOT EXISTS "session" (id TEXT PRIMARY KEY,user_id TEXT)');
  await db.execute('CREATE TABLE IF NOT EXISTS rate_limit (id TEXT PRIMARY KEY,"key" TEXT NOT NULL UNIQUE,count INTEGER NOT NULL,last_request INTEGER NOT NULL)');
  await migrateApp(db, NOW);
  const appConfig = config(overrides);
  const repositories = createRepositories(db, appConfig, hub);
  for (const [id, role] of Object.entries(roles)) {
    await db.execute('INSERT INTO "user"(id,email,name,role) VALUES(?,?,?,?)', [id, `${id}@example.test`, id, role]);
    await repositories.settings.initialize(id, NOW);
    await repositories.settings.patch(id, 0, { enabled: true }, NOW);
  }
  return { db, config: appConfig, repositories };
}

function rule(name: string, instrument: string) {
  return { name, instrument, side: 'upper' as const, threshold: 100, enabled: true };
}

async function reserve(
  repositories: Repositories,
  userId: string,
  alertId: string,
  generation: number,
  settingsGeneration: number,
  channelGeneration: number,
  instrument: string,
  tick: PriceTick,
  lease: Awaited<ReturnType<Repositories['scheduler']['acquireLease']>> & {},
) {
  const triggerId = crypto.randomUUID();
  assert.equal(await repositories.alerts.reserveTrigger({
    triggerId,
    alertId,
    userId,
    generation,
    settingsGeneration,
    channelGeneration,
    tick,
    now: NOW,
    lease,
  }), true);
  return triggerId;
}

function fakeMarketSource(ticks: readonly PriceTick[]) {
  const byInstrument = new Map(ticks.map(tick => [tick.instrument, tick]));
  const demand: string[] = [];
  const markets = ticks.map(tick => ({
    instrument: tick.instrument,
    base: tick.instrument.split('-')[0]!,
    quote: 'USDT' as const,
    tickSize: '0.1',
    state: 'live' as const,
    tradingViewSymbol: '',
  }));
  const source = {
    mode: 'polling' as const,
    effectiveDemand: demand,
    acknowledgeSamples() {},
    async refreshCatalog() {},
    async refresh() {},
    getMarkets() {
      return { markets, updatedAt: NOW, stale: false };
    },
    getPrices() {
      return [...byInstrument.values()];
    },
    ticks() {
      return new Map(byInstrument);
    },
    priceHealth() {
      return good;
    },
    lastPollAt() {
      return NOW;
    },
    async setDemand(instruments: readonly string[]) {
      demand.splice(0, demand.length, ...instruments);
    },
    async stop() {},
    eligible(instrument: string) {
      return byInstrument.has(instrument);
    },
    samples(instrument: string) {
      const tick = byInstrument.get(instrument);
      return tick ? [tick] : [];
    },
    drainSamples(instrument: string) {
      const tick = byInstrument.get(instrument);
      return tick ? [tick] : [];
    },
    diagnostics() {
      return {
        stopped: false,
        queued: 0,
        queueCapacity: 100,
        demandCapacity: 100,
        venues: [],
        instruments: [],
        replayCapacity: 100,
      };
    },
  } satisfies MarketSource & { effectiveDemand: string[] };
  return source;
}

test('server DB role permits admin over-limit rules and markets on an isolated in-memory DB while ordinary caps and scheduler work continue', async () => {
  const f = await setup({
    MAX_ALERTS_PER_USER: 1,
    MAX_INSTRUMENTS_PER_USER: 1,
    MAX_ACTIVE_ALERTS: 1,
    MAX_GLOBAL_INSTRUMENTS: 1,
    MAX_USERS: 10,
    PUSHOVER_APP_TOKEN: 'T'.repeat(30),
  });
  try {
    await f.repositories.channels.put('admin', null, await encryptSecret(ENCRYPTION_KEY, 'admin', 'userKey', 'A'.repeat(30)), null, NOW);
    await f.repositories.channels.put('user', null, await encryptSecret(ENCRYPTION_KEY, 'user', 'userKey', 'B'.repeat(30)), null, NOW);

    const adminRules = [
      await f.repositories.alerts.create('admin', rule('admin BTC', 'BTC-USDT-SWAP'), NOW),
      await f.repositories.alerts.create('admin', rule('admin ETH', 'ETH-USDT-SWAP'), NOW),
      await f.repositories.alerts.create('admin', rule('admin SOL', 'SOL-USDT-SWAP'), NOW),
      await f.repositories.alerts.create('admin', rule('admin stale', 'XRP-USDT-SWAP'), NOW),
    ];
    const ordinary = await f.repositories.alerts.create('user', rule('ordinary', 'DOGE-USDT-SWAP'), NOW);
    await assert.rejects(
      f.repositories.alerts.create('user', rule('ordinary capped', 'ADA-USDT-SWAP'), NOW),
      /limit_exceeded/,
      'an administrator exemption must not widen ordinary account creation caps',
    );

    const ticks: PriceTick[] = [
      { instrument: adminRules[0]!.instrument, price: 100, timestamp: NOW, receivedAt: NOW },
      { instrument: adminRules[1]!.instrument, price: 100, timestamp: NOW, receivedAt: NOW },
      { instrument: adminRules[2]!.instrument, price: 100, timestamp: NOW, receivedAt: NOW },
      { instrument: adminRules[3]!.instrument, price: 100, timestamp: NOW - 30_001, receivedAt: NOW },
      { instrument: ordinary.instrument, price: 100, timestamp: NOW, receivedAt: NOW },
    ];
    const source = fakeMarketSource(ticks);

    const engine = createScheduler({
      config: f.config,
      repositories: f.repositories,
      db: f.db,
      now: () => NOW,
      ownerId: 'capacity-scheduler',
      marketSource: source,
      notifications: {
        deliver: async () => ({ outcome: 'sent', code: null, receipt: null }),
        health: () => good,
      },
    });
    try {
      await engine.tick();
      const due = await f.db.query<{ trigger_id: string }>('SELECT trigger_id FROM outbox ORDER BY trigger_id');
      assert.equal(due.length, 4, 'fresh admin rules above configured caps and one ordinary rule remain schedulable');
      assert.equal((await f.repositories.outbox.listForUser('admin', 20)).items.length, 3);
      assert.equal((await f.repositories.outbox.listForUser('user', 20)).items.length, 1);
      assert.equal((await f.repositories.alerts.getForUser('admin', adminRules[3]!.id))!.triggered, false, 'freshness protection still rejects stale admin market data');
      assert.deepEqual([...source.effectiveDemand].sort(), [...new Set(ticks.map(tick => tick.instrument))].sort());
    } finally {
      await engine.stop();
    }

    await f.repositories.admin.setDisabled('admin', true, NOW + 1);
    assert.ok((await f.repositories.outbox.listForUser('admin', 20)).items.every(event => event.phase === 'cancelled'));
    assert.equal((await f.repositories.outbox.listForUser('user', 20)).items[0]!.phase, 'queued');
  } finally {
    await f.db.close();
  }
});

test('admin bypasses account, site, and route daily limits without spending the ordinary site budget', async () => {
  const f = await setup({
    MAX_ALERTS_PER_USER: 4,
    MAX_INSTRUMENTS_PER_USER: 4,
    MAX_ACTIVE_ALERTS: 20,
    MAX_GLOBAL_INSTRUMENTS: 10,
    DAILY_NOTIFICATION_LIMIT: 1,
    GLOBAL_DAILY_NOTIFICATION_LIMIT: 1,
  });
  try {
    await f.repositories.channels.put('admin', null, await encryptSecret(ENCRYPTION_KEY, 'admin', 'userKey', 'A'.repeat(30)), null, NOW);
    await f.repositories.channels.put('user', null, await encryptSecret(ENCRYPTION_KEY, 'user', 'userKey', 'B'.repeat(30)), null, NOW);
    const adminAlerts = await Promise.all(Array.from({ length: 3 }, (_, i) =>
      f.repositories.alerts.create('admin', rule(`admin ${i}`, 'BTC-USDT-SWAP'), NOW)));
    const ordinaryAlerts = await Promise.all(Array.from({ length: 2 }, (_, i) =>
      f.repositories.alerts.create('user', rule(`ordinary ${i}`, 'BTC-USDT-SWAP'), NOW)));
    const lease = (await f.repositories.scheduler.acquireLease('quota-test', NOW, 60_000))!;
    const tick: PriceTick = { instrument: 'BTC-USDT-SWAP', price: 100, timestamp: NOW, receivedAt: NOW };
    const adminTriggers = await Promise.all(adminAlerts.map(alert =>
      reserve(f.repositories, 'admin', alert.id, alert.generation, 1, 0, alert.instrument, tick, lease)));
    const ordinaryTriggers = await Promise.all(ordinaryAlerts.map(alert =>
      reserve(f.repositories, 'user', alert.id, alert.generation, 1, 0, alert.instrument, tick, lease)));

    for (const triggerId of adminTriggers) {
      const claim = await f.repositories.scheduler.claimDelivery(triggerId, crypto.randomUUID(), lease, NOW);
      assert.ok(claim, 'admin scheduled delivery bypasses the account and site daily caps');
      assert.equal(await f.repositories.scheduler.finishDelivery(triggerId, claim.claimId!, lease, 'sent', null, null, NOW + 1), true);
    }
    assert.equal((await f.repositories.settings.dailyUsage('admin', NOW)).attempts, 3, 'unlimited still counts actual admin attempts');

    const firstTest = await f.repositories.tests.claim('admin', 0, 1, NOW);
    assert.ok(firstTest);
    assert.equal(await f.repositories.tests.finish('admin', firstTest.id, firstTest.claimId, 'sent', null, NOW + 1), true);
    assert.equal(await f.repositories.tests.claim('admin', 0, 1, NOW), null, 'admin quota bypass does not remove the test-send cooldown');
    for (const at of [NOW + 10_001, NOW + 20_002]) {
      const claim = await f.repositories.tests.claim('admin', 0, 1, at);
      assert.ok(claim, 'admin test sends are not blocked by account or site daily quotas');
      assert.equal(await f.repositories.tests.finish('admin', claim.id, claim.claimId, 'sent', null, at + 1), true);
    }
    assert.equal((await f.repositories.settings.dailyUsage('admin', NOW)).attempts, 6, 'scheduled and test attempts share the recorded account usage');

    const ordinaryClaim = await f.repositories.scheduler.claimDelivery(ordinaryTriggers[0]!, crypto.randomUUID(), lease, NOW);
    assert.ok(ordinaryClaim, 'admin traffic must not consume the ordinary user global budget');
    assert.equal(await f.repositories.scheduler.finishDelivery(ordinaryTriggers[0]!, ordinaryClaim.claimId!, lease, 'sent', null, null, NOW + 1), true);
    assert.equal(
      await f.repositories.scheduler.claimDelivery(ordinaryTriggers[1]!, crypto.randomUUID(), lease, NOW),
      null,
      'an ordinary account still stops at its configured daily cap',
    );
    assert.equal((await f.repositories.outbox.getForUser('user', ordinaryTriggers[1]!))!.phase, 'daily_limit');
    assert.equal((await f.db.query<{ attempts: number }>('SELECT attempts FROM global_daily_usage'))[0]!.attempts, 7);
  } finally {
    await f.db.close();
  }
});

test('admin channel creation is unlimited while ordinary users retain MAX_CHANNELS and live DB role changes take effect', async () => {
  const f = await setup({}, { admin: 'admin', user: 'user' }, true);
  try {
    await ensureHubSchema(f.db);
    const adapter: ChannelAdapter<{ to: string }> = {
      type: 'fake',
      configSchema: z.strictObject({ to: z.string().min(1) }) as z.ZodType<{ to: string }>,
      async validate() {},
      async send() {
        return { outcome: 'sent', code: null };
      },
      summary(channel) {
        return { to: channel.to };
      },
    };
    const hub = createNotifyHub({
      db: f.db,
      config: f.config,
      repositories: f.repositories,
      now: () => NOW,
      adapters: { fake: adapter },
    });

    for (let i = 0; i < 11; i++) {
      await hub.createChannel('admin', { type: 'fake', name: `Admin ${i}`, config: { to: `admin-${i}` } });
    }
    for (let i = 0; i < 10; i++) {
      await hub.createChannel('user', { type: 'fake', name: `User ${i}`, config: { to: `user-${i}` } });
    }
    await assert.rejects(
      hub.createChannel('user', { type: 'fake', name: 'User 11', config: { to: 'user-11' } }),
      (error: unknown) => error instanceof HubError && error.code === 'limit_exceeded',
    );

    await f.db.execute('UPDATE "user" SET role=? WHERE id=?', ['user', 'admin']);
    await assert.rejects(
      hub.createChannel('admin', { type: 'fake', name: 'Admin 12', config: { to: 'admin-12' } }),
      (error: unknown) => error instanceof HubError && error.code === 'limit_exceeded',
      'role changes are read from the server DB rather than cached with the hub',
    );
  } finally {
    await f.db.close();
  }
});

test('admin route exemptions keep quiet hours, cooldown, retry, and uncertainty idempotency intact', async () => {
  const f = await setup({}, { admin: 'admin', user: 'user' }, true);
  try {
    await ensureHubSchema(f.db);
    const calls: string[] = [];
    const adminOutcomes: Array<'sent' | 'failed' | 'uncertain'> = ['failed', 'sent', 'uncertain'];
    const adapter: ChannelAdapter<{ to: string }> = {
      type: 'fake',
      configSchema: z.strictObject({ to: z.string().min(1) }) as z.ZodType<{ to: string }>,
      async validate() {},
      async send(channel) {
        calls.push(channel.to);
        const outcome = channel.to === 'admin' ? adminOutcomes.shift() ?? 'sent' : 'sent';
        return { outcome, code: outcome === 'sent' ? null : `provider_${outcome}` };
      },
      summary(channel) {
        return { to: channel.to };
      },
    };
    let clock = NOW;
    const hub = createNotifyHub({
      db: f.db,
      config: f.config,
      repositories: f.repositories,
      now: () => clock,
      adapters: { fake: adapter },
    });
    const admin = await hub.createChannel('admin', { type: 'fake', name: 'Admin', config: { to: 'admin' } });
    const quiet = await hub.createChannel('admin', { type: 'fake', name: 'Quiet', config: { to: 'quiet' } });
    const ordinary = await hub.createChannel('user', { type: 'fake', name: 'Ordinary', config: { to: 'ordinary' } });
    await hub.setRoutes('admin', [
      { source: 'anomaly_crypto', channelId: admin.id, enabled: true, options: { ...DEFAULT_ROUTE_OPTIONS, dailyLimit: 1 } },
      {
        source: 'anomaly_tradfi',
        channelId: quiet.id,
        enabled: true,
        options: { ...DEFAULT_ROUTE_OPTIONS, dailyLimit: 1, quiet: { from: '11:00', to: '13:00', offsetMinutes: 0 } },
      },
    ]);
    await hub.setRoutes('user', [
      { source: 'anomaly_crypto', channelId: ordinary.id, enabled: true, options: { ...DEFAULT_ROUTE_OPTIONS, dailyLimit: 1 } },
    ]);

    assert.equal((await hub.dispatch('admin', ['anomaly_crypto'], { title: 'retry', body: 'B', severity: 'warning' }, fallback, 'retry')).outcome, 'failed');
    assert.equal((await hub.dispatch('admin', ['anomaly_crypto'], { title: 'retry', body: 'B', severity: 'warning' }, fallback, 'retry')).outcome, 'sent');
    assert.equal((await hub.dispatch('admin', ['anomaly_crypto'], { title: 'retry', body: 'B', severity: 'warning' }, fallback, 'retry')).outcome, 'sent');
    assert.deepEqual(calls.filter(value => value === 'admin'), ['admin', 'admin'], 'a confirmed failure may retry once, then the event is idempotent');

    assert.equal((await hub.dispatch('admin', ['anomaly_crypto'], { title: 'uncertain', body: 'B', severity: 'warning' }, fallback, 'uncertain')).outcome, 'uncertain');
    assert.equal((await hub.dispatch('admin', ['anomaly_crypto'], { title: 'uncertain', body: 'B', severity: 'warning' }, fallback, 'uncertain')).outcome, 'uncertain');
    assert.equal(calls.filter(value => value === 'admin').length, 3, 'an ambiguous admin delivery is never replayed');

    assert.deepEqual(
      await hub.dispatch('admin', ['anomaly_tradfi'], { title: 'quiet', body: 'B', severity: 'warning' }, fallback, 'quiet'),
      { outcome: 'skipped', code: 'quiet_hours', channels: 0 },
      'admin status does not bypass quiet hours',
    );

    assert.equal((await hub.dispatch('user', ['anomaly_crypto'], { title: 'one', body: 'B', severity: 'warning' }, fallback, 'user-1')).outcome, 'sent');
    assert.deepEqual(
      await hub.dispatch('user', ['anomaly_crypto'], { title: 'two', body: 'B', severity: 'warning' }, fallback, 'user-2'),
      { outcome: 'skipped', code: 'daily_limit', channels: 0 },
    );

    clock = Date.UTC(2026, 9, 29, 14, 0, 0);
    assert.equal((await hub.test('admin', admin.id)).outcome, 'sent');
    await assert.rejects(
      hub.test('admin', admin.id),
      (error: unknown) => error instanceof HubError && error.code === 'rate_limited',
      'unlimited business quota must not remove channel-test cooldown',
    );
    clock += 30_001;
    assert.equal((await hub.test('admin', admin.id)).outcome, 'sent');
  } finally {
    await f.db.close();
  }
});

test('admin API access and display contracts use the current server DB role rather than a stale principal role', async () => {
  const f = await setup({}, { admin: 'admin', user: 'user' }, true);
  try {
    await ensureAnomalySchema(f.db);
    await ensureHubSchema(f.db);
    let principalRole: 'user' | 'admin' = 'user';
    const auth = {
      async getPrincipal() {
        return { userId: 'admin', sessionId: 'fixture-session', role: principalRole };
      },
      capabilities() {
        return { google: false, emailOtp: true, inviteOnly: true };
      },
      emailHealth() {
        return good;
      },
    } as unknown as ApiDependencies['auth'];
    const adapter: ChannelAdapter<{ to: string }> = {
      type: 'fake',
      configSchema: z.strictObject({ to: z.string().min(1) }) as z.ZodType<{ to: string }>,
      async validate() {},
      async send() {
        return { outcome: 'sent', code: null };
      },
      summary(channel) {
        return { to: channel.to };
      },
    };
    const hub = createNotifyHub({
      db: f.db,
      config: f.config,
      repositories: f.repositories,
      now: () => NOW,
      adapters: { fake: adapter },
    });
    const app = createApp({
      config: f.config,
      db: f.db,
      repositories: f.repositories,
      auth,
      catalog: { get: async () => ({ markets: [], updatedAt: null, stale: false }) },
      anomaly: { store: createAnomalyStore(f.db), status: (() => ({})) as never },
      hub,
      runtime: {
        snapshot: async () => ({
          health: { overall: 'healthy', database: good, scheduler: good, prices: good, notifications: good, email: good },
          lastPollAt: null,
          prices: [],
        }),
      },
      notifications: { health: () => good } as never,
      wake: async () => {},
    });
    const call = (path: string) => app.request(`${f.config.appUrl}${path}`);
    const favorites = Array.from({ length: 51 }, (_, i) => ({
      base: `ASSET${String(i).padStart(3, '0')}`,
      preferred: null,
    }));
    const putFavorites = () => app.request(`${f.config.appUrl}/api/favorites`, {
      method: 'PUT',
      headers: { Origin: f.config.appUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorites }),
    });

    const account = await call('/api/account');
    assert.equal(account.status, 200, await account.clone().text());
    const accountBody = await account.json() as {
      data: { access: { limits: Record<string, number | null> } };
    };
    assert.ok(Object.values(accountBody.data.access.limits).every(limit => limit === null));

    const status = await call('/api/status');
    assert.equal(status.status, 200, await status.clone().text());
    const statusBody = await status.json() as {
      data: { daily: { limit: number | null }; capabilities: { canAdmin: boolean } };
    };
    assert.equal(statusBody.data.daily.limit, null);
    assert.equal(statusBody.data.capabilities.canAdmin, true);

    const notify = await call('/api/notify');
    assert.equal(notify.status, 200, await notify.clone().text());
    const notifyBody = await notify.json() as {
      data: { unlimited: boolean; priceAttemptLimit: number | null };
    };
    assert.equal(notifyBody.data.unlimited, true);
    assert.equal(notifyBody.data.priceAttemptLimit, null);

    const adminByDb = await putFavorites();
    assert.equal(adminByDb.status, 200, await adminByDb.clone().text());
    assert.equal(((await adminByDb.json()) as { data: { favorites: unknown[] } }).data.favorites.length, 51);

    await f.db.execute('UPDATE "user" SET role=? WHERE id=?', ['user', 'admin']);
    principalRole = 'admin';
    const downgradedAccount = await call('/api/account');
    assert.equal(downgradedAccount.status, 200);
    const downgradedBody = await downgradedAccount.json() as {
      data: { access: { limits: Record<string, number | null> } };
    };
    assert.ok(Object.values(downgradedBody.data.access.limits).every(limit => typeof limit === 'number'));
    const userByDb = await putFavorites();
    assert.equal(userByDb.status, 400, 'a stale or forged admin principal cannot override the DB user role');
    assert.equal(((await userByDb.json()) as { error: { code: string } }).error.code, 'invalid_request');
  } finally {
    await f.db.close();
  }
});

test('admin business exemptions do not bypass the site user or invitation policy', async () => {
  const f = await setup({ MAX_USERS: 2 }, { admin: 'admin', user: 'user' });
  try {
    await assert.rejects(
      f.repositories.admin.createInvitation('blocked@example.test', NOW + 60_000, NOW),
      /limit_exceeded/,
      'the global user cap remains independent from administrator business quotas',
    );
  } finally {
    await f.db.close();
  }
});
