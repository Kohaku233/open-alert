import { useEffect, useState } from 'react';
import type { MarketQuote } from '../src/markets/quotes.js';
import { request, errorText, AppError } from './api.js';
import { t } from './i18n.js';
import { isRealtimeConnected, subscribeLiveQuote, subscribeRealtimeState } from './realtime.js';

/** Viewing a quote never saves a rule or enables monitoring. Uses the realtime
 * socket when connected; HTTP polling every 5 s is the fallback transport. */
export function useMarketQuote(instrument: string, active: boolean) {
  const [state, setState] = useState<{ quote?: MarketQuote; error: string; instrument: string }>({ error: '', instrument: '' });
  useEffect(() => {
    if (!active || !instrument) return;
    let disposed = false, pending = false, lastAttempt = -Infinity;
    const controller = new AbortController();
    const accept = (quote: MarketQuote) => {
      if (quote.instrument !== instrument || !Number.isFinite(quote.price) || quote.price <= 0 ||
          !Number.isSafeInteger(quote.observedAt) || Date.now() - quote.observedAt > 30000 || quote.observedAt > Date.now() + 5000) throw new Error('invalid_quote');
      if (!disposed) setState({ instrument, quote, error: '' });
    };
    const fail = (error: unknown) => {
      if (!disposed) setState(previous => ({ instrument, ...(previous.instrument === instrument && previous.quote ? { quote: previous.quote } : {}), error: errorText(error) }));
    };
    async function refresh() {
      if (disposed || pending || isRealtimeConnected() || document.visibilityState === 'hidden' || Date.now() - lastAttempt < 5000) return;
      pending = true; lastAttempt = Date.now();
      try {
        accept(await request<MarketQuote>(`/api/quote?instrument=${encodeURIComponent(instrument)}`, 'GET', undefined, { signal: controller.signal }));
      } catch (error) { fail(error); } finally { pending = false; }
    }
    const unsubscribe = subscribeLiveQuote(instrument, event => {
      if (event.quote) { try { accept(event.quote); } catch (error) { fail(error); } }
      else if (event.error) fail(new AppError(event.error, t('报价暂时不可用'), event.error === 'invalid_request' ? 400 : 503));
    });
    // Losing the socket resumes polling at once; regaining it stops polling.
    const unwatch = subscribeRealtimeState(live => { if (!live) { lastAttempt = -Infinity; void refresh(); } });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const visible = () => void refresh();
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; controller.abort(); unsubscribe(); unwatch(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [instrument, active]);
  return state.instrument === instrument ? state : { error: '', instrument };
}
