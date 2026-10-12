import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import type { AppConfig } from '../config.js';
import type { AuthService, SessionPrincipal } from '../contracts/api.js';
import type { SqlDatabase } from '../contracts/db.js';
import { authOptions } from './options.js';
import * as sqliteSchema from './schema.sqlite.js';
import { createEmailTransport, EmailDeliveryError, normalizeEmail } from './email.js';
import type { EmailHealth, EmailTransport } from './email.js';
import { consumeAuthLimit, privateLimitKey } from './limits.js';

type ValidateUserInfo = NonNullable<NonNullable<import('better-auth').BetterAuthOptions['user']>['validateUserInfo']>;
type AuthOptions = ReturnType<typeof authOptions> & { user: { validateUserInfo: ValidateUserInfo } };
function instantiateBetterAuth(config: AppConfig, db: SqlDatabase, authDrizzle: Parameters<typeof drizzleAdapter>[0], opts: AuthOptions, hooks: NonNullable<import('better-auth').BetterAuthOptions['hooks']>, databaseHooks: NonNullable<import('better-auth').BetterAuthOptions['databaseHooks']>, schema: Record<string, unknown>) {
  return betterAuth({ ...opts, disabledPaths: blockedPaths, database: drizzleAdapter(authDrizzle, { provider: db.driver === 'postgres' ? 'pg' : 'sqlite', schema, transaction: db.driver === 'postgres' }), hooks, databaseHooks });
}
export type BetterAuthInstance = ReturnType<typeof instantiateBetterAuth>;
export interface AuthCapabilities { google: boolean; emailOtp: boolean; registration: 'invite' | 'open' | 'closed'; inviteOnly: boolean; emailProvider: 'console' | 'smtp' | 'resend'; emailSenderMode: AppConfig['email']['senderMode'] }
export interface OpenAlertAuth extends AuthService {
  auth: BetterAuthInstance;
  capabilities(): AuthCapabilities;
  emailHealth(): EmailHealth;
  sendInvitation(email: string): Promise<void>;
  close(): void;
}
export class DisabledAccountError extends Error { constructor() { super('Account disabled'); this.name = 'DisabledAccountError'; } }
export interface AuthFactoryOptions {
  /** Dialect schema supplied by platform; SQLite/D1 default remains portable. */
  authSchema?: Record<string, unknown>;
  /** Platform-owned transport factory. Never sourced from a request. */
  emailTransportFactory?: (config: AppConfig) => Promise<EmailTransport>;
  /** Captures real generated OTP delivery in tests; never available in production/development. */
  testEmailTransport?: EmailTransport;
  /** Workers require the operator-applied policy instead of writing it on cold startup. */
  registrationPolicy?: 'initialize' | 'require';
}
const blockedPaths = [
  '/sign-up/email', '/sign-in/email', '/change-password', '/set-password', '/request-password-reset', '/reset-password',
  '/send-verification-email', '/verify-email', '/change-email', '/delete-user', '/delete-user/callback',
  '/email-otp/create-verification-otp', '/email-otp/get-verification-otp', '/email-otp/check-verification-otp',
  '/email-otp/verify-email', '/email-otp/request-password-reset', '/email-otp/reset-password', '/forget-password/email-otp',
  '/email-otp/request-email-change', '/email-otp/change-email',
];
function forbidden(code: string): never { throw new APIError('FORBIDDEN', { code, message: 'Sign-in is not permitted' }); }

