import { z } from 'zod';

export const COORDINATOR_ID = 'coordinator-v1' as const;
export const RUNTIME_POLICY = Object.freeze({
  pollIntervalMs: 5_000,
  activeRulesRefreshMs: 30_000,
  stalePriceMs: 30_000,
  futurePriceToleranceMs: 5_000,
  watchdogMs: 60_000,
  leaseMs: 40_000,
  cloudflareDeliveryBatch: 4,
  requestTimeoutMs: 8_000,
  maxDeliveryAttempts: 3,
  maxPendingAgeMs: 600_000,
});

const optionalText = z.preprocess(
  (value) => value === '' || value === undefined ? undefined : value,
  z.string().min(1).optional(),
);
const booleanEnv = (fallback: boolean) => z.enum(['true', 'false'])
  .default(fallback ? 'true' : 'false').transform((value) => value === 'true');
const limit = (fallback: number, max: number) => z.coerce.number()
  .int().min(1).max(max).default(fallback);

function isResendSandboxSender(from: string | undefined): boolean {
  const address = from?.match(/^(?:[^<>]+<)?([^<>]+)>?$/)?.[1]?.trim().toLowerCase();
  return address === 'onboarding@resend.dev';
}

/** No process.env dependency: Node passes process.env; Workers pass string bindings. */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  DEPLOYMENT: z.enum(['node', 'cloudflare']).default('node'),
  DB_DRIVER: z.enum(['sqlite', 'postgres', 'd1']).default('sqlite'),
  DATABASE_URL: optionalText,
  SQLITE_PATH: z.string().min(1).default('./data/open-alert.sqlite'),
  APP_URL: z.string().url(),
  DEV_ORIGIN: optionalText,
  AUTH_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(1),
  GOOGLE_CLIENT_ID: optionalText,
  GOOGLE_CLIENT_SECRET: optionalText,
  EMAIL_PROVIDER: z.enum(['smtp', 'resend', 'console']),
  EMAIL_FROM: optionalText,
  SMTP_URL: optionalText,
  RESEND_API_KEY: optionalText,
  RESEND_VERIFY_DOMAIN: booleanEnv(true),
  EMAIL_TEST_RECIPIENT: z.preprocess(
    (value) => value === '' || value === undefined ? undefined : value,
    z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
  ),
  INVITE_ONLY: booleanEnv(true),
  BOOTSTRAP_TOKEN: optionalText,
  PUSHOVER_APP_TOKEN: optionalText,
  BINANCE_RELAY_URL: optionalText,
  BINANCE_RELAY_TOKEN: optionalText,
  BINANCE_RELAY_BYPASS: optionalText,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MAX_USERS: limit(1_000, 100_000),
  MAX_ALERTS_PER_USER: limit(20, 100),
  MAX_INSTRUMENTS_PER_USER: limit(8, 100),
  MAX_ACTIVE_ALERTS: limit(2_000, 100_000),
  MAX_GLOBAL_INSTRUMENTS: limit(200, 1_000),
  DAILY_NOTIFICATION_LIMIT: limit(20, 20),
  GLOBAL_DAILY_NOTIFICATION_LIMIT: limit(20_000, 2_000_000),
}).superRefine((env, ctx) => {
  const issue = (field: keyof typeof env) => ctx.addIssue({ code: 'custom', path: [field], message: 'invalid deployment configuration' });
  if (env.DEV_ORIGIN) {
    try {
      const origin = new URL(env.DEV_ORIGIN);
      if (env.NODE_ENV !== 'development' || !['localhost','127.0.0.1','[::1]'].includes(origin.hostname) || origin.protocol !== 'http:' || origin.origin !== env.DEV_ORIGIN) issue('DEV_ORIGIN');
    } catch { issue('DEV_ORIGIN'); }
  }
  if (Boolean(env.BINANCE_RELAY_URL) !== Boolean(env.BINANCE_RELAY_TOKEN)) issue('BINANCE_RELAY_TOKEN');
  if (env.BINANCE_RELAY_TOKEN && !/^[A-Za-z0-9_-]{32,256}$/.test(env.BINANCE_RELAY_TOKEN)) issue('BINANCE_RELAY_TOKEN');
  if (env.BINANCE_RELAY_URL) {
    if (env.DEPLOYMENT !== 'cloudflare') issue('BINANCE_RELAY_URL');
    // One authenticated batch per polling cycle, bounded to eight instruments.
    if (env.MAX_GLOBAL_INSTRUMENTS > 8) issue('MAX_GLOBAL_INSTRUMENTS');
    try {
      const url = new URL(env.BINANCE_RELAY_URL);
      if (url.protocol !== 'https:' || url.username || url.password || /[?#\\\\]/.test(env.BINANCE_RELAY_URL) ||
          env.BINANCE_RELAY_URL.trim() !== env.BINANCE_RELAY_URL || /%/.test(url.pathname)) issue('BINANCE_RELAY_URL');
    } catch { issue('BINANCE_RELAY_URL'); }
  }
  if (env.DEPLOYMENT === 'cloudflare' && env.DB_DRIVER !== 'd1') issue('DB_DRIVER');
  if (env.DEPLOYMENT === 'node' && env.DB_DRIVER === 'd1') issue('DB_DRIVER');
  if (env.DB_DRIVER === 'postgres') {
    try {
      const url = new URL(env.DATABASE_URL ?? '');
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) issue('DATABASE_URL');
    } catch { issue('DATABASE_URL'); }
  }
  if (env.DB_DRIVER === 'sqlite' && env.SQLITE_PATH === ':memory:' && env.NODE_ENV === 'production') issue('SQLITE_PATH');
  if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) issue('GOOGLE_CLIENT_SECRET');
  if (env.EMAIL_PROVIDER === 'console' && env.NODE_ENV === 'production') issue('EMAIL_PROVIDER');
  if (env.EMAIL_PROVIDER !== 'console' && !env.EMAIL_FROM) issue('EMAIL_FROM');
  if (env.EMAIL_PROVIDER === 'smtp') {
    if (env.DEPLOYMENT === 'cloudflare') issue('EMAIL_PROVIDER');
    try {
      const url = new URL(env.SMTP_URL ?? '');
      if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname) issue('SMTP_URL');
    } catch { issue('SMTP_URL'); }
  }
  if (env.EMAIL_PROVIDER === 'resend') {
    if (!env.RESEND_API_KEY) issue('RESEND_API_KEY');
    if (isResendSandboxSender(env.EMAIL_FROM) && !env.EMAIL_TEST_RECIPIENT) issue('EMAIL_TEST_RECIPIENT');
  }
  if (env.BOOTSTRAP_TOKEN && env.BOOTSTRAP_TOKEN.length < 32) issue('BOOTSTRAP_TOKEN');
  if (env.ENCRYPTION_KEY === env.AUTH_SECRET) issue('ENCRYPTION_KEY');
  if (env.MAX_INSTRUMENTS_PER_USER > env.MAX_GLOBAL_INSTRUMENTS) issue('MAX_INSTRUMENTS_PER_USER');
  try {
    decodeEncryptionKey(env.ENCRYPTION_KEY);
  } catch { issue('ENCRYPTION_KEY'); }
  try {
    const url = new URL(env.APP_URL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') issue('APP_URL');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && env.NODE_ENV !== 'production')) issue('APP_URL');
  } catch { issue('APP_URL'); }
});

