import type { BetterAuthOptions } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { APIError } from 'better-auth/api';
import { normalizeEmail } from './email.js';
import type { AppConfig } from '../config.js';

/** Shared with the pinned CLI generator: do not add plugins without regenerating both dialects. */
export function authOptions(config: AppConfig, sendVerificationOTP: Parameters<typeof emailOTP>[0]['sendVerificationOTP']) {
  return {
    appName: 'Open Alert',
    baseURL: config.appUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [...config.trustedOrigins],
    emailAndPassword: { enabled: false },
    socialProviders: config.google ? { google: {
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      prompt: 'select_account',
      mapProfileToUser(profile) {
        if (profile.email_verified !== true) throw new APIError('FORBIDDEN', { code: 'VERIFIED_EMAIL_REQUIRED', message: 'Verified Google email required' });
        return { email: normalizeEmail(profile.email), emailVerified: true };
      },
    } } : {},
    user: {
      additionalFields: { role: { type: ['user', 'admin'], required: true, defaultValue: 'user', input: false } },
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    account: { accountLinking: {
      enabled: true,
      // A verified Google identity may sign in to an existing verified same-email user.
      disableImplicitLinking: false,
      trustedProviders: ['google'],
      requireLocalEmailVerified: true,
      allowDifferentEmails: false,
      allowUnlinkingAll: false,
    } },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    verification: { storeInDatabase: true },
    advanced: {
      useSecureCookies: config.secureCookies,
      defaultCookieAttributes: { httpOnly: true, secure: config.secureCookies, sameSite: 'lax' },
      ipAddress: { ipAddressHeaders: ['x-open-alert-client-ip'] },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      // Native pruning must retain our email-hour counters in the same generated table.
      window: 3_600,
      max: 60,
      customRules: {
        '/email-otp/send-verification-otp': { window: 60, max: 5 },
        '/sign-in/email-otp': { window: 60, max: 10 },
        '*': { window: 60, max: 60 },
      },
    },
    plugins: [{
      // The pinned library's default helper catches send failures. This tiny schema-free
      // policy plugin awaits and propagates them through the native endpoint protocol.
      id: 'open-alert-awaited-delivery',
      init() { return { context: { async runInBackgroundOrAwait(promise: void | Promise<unknown>) { await promise; } } }; },
    }, emailOTP({
      expiresIn: 300,
      otpLength: 6,
      allowedAttempts: 5,
      storeOTP: 'hashed',
      disableSignUp: false,
      sendVerificationOnSignUp: false,
      changeEmail: { enabled: false },
      sendVerificationOTP,
    })],
    // Never log raw adapter/provider errors, tokens, auth request bodies or config.
    logger: { disabled: true },
  } satisfies BetterAuthOptions;
}
