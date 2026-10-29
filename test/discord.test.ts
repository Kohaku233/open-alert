import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterContext } from '../src/notifications/hub.js';
import { discordAdapter } from '../src/notifications/hub.js';
import type { Fetch } from '../src/notifications/http.js';
import { NotificationError } from '../src/notifications/pushover.js';

const webhookUrl = 'https://discord.com/api/webhooks/123456789012345678/token_abc-123';
const context = (fetch: Fetch): AdapterContext => ({ fetch, timeoutMs: 1000, sharedPushoverAppToken: undefined });
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('Discord webhook config accepts canonical endpoints and rejects non-HTTPS, lookalike and malformed URLs', () => {
  const valid = [
    webhookUrl,
    'https://discordapp.com/api/webhooks/42/a',
  ];
  const invalid = [
    'http://discord.com/api/webhooks/42/token',
    'https://discord.com.evil.test/api/webhooks/42/token',
    'https://discord.com/api/webhooks/not-a-number/token',
    'https://discord.com/api/webhooks/42/token/extra',
    'https://discord.com/api/webhooks/42/token?wait=true',
    'ftp://discord.com/api/webhooks/42/token',
  ];
  for (const url of valid) assert.equal(discordAdapter.configSchema.safeParse({ webhookUrl: url }).success, true, url);
  for (const url of invalid) assert.equal(discordAdapter.configSchema.safeParse({ webhookUrl: url }).success, false, url);
});

test('Discord validation uses a bounded GET and requires a webhook id', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: Fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse({ id: '123456789012345678', name: 'Open Alert' });
  };
  await discordAdapter.validate({ webhookUrl }, context(fetch));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, webhookUrl);
  assert.equal(calls[0]!.init?.method, 'GET');
  assert.equal(calls[0]!.init?.redirect, 'manual');

  await assert.rejects(
    discordAdapter.validate({ webhookUrl }, context(async () => jsonResponse({ name: 'missing id' }))),
    (error: unknown) => error instanceof NotificationError && error.code === 'provider_rejected',
  );
  await assert.rejects(
    discordAdapter.validate({ webhookUrl }, context(async () => jsonResponse({ id: '123' }, 401))),
    (error: unknown) => error instanceof NotificationError && error.code === 'provider_rejected',
  );
});

test('Discord send posts a wait=true embed with mentions disabled and preserves the message URL', async () => {
  let captured: { url: string; init: RequestInit | undefined } | null = null;
  const fetch: Fetch = async (input, init) => {
    captured = { url: String(input), init };
    return jsonResponse({ id: 'message-id' });
  };
  const mentionText = '@everyone <@123456789012345678> <@&987654321098765432>';
  const result = await discordAdapter.send(
    { webhookUrl },
    {
      title: 'BTC price alert',
      body: mentionText,
      url: 'https://example.test/alerts/abc',
      severity: 'critical',
    },
    { priority: 2, retry: 30, expire: 60, sound: 'siren' },
    context(fetch),
  );

  assert.deepEqual(result, { outcome: 'sent', code: null });
  assert(captured);
  const { url, init } = captured as { url: string; init: RequestInit | undefined };
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, webhookUrl);
  assert.equal(parsed.searchParams.get('wait'), 'true');
  assert.equal(init?.method, 'POST');
  assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
  const payload = JSON.parse(String(init?.body)) as {
    username: string;
    allowed_mentions: { parse: string[] };
    embeds: Array<{ title: string; description: string; url?: string; color: number }>;
  };
  assert.equal(payload.username, 'Open Alert');
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.deepEqual(payload.embeds, [{
    title: 'BTC price alert',
    description: mentionText,
    url: 'https://example.test/alerts/abc',
    color: 0xe55b65,
  }]);
});

test('Discord send omits the embed URL when the message has none and bounds title and body lengths', async () => {
  let payload: { embeds: Array<{ title: string; description: string; url?: string }> } | undefined;
  const fetch: Fetch = async (_input, init) => {
    payload = JSON.parse(String(init?.body)) as typeof payload;
    return jsonResponse({ id: 'message-id' });
  };
  const result = await discordAdapter.send(
    { webhookUrl },
    { title: 'T'.repeat(300), body: 'B'.repeat(5000), severity: 'info' },
    { priority: 0, retry: 30, expire: 60, sound: 'pushover' },
    context(fetch),
  );
  assert.equal(result.outcome, 'sent');
  assert.equal(payload?.embeds[0]?.title.length, 256);
  assert.equal(payload?.embeds[0]?.description.length, 4096);
  assert.equal(Object.hasOwn(payload!.embeds[0]!, 'url'), false);
});

test('Discord response and transport failures distinguish rejection, uncertainty and success', async () => {
  const message = { title: 'T', body: 'B', severity: 'warning' as const };
  const options = { priority: 1, retry: 60, expire: 600, sound: 'siren' };
  const rejected = await discordAdapter.send(
    { webhookUrl },
    message,
    options,
    context(async () => jsonResponse({ message: 'bad webhook' }, 404)),
  );
  assert.deepEqual(rejected, { outcome: 'failed', code: 'provider_rejected' });

  const uncertainResponse = await discordAdapter.send(
    { webhookUrl },
    message,
    options,
    context(async () => jsonResponse({ message: 'upstream unavailable' }, 503)),
  );
  assert.deepEqual(uncertainResponse, { outcome: 'uncertain', code: 'provider_response_uncertain' });

  const uncertainTransport = await discordAdapter.send(
    { webhookUrl },
    message,
    options,
    context(async () => { throw new Error('network down'); }),
  );
  assert.deepEqual(uncertainTransport, { outcome: 'uncertain', code: 'provider_transport_uncertain' });
});
