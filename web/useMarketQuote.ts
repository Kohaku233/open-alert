import { useEffect, useState } from 'react';
import type { MarketQuote } from '../src/markets/quotes.js';
import { request, errorText } from './api.js';

/** Viewing a quote never saves a rule or enables monitoring. */
export function useMarketQuote(instrument: string, active: boolean) {
  const [state, setState] = useState<{ quote?: MarketQuote; error: string; instrument: string }>({ error: '', instrument: '' });
  useEffect(() => {
    if (!active || !instrument) return;
    let disposed = false, pending = false, lastAttempt = -Infinity;
    const controller = new AbortController();
    async function refresh() {
      if (disposed || pending || document.visibilityState === 'hidden' || Date.now() - lastAttempt < 5000) return;
      pending = true; lastAttempt = Date.now();
      try {
        const quote = await request<MarketQuote>(`/api/quote?instrument=${encodeURIComponent(instrument)}`, 'GET', undefined, { signal: controller.signal });
        if (quote.instrument !== instrument || !Number.isFinite(quote.price) || quote.price <= 0 ||
            !Number.isSafeInteger(quote.observedAt) || Date.now() - quote.observedAt > 30000 || quote.observedAt > Date.now() + 5000) throw new Error('invalid_quote');
        if (!disposed) setState({ instrument, quote, error: '' });
      } catch (error) {
        if (!disposed) setState(previous => ({ instrument, ...(previous.instrument === instrument && previous.quote ? { quote: previous.quote } : {}), error: errorText(error) }));
      } finally { pending = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const visible = () => void refresh();
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [instrument, active]);
  return state.instrument === instrument ? state : { error: '', instrument };
}
