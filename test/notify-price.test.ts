import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { createSQLite } from '../src/db/sqlite.js';
import { migrateApp } from '../src/db/migrations.js';
import { createRepositories } from '../src/db/repositories.js';
import type { ChannelAdapter } from '../src/notifications/hub.js';
import { createNotifyHub, DEFAULT_ROUTE_OPTIONS, ensureHubSchema } from '../src/notifications/hub.js';
import { createNotificationService } from '../src/notifications/service.js';

const now = Date.UTC(2026, 9, 29, 12, 0, 0);
const config = loadConfig({
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  AUTH_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEY: 'ab'.repeat(32),
  EMAIL_PROVIDER: 'console',
  SQLITE_PATH: ':memory:',
});

test('price alerts deliver through hub routes without legacy Pushover and only retry failed channels', async () => {
  const db = await createSQLite(':memory:', true);
  try {
    await db.execute('CREATE TABLE "user" (id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT \'user\')');
    await migrateApp(db, now);
    await ensureHubSchema(db);
    await db.execute('INSERT INTO "user"(id,email,name) VALUES(?,?,?)', ['u1', 'u1@example.test', 'u1']);

    const repositories = createRepositories(db, config, true);
    await repositories.settings.initialize('u1', now);
    await repositories.settings.patch('u1', 0, { enabled: true }, now);
    const alert = await repositories.alerts.create('u1', {
      name: 'BTC breakout',
      instrument: 'BTC-USDT-SWAP',
      side: 'upper',
      threshold: 100,
      enabled: true,
    }, now);

    assert.equal(config.sharedPushoverAppToken, undefined);
    assert.equal(await repositories.channels.get('u1'), null);
    assert.equal(await repositories.scheduler.hasWork(false), false);

    const calls = new Map<string, number>();
    const adapter: ChannelAdapter<{ to: string }> = {
      type: 'fake',
      configSchema: z.strictObject({ to: z.string().min(1) }) as z.ZodType<{ to: string }>,
      async validate() {},
      async send(channel) {
        const attempt = (calls.get(channel.to) ?? 0) + 1;
        calls.set(channel.to, attempt);
        return channel.to === 'retry' && attempt === 1
          ? { outcome: 'failed', code: 'provider_rejected' }
          : { outcome: 'sent', code: null };
      },
      summary(channel) {
        return { to: channel.to };
      },
    };

    let clock = now;
    const hub = createNotifyHub({
      db,
      config,
      repositories,
      now: () => clock,
      adapters: { fake: adapter },
    });
    const stable = await hub.createChannel('u1', { type: 'fake', name: 'Stable', config: { to: 'stable' } });
    const retry = await hub.createChannel('u1', { type: 'fake', name: 'Retry', config: { to: 'retry' } });
    await hub.setRoutes('u1', [stable, retry].map(channel => ({
      source: 'price_alert' as const,
      channelId: channel.id,
      enabled: true,
      options: { ...DEFAULT_ROUTE_OPTIONS },
    })));

    assert.deepEqual((await hub.channels('u1')).map(channel => channel.type), ['fake', 'fake']);
    const active = await repositories.alerts.listActiveWithProfiles(20);
    assert.equal(active.items.length, 1);
    assert.equal(active.items[0]!.id, alert.id);
    assert.equal(active.items[0]!.channelGeneration, -1);
    assert.equal(active.items[0]!.hasPrivateAppToken, false);
    assert.equal(active.cursor, null);
    assert.equal(await repositories.scheduler.hasWork(false), true);

    const lease = (await repositories.scheduler.acquireLease('price-integration', now, 60_000))!;
    const triggerId = crypto.randomUUID();
    assert.equal(await repositories.alerts.reserveTrigger({
      triggerId,
      alertId: alert.id,
      userId: 'u1',
      generation: active.items[0]!.generation,
      settingsGeneration: active.items[0]!.settingsGeneration,
      channelGeneration: active.items[0]!.channelGeneration,
      tick: { instrument: alert.instrument, price: alert.threshold, timestamp: now, receivedAt: now },
      now,
      lease,
    }), true);

    const claimId = crypto.randomUUID();
    const claimed = await repositories.scheduler.claimDelivery(triggerId, claimId, lease, now);
    assert.ok(claimed);
    assert.equal(claimed.phase, 'sending');
    assert.equal(claimed.attempts, 1);

    const service = createNotificationService({ config, repositories, hub, now: () => clock });
    const first = await service.deliver(claimed);
    assert.deepEqual(first, { outcome: 'failed', code: 'provider_rejected', receipt: null });
    assert.equal(calls.get('stable'), 1);
    assert.equal(calls.get('retry'), 1);

    const firstFinishedAt = now + 1;
    assert.equal(await repositories.scheduler.finishDelivery(
      triggerId, claimId, lease, 'queued', 'provider_rejected', null, firstFinishedAt,
    ), true);
    assert.equal((await repositories.outbox.getForUser('u1', triggerId))!.phase, 'queued');

    const retryAt = firstFinishedAt + 60_000;
    const retryLease = (await repositories.scheduler.acquireLease('price-integration-retry', retryAt, 60_000))!;
    assert.notEqual(retryLease.fence, lease.fence);
    const due = await repositories.scheduler.listDue(retryAt, 20);
    assert.deepEqual(due.map(event => event.triggerId), [triggerId]);
    const reclaimed = await repositories.scheduler.claimDelivery(triggerId, crypto.randomUUID(), retryLease, retryAt);
    assert.ok(reclaimed);
    assert.equal(reclaimed.attempts, 2);

    clock = retryAt;
    const second = await service.deliver(reclaimed);
    assert.deepEqual(second, { outcome: 'sent', code: null, receipt: null });
    assert.equal(calls.get('stable'), 1, 'the successful channel must not be sent again');
    assert.equal(calls.get('retry'), 2);

    assert.equal(await repositories.scheduler.finishDelivery(
      triggerId, reclaimed.claimId!, retryLease, 'sent', null, null, retryAt + 1,
    ), true);
    const completed = (await repositories.outbox.getForUser('u1', triggerId))!;
    assert.equal(completed.phase, 'sent');
    assert.equal((await repositories.alerts.getForUser('u1', alert.id))!.pendingTriggerId, null);
    assert.equal(await repositories.channels.get('u1'), null, 'the hub path must not create a legacy channel');
    assert.deepEqual(
      (await hub.deliveries('u1')).filter(delivery => delivery.source === 'price_alert').map(delivery => delivery.outcome),
      ['sent', 'sent'],
    );
  } finally {
    await db.close();
  }
});
