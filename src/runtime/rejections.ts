import ccxt from 'ccxt';

// ccxt's throttled `watch` path calls `client.send()` without awaiting or catching it, so a socket that
// closes between subscribe and send surfaces as an unhandled rejection. Those are transient: the watch
// loops already back off and resubscribe. Anything else is a real bug and must still crash the process.
export function isTransientSocketRejection(reason: unknown): boolean {
  if (reason instanceof ccxt.NetworkError) return true;
  return reason instanceof Error && /^WebSocket is not open/.test(reason.message);
}

export function handleUnhandledRejection(reason: unknown, exit: (code: number) => void = code => process.exit(code)): 'ignored' | 'fatal' {
  if (isTransientSocketRejection(reason)) {
    const error = reason as Error;
    console.warn(JSON.stringify({ event: 'open_alert_ws_send_after_close', name: error.name, message: error.message.slice(0, 200) }));
    return 'ignored';
  }
  console.error('open_alert_unhandled_rejection', reason);
  exit(1);
  return 'fatal';
}
