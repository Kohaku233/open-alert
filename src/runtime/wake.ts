/** Retry only the idempotent wake, never the already-committed user mutation. */
export async function wakeWithRetry(wake: (signal: AbortSignal) => Promise<void>, options: {
  attempts?: number; timeoutMs?: number; retryMs?: number;
} = {}): Promise<boolean> {
  const attempts = options.attempts ?? 3, timeoutMs = options.timeoutMs ?? 1500, retryMs = options.retryMs ?? 100;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => wake(controller.signal)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('scheduler_wake_timeout')); }, timeoutMs); }),
      ]);
      return true;
    } catch {
      if (attempt + 1 < attempts && retryMs > 0) await new Promise(resolve => setTimeout(resolve, retryMs * (attempt + 1)));
    } finally { clearTimeout(timer); }
  }
  return false;
}
