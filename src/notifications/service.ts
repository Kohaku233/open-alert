import type { AppConfig } from '../config.js';
import type { ChannelRecord, OutboxRecord, Repositories } from '../contracts/db.js';
import type { ChannelProfile, ComponentHealth, EncryptedSecret } from '../contracts/domain.js';
import { DEFAULT_NOTIFICATION } from '../contracts/domain.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import type { Fetch } from './http.js';
import { NotificationError, sendPushover, validatePushoverChannel } from './pushover.js';
import type { PushoverCredentials } from './pushover.js';

export interface NotificationServiceOptions { fetch?: Fetch; now?: () => number }
export interface DeliveryResult { outcome: 'sent' | 'failed' | 'uncertain'; code: string | null; receipt: EncryptedSecret | null }
/** API owns tests.claim/tests.finish. This port never allocates a second claim. */
export function createNotifications(config: AppConfig, options: NotificationServiceOptions = {}) {
  const now = options.now ?? Date.now;
  let lastSuccessAt: number | null = null;
  let failure: string | null = null;
  const transport = { ...(options.fetch ? { fetch: options.fetch } : {}), timeoutMs: config.runtime.requestTimeoutMs };
  async function resolve(userId: string, channel: ChannelRecord): Promise<PushoverCredentials> {
    if (channel.userId !== userId) throw new NotificationError('channel_owner_mismatch');
    const userKey = await decryptSecret(config.encryptionKey, userId, 'userKey', channel.userKey);
    const appToken = channel.privateAppToken
      ? await decryptSecret(config.encryptionKey, userId, 'appToken', channel.privateAppToken)
      : config.sharedPushoverAppToken;
    if (!appToken) throw new NotificationError('channel_unconfigured');
    return { userKey, appToken };
  }
  async function validate(userId: string, channel: ChannelRecord): Promise<void> {
    try {
      const result = await validatePushoverChannel(await resolve(userId, channel), transport);
      if (!result.valid) throw new NotificationError('provider_rejected');
      lastSuccessAt = now(); failure = null;
    } catch { failure = 'channel_validation_failed'; throw new NotificationError(failure); }
  }
  async function send(userId: string, channel: ChannelRecord, message: string, title: string, notification: typeof DEFAULT_NOTIFICATION): Promise<DeliveryResult> {
    let credentials: PushoverCredentials;
    try { credentials = await resolve(userId, channel); }
    catch { failure = 'channel_unavailable'; return { outcome: 'failed', code: failure, receipt: null }; }
    try {
      const result = await sendPushover(credentials, message, title, notification, transport);
      if (result.outcome !== 'sent') { failure = result.code; return result; }
      const receipt = result.receipt === null ? null : await encryptSecret(config.encryptionKey, userId, 'receipt', result.receipt);
      lastSuccessAt = now(); failure = null;
      return { outcome: 'sent', code: null, receipt };
    } catch (error) {
      if (error instanceof NotificationError && ['invalid_channel','invalid_message','invalid_timeout'].includes(error.code)) {
        failure = 'notification_input_invalid'; return { outcome: 'failed', code: failure, receipt: null };
      }
      // Input errors are known before dispatch. An encryption failure after acceptance is ambiguous.
      failure = 'notification_failed'; return { outcome: 'uncertain', code: failure, receipt: null };
    }
  }
  async function test(userId: string, channel: ChannelRecord): Promise<{ outcome: 'sent' | 'failed' | 'uncertain'; code: string | null }> {
    const result = await send(userId, channel, 'Open Alert notification test', 'Open Alert', { ...DEFAULT_NOTIFICATION, priority: 0, sound: 'pushover' });
    return { outcome: result.outcome, code: result.code };
  }
  function health(): ComponentHealth { return { state: failure ? 'degraded' : lastSuccessAt === null ? 'starting' : 'healthy', lastSuccessAt, code: failure }; }
  return { encrypt: encryptSecret, validate, test, health, send, validateCredentials: validate, sendTest: test };
}

/** Scheduler and optional standalone test convenience use the SAME durable repositories. */
export function createNotificationService(options: NotificationServiceOptions & { config: AppConfig; repositories: Repositories; provider?: ReturnType<typeof createNotifications> }) {
  const { config, repositories } = options, now = options.now ?? Date.now;
  const provider = options.provider ?? createNotifications(config, options);
  async function deliver(event: OutboxRecord): Promise<DeliveryResult> {
    if (event.phase !== 'sending' || !event.claimId || event.claimFence === null) return { outcome: 'failed', code: 'delivery_not_claimed', receipt: null };
    const [settings, channel] = await Promise.all([repositories.settings.get(event.userId), repositories.channels.get(event.userId)]);
    if (!settings || !settings.enabled || settings.disabled || settings.generation !== event.settingsGeneration || !channel || channel.generation !== event.channelGeneration) return { outcome: 'failed', code: 'channel_changed', receipt: null };
    const direction = event.side === 'upper' ? 'at or above' : 'at or below';
    // No user-supplied URLs, receipt capability, HTML, or provider credential in the message.
    return provider.send(event.userId, channel, `${event.name}\n${event.instrument}: ${event.price} USDT (${direction} ${event.threshold})\nExchange timestamp: ${new Date(event.timestamp).toISOString()}`, 'Open Alert price alert', event.notification);
  }
  async function test(userId: string) {
    const [settings, channel] = await Promise.all([repositories.settings.get(userId), repositories.channels.get(userId)]);
    if (!settings || settings.disabled) return { outcome: 'forbidden' as const, at: now(), code: 'forbidden' };
    if (!channel || (!channel.privateAppToken && !config.sharedPushoverAppToken)) return { outcome: 'channel_unconfigured' as const, at: now(), code: 'channel_unconfigured' };
    const claim = await repositories.tests.claim(userId, channel.generation, settings.generation, now());
    if (!claim) return { outcome: 'daily_limit' as const, at: now(), code: 'test_claim_blocked' };
    let result: Awaited<ReturnType<typeof provider.test>>;
    try { result = await provider.test(userId, channel); }
    catch { result = { outcome: 'uncertain', code: 'provider_uncertain' }; }
    const at = now();
    const saved = await repositories.tests.finish(userId, claim.id, claim.claimId, result.outcome, result.code, at);
    return saved ? { ...result, at } : { outcome: 'uncertain' as const, at, code: 'finish_not_committed' };
  }
  async function channelProfile(userId: string): Promise<ChannelProfile> {
    const channel = await repositories.channels.get(userId);
    const tokenSource = channel?.privateAppToken ? 'private' : config.sharedPushoverAppToken ? 'shared' : 'missing';
    return { provider: 'pushover', configured: Boolean(channel && tokenSource !== 'missing'), tokenSource, userKeyPresent: Boolean(channel), privateTokenPresent: Boolean(channel?.privateAppToken), updatedAt: channel?.updatedAt ?? null };
  }
  return { ...provider, test, deliver, channelProfile };
}
