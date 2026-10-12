import { z } from 'zod';
import type { AppConfig } from '../config.js';

export interface EmailMessage { to: string; subject: string; text: string }
export interface EmailTransport {
  verify(): Promise<void>;
  send(message: EmailMessage): Promise<void>;
  close?(): void;
}
export interface EmailHealth { state: 'healthy' | 'unhealthy'; code: string | null; lastSuccessAt: number | null }
export class EmailDeliveryError extends Error {
  constructor(public readonly code: 'email_unavailable' | 'email_rejected' | 'email_uncertain' | 'email_configuration') {
    super(code);
    this.name = 'EmailDeliveryError';
  }
}
export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!z.email().safeParse(normalized).success || normalized.length > 254) throw new EmailDeliveryError('email_configuration');
  return normalized;
}
function senderAddress(from: string | undefined): string {
  if (!from || /[\r\n]/.test(from)) throw new EmailDeliveryError('email_configuration');
  const match = from.match(/^(?:[^<>]+<)?([^<>]+)>?$/);
  return normalizeEmail(match?.[1] ?? '');
}
const timeoutMs = 8_000;
async function readJson(response: Response, setReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new EmailDeliveryError('email_uncertain');
  setReader(reader);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32_768) throw new EmailDeliveryError('email_uncertain');
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(body));
  } catch { throw new EmailDeliveryError('email_uncertain'); }
  finally { void reader.cancel().catch(() => {}); }
}
export async function createEmailTransport(config: AppConfig, fetcher: typeof fetch = fetch): Promise<EmailTransport> {
  if (config.email.provider === 'console') {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.appUrl).hostname);
    if (config.environment === 'production' || !local) throw new EmailDeliveryError('email_configuration');
    return {
      async verify() {},
      async send(message) { console.info(`[Open Alert development email] ${message.to}\n${message.text}`); },
    };
  }
  const from = config.email.from;
  const sender = senderAddress(from);
  if (config.email.provider === 'smtp') {
    // Native SMTP is supplied by the Node runtime factory; never bundled into Workers.
    throw new EmailDeliveryError('email_configuration');
  }
  const apiKey = config.email.resendApiKey;
  if (!apiKey) throw new EmailDeliveryError('email_configuration');
  const sandbox = sender === 'onboarding@resend.dev';
  const testRecipient = config.email.testRecipient;
  if (sandbox && !testRecipient) throw new EmailDeliveryError('email_configuration');
  const request = async (path: '/domains' | '/emails', init: RequestInit) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const operation = async () => {
      const response = await fetcher(`https://api.resend.com${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new EmailDeliveryError('email_uncertain'); }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new EmailDeliveryError('email_rejected'); }
      return readJson(response, value => { reader = value; });
    };
    try {
      // Abort is advisory: the deadline must also settle a fetch/body that ignores it.
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new EmailDeliveryError('email_uncertain')); }, timeoutMs);
      })]);
    } catch (error) {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      if (error instanceof EmailDeliveryError) throw error;
      throw new EmailDeliveryError('email_uncertain');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const domain = sender.split('@')[1]!;
  return {
    async verify() {
      // Sandbox and sending-only keys cannot read domains. Local readiness is
      // sufficient here; actual delivery still depends on the provider's checks.
      if (sandbox || !config.email.resendVerifyDomain) return;
      const data = await request('/domains', { method: 'GET' });
      const parsed = z.object({ data: z.array(z.object({ name: z.string(), status: z.string() })) }).safeParse(data);
      if (!parsed.success || !parsed.data.data.some((entry) => entry.name.toLowerCase() === domain && entry.status === 'verified')) {
        throw new EmailDeliveryError('email_configuration');
      }
    },
    async send(message) {
      const to = normalizeEmail(message.to);
      if (sandbox && to !== testRecipient) throw new EmailDeliveryError('email_rejected');
      const data = await request('/emails', { method: 'POST', body: JSON.stringify({ from, to: [to], subject: message.subject, text: message.text }) });
      if (!z.object({ id: z.string().min(1).max(256) }).safeParse(data).success) throw new EmailDeliveryError('email_uncertain');
    },
  };
}