/** authDrizzle is constructed by the platform adapter from the SAME physical DB as db. */
export async function createAuth(config: AppConfig, db: SqlDatabase, authDrizzle: Parameters<typeof drizzleAdapter>[0], options: AuthFactoryOptions = {}): Promise<OpenAlertAuth> {
  if (db.driver !== config.dbDriver) throw new Error('Auth database driver mismatch');
  if (db.driver === 'postgres' && !options.authSchema) throw new Error('PostgreSQL auth requires its platform schema');
  if (options.testEmailTransport && config.environment !== 'test') throw new EmailDeliveryError('email_configuration');
  const transport = options.testEmailTransport ?? await (options.emailTransportFactory ?? createEmailTransport)(config);
  const health: EmailHealth = { state: 'unhealthy', code: 'email_starting', lastSuccessAt: null };
  try { await transport.verify(); health.state = 'healthy'; health.code = null; }
  catch { transport.close?.(); throw new EmailDeliveryError('email_unavailable'); }
  const send = async (to: string, subject: string, text: string) => {
    try {
      await transport.send({ to: normalizeEmail(to), subject, text });
      health.state = 'healthy'; health.code = null; health.lastSuccessAt = Date.now();
    } catch (error) {
      health.state = 'unhealthy'; health.code = error instanceof EmailDeliveryError ? error.code : 'email_unavailable';
      throw new APIError('SERVICE_UNAVAILABLE', { code: health.code, message: 'Email delivery is unavailable. Please try again later.' });
    }
  };
  try {
    // Policy must exist before any user insertion; triggers fail closed without it.
    if (options.registrationPolicy === 'require') {
      const policy = await db.query<{ max_users: number; invite_only: number }>("SELECT max_users,invite_only FROM auth_registration_policy WHERE id='registration'");
      if (policy.length !== 1 || policy[0]!.max_users !== config.limits.users || policy[0]!.invite_only !== Number(config.inviteOnly)) throw new Error('Registration policy requires an operator migration');
    } else {
      await db.execute(db.driver === 'postgres'
        ? `INSERT INTO auth_registration_policy (id, max_users, invite_only, user_count)
            VALUES ('registration', ?, ?, (SELECT COUNT(*) FROM "user"))
            ON CONFLICT (id) DO UPDATE SET max_users=excluded.max_users, invite_only=excluded.invite_only`
        : `INSERT INTO auth_registration_policy (id, max_users, invite_only) VALUES ('registration', ?, ?)
            ON CONFLICT (id) DO UPDATE SET max_users=excluded.max_users, invite_only=excluded.invite_only`,
        [config.limits.users, config.inviteOnly ? 1 : 0]);
    }
    const disabled = async (id: string): Promise<boolean> => {
      const rows = await db.query<{ disabled: number }>('SELECT disabled FROM user_settings WHERE user_id=?', [id]);
      return rows[0]?.disabled === 1;
    };
    const limit = async (prefix: string, value: string, max: number, windowMs: number) => {
      const result = await consumeAuthLimit(db, await privateLimitKey(prefix, value, config.authSecret), max, windowMs);
      if (!result.allowed) throw new APIError('TOO_MANY_REQUESTS', { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' }, { 'Retry-After': String(result.retryAfter), 'X-Retry-After': String(result.retryAfter) });
    };
    const baseOptions = authOptions(config, async ({ email, otp, type }) => {
      if (type !== 'sign-in') forbidden('OTP_TYPE_DISABLED');
      await send(email, 'Your Open Alert sign-in code', `Your Open Alert sign-in code is ${otp}. It expires in 5 minutes. If you did not request it, ignore this message.`);
    });
    const validateUserInfo: ValidateUserInfo = async ({ user, source }) => {
      if (source.method !== 'oauth') return;
      // Trusted providers skip the library's verification check; require fresh Google claims.
      if (source.oauth?.providerId !== 'google' || source.oauth.profile?.email_verified !== true) return { error: 'VERIFIED_EMAIL_REQUIRED' };
      if (source.action === 'create-user') return;
      if (!user.id) return { error: 'VERIFIED_EMAIL_REQUIRED' };
      const local = (await db.query<{ email: string; email_verified: number }>('SELECT email,email_verified FROM "user" WHERE id=?', [user.id]))[0];
      if (!local?.email_verified) return { error: 'VERIFIED_EMAIL_REQUIRED' };
      if (!user.email || normalizeEmail(user.email) !== local.email) return { error: 'email_does_not_match' };
      if (await disabled(user.id)) return { error: 'ACCOUNT_DISABLED' };
    };
    const opts = { ...baseOptions, user: { ...baseOptions.user, validateUserInfo } };
    const auth: BetterAuthInstance = instantiateBetterAuth(config, db, authDrizzle, opts,
      { before: createAuthMiddleware(async ctx => {
        if (blockedPaths.includes(ctx.path)) throw new APIError('NOT_FOUND', { message: 'Not found' });
        if (ctx.path.startsWith('/email-otp/') || ctx.path === '/sign-in/email-otp') {
          if (ctx.body && typeof ctx.body.email === 'string') {
            try { ctx.body.email = normalizeEmail(ctx.body.email); }
            catch { throw new APIError('BAD_REQUEST', { code: 'INVALID_EMAIL', message: 'Invalid email address' }); }
          }
          if (ctx.path === '/email-otp/send-verification-otp') {
            if (ctx.body?.type !== 'sign-in') forbidden('OTP_TYPE_DISABLED');
            const email = ctx.body.email as string;
            await limit('email-cooldown', email, 1, 60_000);
            await limit('email-hour', email, 10, 3_600_000);
            const existing = await db.query<{ id: string }>('SELECT id FROM "user" WHERE email=?', [email]);
            if (existing[0] && await disabled(existing[0].id)) forbidden('ACCOUNT_DISABLED');
            if (!existing[0] && config.inviteOnly) {
              const invite = await db.query('SELECT id FROM invitations WHERE email=? AND consumed_by IS NULL AND expires_at>?', [email, Date.now()]);
              if (!invite[0]) forbidden('INVITATION_REQUIRED');
            }
          }
          if (ctx.path === '/sign-in/email-otp' && typeof ctx.body?.email === 'string') await limit('email-attempts', ctx.body.email, 10, 60_000);
        }
        // Signed-in account binding requires a verified, enabled local session.
        if (ctx.path === '/link-social') {
          const session = await auth.api.getSession({ headers: ctx.headers ?? new Headers() });
          if (!session || !session.user.emailVerified) forbidden('VERIFIED_SESSION_REQUIRED');
          if (await disabled(session.user.id)) forbidden('ACCOUNT_DISABLED');
        }
      }) },
      {
        user: { create: { before: async user => {
          const email = normalizeEmail(user.email);
          if (!user.emailVerified) forbidden('VERIFIED_EMAIL_REQUIRED');
          const count = await db.query<{ count: number }>('SELECT COUNT(*) AS count FROM "user"');
          if ((count[0]?.count ?? 0) >= config.limits.users) forbidden('USER_LIMIT_REACHED');
          if (config.inviteOnly) {
            const invitations = await db.query('SELECT id FROM invitations WHERE email=? AND consumed_by IS NULL AND expires_at>?', [email, Date.now()]);
            if (!invitations[0]) forbidden('INVITATION_REQUIRED');
          }
          // Hook gives friendly failures. The SQL trigger is the authoritative atomic guard.
          return { data: { ...user, email, role: 'user' } };
        } } },
        account: { create: { before: async account => {
          if (await disabled(account.userId)) forbidden('ACCOUNT_DISABLED');
          return { data: account };
        } } },
        session: { create: { before: async session => {
          if (await disabled(session.userId)) forbidden('ACCOUNT_DISABLED');
          return { data: session };
        } } },
      },
      options.authSchema ?? sqliteSchema,
    );
    const service: OpenAlertAuth = {
      auth,
      async handler(request) {
        const path = new URL(request.url).pathname.slice('/api/auth'.length);
        if (request.method !== 'GET' && (!config.trustedOrigins.includes(request.headers.get('origin') ?? '') || request.headers.get('sec-fetch-site') === 'cross-site')) {
          return Response.json({ code: 'INVALID_ORIGIN', message: 'Invalid origin' }, { status: 403 });
        }
        if (request.headers.has('cookie') && path !== '/sign-out') {
          try {
            const session = await auth.api.getSession({ headers: request.headers });
            if (session && await disabled(session.user.id)) return Response.json({ code: 'ACCOUNT_DISABLED', message: 'Account disabled' }, { status: 403 });
          } catch { return Response.json({ code: 'AUTH_UNAVAILABLE', message: 'Authentication is unavailable' }, { status: 503 }); }
        }
        // Native limiter persists per-path IP counts; this also caps IP/global volume across endpoints.
        if (request.method !== 'GET') {
          try {
            await limit('global', 'all', 1_000, 60_000);
            await limit('ip-global', request.headers.get('x-open-alert-client-ip') ?? 'unknown', 60, 60_000);
          } catch (error) {
            if (error instanceof APIError) return Response.json(error.body, { status: error.statusCode, headers: error.headers });
            return Response.json({ code: 'AUTH_UNAVAILABLE', message: 'Authentication is unavailable' }, { status: 503 });
          }
        }
        try {
          const response = await auth.handler(request);
          if (response.status === 429 && !response.headers.has('Retry-After')) response.headers.set('Retry-After', response.headers.get('X-Retry-After') ?? '60');
          return response;
        } catch { return Response.json({ code: 'AUTH_UNAVAILABLE', message: 'Authentication is unavailable' }, { status: 503 }); }
      },
      async getPrincipal(request): Promise<SessionPrincipal | null> {
        const result = await auth.api.getSession({ headers: request.headers });
        if (!result || !result.user.emailVerified) return null;
        if (await disabled(result.user.id)) throw new DisabledAccountError();
        const role = (result.user as typeof result.user & { role?: string }).role;
        if (role !== 'user' && role !== 'admin') return null;
        return { userId: result.user.id, sessionId: result.session.id, role };
      },
      capabilities: () => ({ google: Boolean(config.google), emailOtp: health.state === 'healthy', registration: config.inviteOnly ? 'invite' : 'open', inviteOnly: config.inviteOnly, emailProvider: config.email.provider, emailSenderMode: config.email.senderMode }),
      emailHealth: () => ({ ...health }),
      async sendInvitation(email) {
        await send(email, 'You are invited to Open Alert', `You have been invited to Open Alert. Visit ${config.appUrl} and sign in with this email address using Google or an email code. Your administrator can tell you when the invitation expires.`);
      },
      close() { transport.close?.(); },
    };
    await auth.$context;
    return service;
  } catch (error) {
    transport.close?.();
    throw error;
  }
}
