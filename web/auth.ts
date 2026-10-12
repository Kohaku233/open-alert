import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';

const AUTH_TIMEOUT_MS = 15000;
// Better Fetch skips its timeout when a signal is supplied. Better Auth 1.7.7
// supplies one for session reads: combine cancellation with a separate deadline,
// leaving the SDK's original signal un-aborted so it reports a retryable error.
const authFetch: typeof fetch = async (input, init) => {
  if (!init?.signal) return fetch(input, init);
  const deadline = new AbortController();
  const timer = window.setTimeout(() => deadline.abort(), AUTH_TIMEOUT_MS);
  try { return await fetch(input, { ...init, signal: AbortSignal.any([init.signal, deadline.signal]) }); }
  finally { window.clearTimeout(timer); }
};
// Native Better Auth protocol, same-origin cookie sessions. No browser token storage.
export const authClient = createAuthClient({ plugins: [emailOTPClient()], fetchOptions: { timeout: AUTH_TIMEOUT_MS, customFetchImpl: authFetch } });
