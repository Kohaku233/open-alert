import { test } from 'node:test';
import { createNodeEmailTransport } from '../src/auth/email.node.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createEmailTransport, EmailDeliveryError } from '../src/auth/email.js';

const config = (overrides: Record<string, string>) => loadConfig({ NODE_ENV: 'test', APP_URL: 'http://localhost:3000', AUTH_SECRET: 'email-test-secret-at-least-thirty-two-characters', ENCRYPTION_KEY: '22'.repeat(32), EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'Open Alert <alerts@example.com>', RESEND_API_KEY: 'test-key-not-live', ...overrides });
const message = { to: 'test@example.com', subject: 'Test code', text: 'Fixture only' };

test('Resend verifies sender domain, sends fixed HTTPS request, enforces redirect/manual timeout and valid id', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport = await createEmailTransport(config({}), (async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Response.json(String(url).endsWith('/domains') ? { data: [{ name: 'example.com', status: 'verified' }] } : { id: 'fixture-id' });
  }) as typeof fetch);
  await transport.verify(); await transport.send(message);
  assert.deepEqual(calls.map(c => c.url), ['https://api.resend.com/domains', 'https://api.resend.com/emails']);
  for (const call of calls) { assert.equal(call.init.redirect, 'manual'); assert.ok(call.init.signal); }
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string).to, ['test@example.com']);
});

test('Resend sending-only mode skips domain HTTP without bypassing delivery rejection', async () => {
  const calls: string[] = [];
  const transport = await createEmailTransport(config({ RESEND_VERIFY_DOMAIN: 'false' }), (async (url) => {
    calls.push(String(url));
    return Response.json({ name: 'validation_error', message: 'fixture rejection' }, { status: 403 });
  }) as typeof fetch);
  await transport.verify();
  assert.equal(calls.length, 0);
  await assert.rejects(transport.send(message), { code: 'email_rejected' });
  assert.deepEqual(calls, ['https://api.resend.com/emails']);
});

test('Resend sandbox skips domain HTTP and accepts only the normalized configured recipient', async () => {
  for (const verifyDomain of ['true', 'false']) {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport = await createEmailTransport(config({ EMAIL_FROM: 'Open Alert <ONBOARDING@resend.dev>', EMAIL_TEST_RECIPIENT: '  Owner@Example.COM  ', RESEND_VERIFY_DOMAIN: verifyDomain }), (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ id: 'sandbox-fixture-id' });
    }) as typeof fetch);
    await transport.verify();
    assert.equal(calls.length, 0);
    await assert.rejects(transport.send(message), (error: unknown) => {
      assert.ok(error instanceof EmailDeliveryError);
      assert.equal(error.code, 'email_rejected');
      assert.equal(error.message, 'email_rejected');
      assert.equal(JSON.stringify(error).includes('owner@example.com'), false);
      return true;
    });
    assert.equal(calls.length, 0);
    await transport.send({ ...message, to: '  OWNER@Example.com  ' });
    assert.deepEqual(calls.map(call => call.url), ['https://api.resend.com/emails']);
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string).to, ['owner@example.com']);
  }
});

test('a test recipient does not restrict an operator-verified custom sender', async () => {
  let to: string[] | undefined;
  const transport = await createEmailTransport(config({ RESEND_VERIFY_DOMAIN: 'false', EMAIL_TEST_RECIPIENT: 'owner@example.com' }), (async (_, init) => {
    to = JSON.parse(init!.body as string).to;
    return Response.json({ id: 'fixture-id' });
  }) as typeof fetch);
  await transport.verify(); await transport.send(message);
  assert.deepEqual(to, [message.to]);
});

test('Resend rejects unverified sender, non-2xx/redirect and malformed success; no ignored failures', async () => {
  const notVerified = await createEmailTransport(config({}), (async () => Response.json({ data: [{ name: 'example.com', status: 'pending' }] })) as typeof fetch);
  await assert.rejects(notVerified.verify(), { code: 'email_configuration' });
  for (const response of [new Response('', { status: 302, headers: { location: 'https://evil.example' } }), Response.json({ error: 'no' }, { status: 400 }), Response.json({}), new Response('not json')]) {
    const transport = await createEmailTransport(config({}), (async () => response) as typeof fetch);
    await assert.rejects(transport.send(message), EmailDeliveryError);
  }
  const timeout = await createEmailTransport(config({}), (async () => { throw new DOMException('fixture timeout', 'TimeoutError'); }) as typeof fetch);
  await assert.rejects(timeout.send(message), { code: 'email_uncertain' });
});

test('production console email is refused and sender header injection rejected', async () => {
  assert.throws(() => config({ NODE_ENV: 'production', APP_URL: 'https://alert.example.com', EMAIL_PROVIDER: 'console' }));
  await assert.rejects(createEmailTransport(config({ NODE_ENV: 'development', APP_URL: 'https://alert.example.com', EMAIL_PROVIDER: 'console' })), { code: 'email_configuration' });
  await assert.rejects(createEmailTransport(config({ EMAIL_FROM: 'bad\r\nBcc: attacker@example.com' })), { code: 'email_configuration' });
});

test('Nodemailer v10 verify and send against local SMTP fixture validate accepted/rejected recipients', async () => {
  let rejectRecipient = false;
  const server = createServer(socket => {
    socket.write('220 local-fixture ESMTP\r\n'); let buffer = ''; let data = false;
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) { if (line === '.') { data = false; socket.write('250 Message accepted\r\n'); } continue; }
        if (/^EHLO/i.test(line)) socket.write('250-local-fixture\r\n250 8BITMIME\r\n');
        else if (/^RCPT TO/i.test(line)) socket.write(rejectRecipient ? '550 Recipient rejected\r\n' : '250 OK\r\n');
        else if (/^DATA/i.test(line)) { data = true; socket.write('354 End with dot\r\n'); }
        else if (/^QUIT/i.test(line)) { socket.end('221 Bye\r\n'); }
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const transport = await createNodeEmailTransport(config({ EMAIL_PROVIDER: 'smtp', SMTP_URL: `smtp://127.0.0.1:${address.port}` }));
  try { await transport.verify(); await transport.send(message); rejectRecipient = true; await assert.rejects(transport.send(message), EmailDeliveryError); }
  finally { transport.close?.(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});


test('Resend deadline settles abort-ignoring fetch and stalled body; late responses are cancelled', async () => {
  let cancelled = 0;
  let resolveFetch!: (response: Response) => void;
  const hungFetch = await createEmailTransport(config({}), (() => new Promise<Response>(resolve => { resolveFetch = resolve; })) as typeof fetch);
  const stalledBody = await createEmailTransport(config({}), (async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }))) as typeof fetch);
  const results = await Promise.allSettled([hungFetch.send(message), stalledBody.send(message)]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason instanceof EmailDeliveryError && result.reason.code === 'email_uncertain'));
  assert.equal(cancelled, 1);
  resolveFetch(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } })));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cancelled, 2);
});