/** AES-256-GCM key, exactly 32 bytes; canonical hex or padded base64 only. */
export function decodeEncryptionKey(value: string): Uint8Array {
  if (/^[a-fA-F0-9]{64}$/.test(value)) {
    return Uint8Array.from(value.match(/../g)!.map((byte) => parseInt(byte, 16)));
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const decoded = atob(value);
    if (decoded.length === 32 && btoa(decoded) === value) {
      return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    }
  }
  throw new Error('ENCRYPTION_KEY must encode exactly 32 bytes');
}

export class ConfigurationError extends Error {
  constructor(public readonly fields: readonly string[]) {
    super(`Invalid configuration fields: ${fields.join(', ')}`);
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(input: Readonly<Record<string, unknown>>) {
  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    // Zod errors can embed provided values: expose field names only.
    throw new ConfigurationError([...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'environment'))]);
  }
  const env = parsed.data;
  return Object.freeze({
    deployment: env.DEPLOYMENT,
    environment: env.NODE_ENV,
    dbDriver: env.DB_DRIVER,
    databaseUrl: env.DATABASE_URL,
    sqlitePath: env.SQLITE_PATH,
    appUrl: new URL(env.APP_URL).origin,
    trustedOrigins: Object.freeze([new URL(env.APP_URL).origin, ...(env.DEV_ORIGIN ? [env.DEV_ORIGIN] : [])]),
    authSecret: env.AUTH_SECRET,
    encryptionKey: env.ENCRYPTION_KEY,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null,
    email: Object.freeze({
      provider: env.EMAIL_PROVIDER, from: env.EMAIL_FROM, smtpUrl: env.SMTP_URL, resendApiKey: env.RESEND_API_KEY,
      resendVerifyDomain: env.RESEND_VERIFY_DOMAIN, testRecipient: env.EMAIL_TEST_RECIPIENT,
      senderMode: env.EMAIL_PROVIDER === 'resend'
        ? isResendSandboxSender(env.EMAIL_FROM) ? 'resend_sandbox' as const
          : env.RESEND_VERIFY_DOMAIN ? 'resend_domain_check' as const : 'resend_sending_only' as const
        : env.EMAIL_PROVIDER,
    }),
    inviteOnly: env.INVITE_ONLY,
    bootstrapToken: env.BOOTSTRAP_TOKEN,
    sharedPushoverAppToken: env.PUSHOVER_APP_TOKEN,
    binanceRelay: env.BINANCE_RELAY_URL && env.BINANCE_RELAY_TOKEN
      ? Object.freeze({url:env.BINANCE_RELAY_URL,token:env.BINANCE_RELAY_TOKEN,
          ...(env.BINANCE_RELAY_BYPASS ? {bypass:env.BINANCE_RELAY_BYPASS} : {})}) : null,
    port: env.PORT,
    secureCookies: new URL(env.APP_URL).protocol === 'https:',
    limits: Object.freeze({
      users: env.MAX_USERS,
      alertsPerUser: env.MAX_ALERTS_PER_USER,
      instrumentsPerUser: env.MAX_INSTRUMENTS_PER_USER,
      activeAlerts: env.MAX_ACTIVE_ALERTS,
      globalInstruments: env.MAX_GLOBAL_INSTRUMENTS,
      dailyNotificationAttempts: env.DAILY_NOTIFICATION_LIMIT,
      globalNotificationAttempts: env.GLOBAL_DAILY_NOTIFICATION_LIMIT,
    }),
    runtime: RUNTIME_POLICY,
  });
}

export type AppConfig = ReturnType<typeof loadConfig>;
