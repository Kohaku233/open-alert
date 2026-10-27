import type { MarketQuote } from '../src/markets/quotes.js';
import type { RealtimeClientFrame, RealtimeServerFrame } from '../src/runtime/realtime.js';

/** One shared socket per tab. Consumers subscribe by instrument and fall back to
 * HTTP polling whenever `connected` is false (Cloudflare runtime, outage, proxy). */
type QuoteListener = (event: { quote?: MarketQuote; error?: 'invalid_request' | 'service_unavailable' }) => void;
const quoteListeners = new Map<string, Set<QuoteListener>>();
const changeListeners = new Set<() => void>();
const stateListeners = new Set<(connected: boolean) => void>();
let socket: WebSocket | null = null, connected = false, failures = 0, retry: number | undefined;
// After repeated handshake failures (e.g. no WS endpoint) stop trying for a while.
let disabledUntil = 0;

function setConnected(value: boolean) {
    if (connected === value) return;
    connected = value;
    for (const listener of [...stateListeners]) listener(value);
}
function send(frame: RealtimeClientFrame) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}
function wanted() { return quoteListeners.size > 0 || changeListeners.size > 0; }
function schedule() {
    if (retry !== undefined || !wanted()) return;
    const delay = Math.max(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)), disabledUntil - Date.now());
    retry = window.setTimeout(() => { retry = undefined; connect(); }, delay);
}
function connect() {
    if (socket || !wanted() || typeof WebSocket === 'undefined') return;
    if (Date.now() < disabledUntil) { schedule(); return; }
    const url = new URL('/api/live', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let opened = false;
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => { opened = true; };
    ws.onmessage = event => {
        let frame: RealtimeServerFrame;
        try { frame = JSON.parse(String(event.data)) as RealtimeServerFrame; } catch { return; }
        if (frame.type === 'ready') {
            failures = 0; setConnected(true);
            for (const instrument of quoteListeners.keys()) send({ type: 'subscribe', instrument });
        } else if (frame.type === 'quote') {
            for (const listener of [...quoteListeners.get(frame.quote.instrument) ?? []]) listener({ quote: frame.quote });
        } else if (frame.type === 'quote_error') {
            for (const listener of [...quoteListeners.get(frame.instrument) ?? []]) listener({ error: frame.code });
        } else if (frame.type === 'changed') {
            for (const listener of [...changeListeners]) listener();
        }
    };
    ws.onclose = () => {
        if (socket !== ws) return;
        socket = null; setConnected(false); failures++;
        if (!opened && failures >= 3) disabledUntil = Date.now() + 60_000;
        schedule();
    };
}
function release() {
    if (wanted()) return;
    if (retry !== undefined) { window.clearTimeout(retry); retry = undefined; }
    const ws = socket; socket = null; setConnected(false);
    ws?.close(1000);
}
export function isRealtimeConnected() { return connected; }
export function subscribeRealtimeState(listener: (connected: boolean) => void): () => void {
    stateListeners.add(listener);
    return () => { stateListeners.delete(listener); };
}
export function subscribeLiveQuote(instrument: string, listener: QuoteListener): () => void {
    let set = quoteListeners.get(instrument);
    const first = !set;
    if (!set) { set = new Set(); quoteListeners.set(instrument, set); }
    set.add(listener);
    if (first) send({ type: 'subscribe', instrument });
    connect();
    return () => {
        const current = quoteListeners.get(instrument);
        current?.delete(listener);
        if (current && !current.size) { quoteListeners.delete(instrument); send({ type: 'unsubscribe', instrument }); }
        release();
    };
}
export function subscribeAlertChanges(listener: () => void): () => void {
    changeListeners.add(listener);
    connect();
    return () => { changeListeners.delete(listener); release(); };
}
