/* OKX account state for trade mode: unlock, permission checks, polling and order actions.
   Writes that may have reached OKX are reconciled by client order id and never resent. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppError, errorText, request } from '../api.js';
import { t } from '../i18n.js';
import type { OkxCredentials, OkxInstrument } from './okx.js';
import { OkxError, OkxUncertainError, baseFor, clientOrderId, contractsFor, okxCall, parseInstrument, roundTo } from './okx.js';
import { forgetVault, saveVault, unlockVault, vaultSummary } from './vault.js';
import type { VaultSummary } from './vault.js';

export type TradeSide = 'buy' | 'sell';
export type TradeKind = 'limit' | 'market' | 'trigger';
export type TradeStatus = 'empty' | 'locked' | 'connecting' | 'ready';
export interface TradeOrder {
  id: string; algo: boolean; instId: string; clOrdId: string; side: TradeSide; posSide: string; kind: TradeKind;
  price: number; contracts: number; qty: number; filled: number; reduceOnly: boolean; status: 'open' | 'sending' | 'uncertain'; createdAt: number;
  /** Take-profit / stop-loss attached to a resting order; they become a TP/SL order once it fills. */
  tp: number | null; sl: number | null;
}
/** A resting TP/SL (OKX conditional or oco algo). full = closes the whole position (closeFraction 1). */
export interface TradeProtect { id: string; instId: string; posSide: string; side: TradeSide; ordType: 'conditional' | 'oco'; contracts: number; qty: number; full: boolean; tp: number | null; sl: number | null }
export interface ProtectInput { tp: number | null; sl: number | null }
export interface TradePosition { instId: string; side: 'long' | 'short'; posSide: string; contracts: number; qty: number; entry: number; mark: number; liq: number | null; upnl: number; uplRatio: number; lever: number; mgnMode: string }
export interface TradeFill { id: string; instId: string; side: TradeSide; qty: number; price: number; fee: number; liquidity: 'maker' | 'taker'; pnl: number; at: number }
export interface TradeAccount { equity: number; available: number; upnl: number; positions: TradePosition[]; orders: TradeOrder[]; protects: TradeProtect[]; fills: TradeFill[]; updatedAt: number }
export interface TradeConfig { posMode: 'net_mode' | 'long_short_mode'; acctLv: string; uid: string; label: string }
export interface PlaceInput { instId: string; side: TradeSide; kind: TradeKind; price?: number; qty: number; reduceOnly: boolean; tp?: number | null; sl?: number | null }
export type PlaceResult = { state: 'placed' | 'uncertain'; label: string } | { state: 'rejected'; message: string };

const POLL_MS = 4000;
// OKX refuses a request whose timestamp is older than 30s; after this a lost write can no longer execute.
const EXPIRY_MS = 35_000;
const AUTH_CODES = new Set(['50101', '50103', '50104', '50105', '50111', '50113', '50119']);
type Raw = Record<string, string>;
const num = (value: string | undefined) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const priceOrNull = (value: string | undefined) => { const n = num(value); return n > 0 ? n : null; };
/** OKX TP/SL legs; '-1' executes at market once triggered. Amend calls use the newTp… / newSl… names. */
const legs = (input: ProtectInput, tick: string, amend = false) => {
  const name = (leg: 'tp' | 'sl', field: string) => amend ? `new${leg === 'tp' ? 'Tp' : 'Sl'}${field}` : `${leg}${field}`;
  const out: Record<string, string> = {};
  for (const leg of ['tp', 'sl'] as const) {
    const price = input[leg];
    if (!price) continue;
    out[name(leg, 'TriggerPx')] = roundTo(price, tick); out[name(leg, 'OrdPx')] = '-1'; out[name(leg, 'TriggerPxType')] = 'last';
  }
  return out;
};

export function useOkxAccount({ enabled, instId, notify }: { enabled: boolean; instId: string | null; notify: (text: string) => void }) {
  const [vault, setVault] = useState<VaultSummary | null>(vaultSummary);
  const [status, setStatus] = useState<TradeStatus>(() => vaultSummary() ? 'locked' : 'empty');
  const [relay, setRelay] = useState<{ state: 'checking' | 'available' | 'unavailable'; egress: string | null }>({ state: 'checking', egress: null });
  const [config, setConfig] = useState<TradeConfig | null>(null);
  const [account, setAccount] = useState<TradeAccount | null>(null);
  const [pollError, setPollError] = useState('');
  const [local, setLocal] = useState<TradeOrder[]>([]);
  const [leverage, setLeverage] = useState<Record<string, number>>({});
  const [, setInstrumentsVersion] = useState(0);
  const creds = useRef<OkxCredentials | null>(null);
  const instruments = useRef(new Map<string, OkxInstrument>());
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const localRef = useRef(local);
  localRef.current = local;
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    if (!enabled || relay.state !== 'checking') return;
    const controller = new AbortController();
    request<{ available: boolean; egress: string | null }>('/api/trade/okx', 'GET', undefined, { signal: controller.signal })
      .then(value => setRelay({ state: value.available ? 'available' : 'unavailable', egress: value.egress }))
      .catch(() => { if (!controller.signal.aborted) setRelay({ state: 'unavailable', egress: null }); });
    return () => controller.abort();
  }, [enabled, relay.state]);

  const call = useCallback(<T = Raw>(method: 'GET' | 'POST', path: string, params?: Parameters<typeof okxCall>[3]) => {
    if (!creds.current) return Promise.reject(new OkxError('locked', t('交易密钥已锁定，请先在本机解锁。')));
    return okxCall<T>(creds.current, method, path, params);
  }, []);

  const lock = useCallback((reason?: string) => {
    creds.current = null;
    setAccount(null); setConfig(null); setLocal(list => list.filter(order => order.status === 'uncertain'));
    setStatus(vaultSummary() ? 'locked' : 'empty');
    if (reason) notifyRef.current(reason);
  }, []);

  async function loadInstruments(using: OkxCredentials) {
    if (instruments.current.size) return;
    const list = await okxCall(using, 'GET', 'public/instruments', { instType: 'SWAP' });
    for (const raw of list) { const inst = parseInstrument(raw); if (inst) instruments.current.set(inst.instId, inst); }
    setInstrumentsVersion(value => value + 1);
  }
  /** Verifies a key before it is used or saved: readable account, trade rights, no withdrawal right. */
  async function verify(using: OkxCredentials): Promise<TradeConfig> {
    const [raw] = await okxCall(using, 'GET', 'account/config');
    if (!raw) throw new OkxError('invalid_response', t('交易所没有返回账户配置。'));
    const perms = (raw.perm ?? '').split(',').map(part => part.trim());
    if (perms.includes('withdraw')) throw new OkxError('withdraw_permission', t('这个 API Key 带有提现权限，已拒绝使用。请在 OKX 新建只有「读取」和「交易」权限的 Key。'));
    if (!perms.includes('trade')) throw new OkxError('50120', t('API Key 没有交易权限。'));
    // acctLv 1 is OKX "simple" mode, which cannot hold perpetual positions.
    if (raw.acctLv === '1') throw new OkxError('account_mode', t('OKX 账户处于简单交易模式，无法交易永续合约。请先在 OKX 切换到合约模式。'));
    await loadInstruments(using);
    return { posMode: raw.posMode === 'long_short_mode' ? 'long_short_mode' : 'net_mode', acctLv: raw.acctLv ?? '', uid: raw.uid ?? '', label: raw.label ?? '' };
  }
  const describe = (error: unknown) => error instanceof OkxError || error instanceof OkxUncertainError ? error.message : errorText(error);

  async function connect(using: OkxCredentials, persist?: () => Promise<void>) {
    setStatus('connecting');
    try {
      const next = await verify(using);
      // A new key is stored only after OKX accepted it, and trading starts only once it is stored.
      if (persist) await persist();
      creds.current = using; setConfig(next); setStatus('ready'); setPollError('');
    } catch (error) {
      setStatus(vaultSummary() ? 'locked' : 'empty');
      throw new Error(describe(error));
    }
  }
  const unlock = async (password: string) => {
    let using: OkxCredentials;
    try { using = await unlockVault(password); } catch { throw new Error(t('本机口令不正确。')); }
    await connect(using);
  };
  const save = async (input: OkxCredentials, password: string) => {
    await connect(input, async () => { await saveVault(input, password); setVault(vaultSummary()); });
  };
  const forget = () => { lock(); forgetVault(); setVault(null); setStatus('empty'); };

  const toOrder = (raw: Raw & { attachAlgoOrds?: Raw[] }, algo: boolean): TradeOrder | null => {
    const inst = instruments.current.get(raw.instId ?? '');
    if (!inst) return null;
    const contracts = num(raw.sz);
    const attached = raw.attachAlgoOrds?.[0];
    return {
      id: (algo ? raw.algoId : raw.ordId) ?? '', algo, instId: inst.instId, clOrdId: (algo ? raw.algoClOrdId : raw.clOrdId) ?? '',
      side: raw.side === 'sell' ? 'sell' : 'buy', posSide: raw.posSide ?? 'net',
      kind: algo ? 'trigger' : raw.ordType === 'market' ? 'market' : 'limit',
      price: num(algo ? raw.triggerPx : raw.px), contracts, qty: baseFor(contracts, inst), filled: baseFor(num(raw.accFillSz), inst),
      reduceOnly: raw.reduceOnly === 'true', status: 'open', createdAt: num(raw.cTime),
      tp: priceOrNull(attached?.tpTriggerPx), sl: priceOrNull(attached?.slTriggerPx),
    };
  };
  const toProtect = (raw: Raw, ordType: TradeProtect['ordType']): TradeProtect | null => {
    const inst = instruments.current.get(raw.instId ?? '');
    if (!inst || !raw.algoId) return null;
    const contracts = num(raw.sz);
    return { id: raw.algoId, instId: inst.instId, posSide: raw.posSide || 'net', side: raw.side === 'buy' ? 'buy' : 'sell', ordType, contracts, qty: baseFor(contracts, inst),
      full: raw.closeFraction === '1', tp: priceOrNull(raw.tpTriggerPx), sl: priceOrNull(raw.slTriggerPx) };
  };
  const refreshing = useRef(false);
  const ticks = useRef(0);
  const refresh = useCallback(async () => {
    if (!creds.current || refreshing.current) return;
    refreshing.current = true;
    try {
      const withFills = ticks.current++ % 3 === 0;
      const [balance, positions, pending, algos, conditional, oco, fills] = await Promise.all([
        call('GET', 'account/balance', { ccy: 'USDT' }),
        call('GET', 'account/positions', { instType: 'SWAP' }),
        call('GET', 'trade/orders-pending', { instType: 'SWAP' }),
        call('GET', 'trade/orders-algo-pending', { ordType: 'trigger', instType: 'SWAP' }),
        // TP/SL orders: one-way stops and one-cancels-the-other pairs.
        call('GET', 'trade/orders-algo-pending', { ordType: 'conditional', instType: 'SWAP' }),
        call('GET', 'trade/orders-algo-pending', { ordType: 'oco', instType: 'SWAP' }),
        withFills ? call('GET', 'trade/fills', { instType: 'SWAP', limit: 30 }) : Promise.resolve(null),
      ]);
      if (!creds.current) return;
      const total = balance[0] as (Raw & { details?: Raw[] }) | undefined;
      const usdt = total?.details?.find(item => item.ccy === 'USDT');
      const openPositions = positions.flatMap((raw): TradePosition[] => {
        const inst = instruments.current.get(raw.instId ?? ''), pos = num(raw.pos);
        if (!inst || !pos) return [];
        const side = raw.posSide === 'short' || (raw.posSide !== 'long' && pos < 0) ? 'short' : 'long';
        const contracts = Math.abs(pos), liq = num(raw.liqPx);
        return [{ instId: inst.instId, side, posSide: raw.posSide ?? 'net', contracts, qty: baseFor(contracts, inst), entry: num(raw.avgPx), mark: num(raw.markPx), liq: liq > 0 ? liq : null,
          upnl: num(raw.upl), uplRatio: num(raw.uplRatio) * 100, lever: num(raw.lever), mgnMode: raw.mgnMode ?? 'cross' }];
      });
      const orders = [...pending.map(raw => toOrder(raw, false)), ...algos.map(raw => toOrder(raw, true))].filter((order): order is TradeOrder => !!order);
      const known = new Set(orders.map(order => order.clOrdId).filter(Boolean));
      // A sending or uncertain order leaves the local list once OKX reports it.
      const resolved = localRef.current.filter(order => known.has(order.clOrdId));
      if (resolved.length) {
        setLocal(list => list.filter(order => !known.has(order.clOrdId)));
        for (const order of resolved) if (order.status === 'uncertain') notifyRef.current(t('核对完成：订单 {0} 已在交易所生效，没有重复发送。', order.clOrdId));
      }
      setAccount(previous => ({
        equity: num(total?.totalEq), available: num(usdt?.availEq || usdt?.availBal), upnl: openPositions.reduce((sum, p) => sum + p.upnl, 0),
        positions: openPositions, orders,
        protects: [...conditional.map(raw => toProtect(raw, 'conditional')), ...oco.map(raw => toProtect(raw, 'oco'))].filter((item): item is TradeProtect => !!item),
        fills: fills ? fills.flatMap((raw): TradeFill[] => {
          const inst = instruments.current.get(raw.instId ?? '');
          return inst ? [{ id: raw.tradeId ?? raw.billId ?? `${raw.ordId}-${raw.ts}`, instId: inst.instId, side: raw.side === 'sell' ? 'sell' : 'buy', qty: baseFor(num(raw.fillSz), inst), price: num(raw.fillPx),
            fee: num(raw.fee), liquidity: raw.execType === 'M' ? 'maker' : 'taker', pnl: num(raw.fillPnl), at: num(raw.ts) }] : [];
        }) : previous?.fills ?? [],
        updatedAt: Date.now(),
      }));
      setPollError('');
    } catch (error) {
      if (error instanceof OkxError && AUTH_CODES.has(error.code)) lock(t('交易所拒绝了这个 API Key：{0} 已锁定交易。', error.message));
      else setPollError(describe(error));
    } finally { refreshing.current = false; }
  }, [call, lock]);

  useEffect(() => {
    if (!enabled || status !== 'ready') return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, status, refresh]);

  useEffect(() => {
    if (status !== 'ready' || !instId || leverage[instId] !== undefined) return;
    call('GET', 'account/leverage-info', { instId, mgnMode: 'cross' })
      .then(list => { const lever = num(list.find(item => !item.posSide || item.posSide === 'net' || item.posSide === 'long')?.lever); setLeverage(map => ({ ...map, [instId]: lever })); })
      .catch(() => {});
  }, [status, instId, leverage, call]);

  // Reconcile writes whose result is unknown. Found => it exists on OKX. Absent past expiry => it never executed.
  useEffect(() => {
    const waiting = local.filter(order => order.status === 'uncertain');
    if (!waiting.length || status !== 'ready') return;
    let running = false;
    const timer = window.setInterval(async () => {
      if (running) return;
      running = true;
      for (const order of waiting) {
        try {
          const found = order.algo ? await call('GET', 'trade/order-algo', { algoClOrdId: order.clOrdId }) : await call('GET', 'trade/order', { instId: order.instId, clOrdId: order.clOrdId });
          if (found.length) {
            setLocal(list => list.filter(item => item.clOrdId !== order.clOrdId));
            notifyRef.current(t('核对完成：订单 {0} 已在交易所生效，没有重复发送。', order.clOrdId));
            void refresh();
          }
        } catch (error) {
          const missing = error instanceof OkxError && (error.code === '51603' || error.code === '51000' || error.code === '51001');
          if (missing && Date.now() - order.createdAt > EXPIRY_MS) {
            setLocal(list => list.filter(item => item.clOrdId !== order.clOrdId));
            notifyRef.current(t('核对完成：订单 {0} 没有到达交易所，可以重新下单。', order.clOrdId));
          }
        }
      }
      running = false;
    }, 3000);
    return () => window.clearInterval(timer);
  }, [local, status, call, refresh]);

  const instrument = (id: string | null) => (id ? instruments.current.get(id) : undefined) ?? null;
  const uncertain = local.find(order => order.status === 'uncertain') ?? null;

  /** Validates and sends one order. The caller enforces UI-level caps (e.g. the keyboard notional limit). */
  const place = async (input: PlaceInput): Promise<PlaceResult> => {
    const inst = instrument(input.instId), cfg = configRef.current;
    if (!creds.current || !cfg) return { state: 'rejected', message: t('交易密钥已锁定，请先在本机解锁。') };
    if (!inst) return { state: 'rejected', message: t('交易所合约信息尚未载入，请稍后重试。') };
    if (localRef.current.some(order => order.status === 'uncertain')) return { state: 'rejected', message: t('上一笔订单结果不确定，核对完成前不接受新订单。') };
    const sz = contractsFor(input.qty, inst);
    if (!(Number(sz) >= Number(inst.minSz))) return { state: 'rejected', message: t('数量低于最小下单量 {0}。', baseFor(Number(inst.minSz), inst)) };
    const px = input.price !== undefined ? roundTo(input.price, inst.tickSz) : undefined;
    if (input.kind !== 'market' && !(Number(px) > 0)) return { state: 'rejected', message: t('请输入有效价格。') };
    const hedge = cfg.posMode === 'long_short_mode';
    // Hedge mode closes with the opposite side on the same posSide; net mode uses reduceOnly.
    const posSide = hedge ? (input.reduceOnly ? (input.side === 'sell' ? 'long' : 'short') : (input.side === 'buy' ? 'long' : 'short')) : undefined;
    const clOrdId = clientOrderId();
    const algo = input.kind === 'trigger';
    const qty = baseFor(Number(sz), inst);
    const label = `${input.side === 'buy' ? t('买入') : t('卖出')} ${input.kind === 'limit' ? t('限价') : input.kind === 'market' ? t('市价') : input.side === 'buy' ? t('突破触发') : t('跌破触发')} ${qty}${px ? ` @ ${px}` : ''}`;
    // TP/SL can ride a new limit or market order; OKX refuses them on reduce-only orders (51100).
    const protect = { tp: input.tp ?? null, sl: input.sl ?? null };
    const attach = !algo && !input.reduceOnly && (protect.tp || protect.sl) ? [{ attachAlgoClOrdId: clientOrderId(), ...legs(protect, inst.tickSz) }] : null;
    const draft: TradeOrder = { id: clOrdId, algo, instId: inst.instId, clOrdId, side: input.side, posSide: posSide ?? 'net', kind: input.kind, price: Number(px ?? 0), contracts: Number(sz), qty, filled: 0,
      reduceOnly: input.reduceOnly, status: 'sending', createdAt: Date.now(), tp: attach ? protect.tp : null, sl: attach ? protect.sl : null };
    if (input.kind !== 'market') setLocal(list => [...list, draft]);
    const common = { instId: inst.instId, tdMode: 'cross', side: input.side, sz, ...(posSide ? { posSide } : {}), ...(!hedge && input.reduceOnly ? { reduceOnly: true } : {}) };
    try {
      if (algo) await call('POST', 'trade/order-algo', { ...common, ordType: 'trigger', triggerPx: px, orderPx: '-1', triggerPxType: 'last', algoClOrdId: clOrdId });
      else await call('POST', 'trade/order', { ...common, ordType: input.kind, clOrdId, ...(input.kind === 'limit' ? { px } : {}), ...(attach ? { attachAlgoOrds: attach } : {}) });
      if (input.kind === 'market') setLocal(list => list.filter(order => order.clOrdId !== clOrdId));
      void refresh();
      return { state: 'placed', label };
    } catch (error) {
      if (error instanceof OkxUncertainError) {
        setLocal(list => [...list.filter(order => order.clOrdId !== clOrdId), { ...draft, status: 'uncertain', createdAt: error.signedAt }]);
        return { state: 'uncertain', label };
      }
      setLocal(list => list.filter(order => order.clOrdId !== clOrdId));
      if (error instanceof OkxError && AUTH_CODES.has(error.code)) lock();
      return { state: 'rejected', message: describe(error) };
    }
  };
  /** Amend and cancel are idempotent on OKX, so an unknown result only needs a refresh. */
  const writeThenRefresh = async (send: () => Promise<unknown>, success: string, failurePrefix = ''): Promise<boolean> => {
    try { await send(); notifyRef.current(success); return true; }
    catch (error) {
      notifyRef.current(failurePrefix + (error instanceof OkxUncertainError || (error instanceof AppError && error.code === 'request_uncertain') ? t('交易所结果未知，已刷新委托列表，请核对后再操作。') : describe(error)));
      return false;
    } finally { void refresh(); }
  };
  const amend = (order: TradeOrder, price: number) => {
    const inst = instrument(order.instId);
    if (!inst) return Promise.resolve(false);
    const px = roundTo(price, inst.tickSz);
    return writeThenRefresh(() => order.algo
      ? call('POST', 'trade/amend-algos', { instId: order.instId, algoId: order.id, newTriggerPx: px, newOrdPx: '-1', newTriggerPxType: 'last' })
      : call('POST', 'trade/amend-order', { instId: order.instId, ordId: order.id, newPx: px }), t('改价已提交：{0} → {1}', order.price, px));
  };
  const cancel = (order: TradeOrder) => writeThenRefresh(() => order.algo
    ? call('POST', 'trade/cancel-algos', [{ instId: order.instId, algoId: order.id }])
    : call('POST', 'trade/cancel-order', { instId: order.instId, ordId: order.id }), t('已撤单：{0}', order.clOrdId || order.id));
  const cancelAll = async (forInst: string) => {
    const open = (account?.orders ?? []).filter(order => order.instId === forInst);
    if (!open.length) { notifyRef.current(t('本市场没有可撤销的挂单。')); return; }
    const plain = open.filter(order => !order.algo), algos = open.filter(order => order.algo);
    await writeThenRefresh(async () => {
      for (let i = 0; i < plain.length; i += 20) await call('POST', 'trade/cancel-batch-orders', plain.slice(i, i + 20).map(order => ({ instId: order.instId, ordId: order.id })));
      for (let i = 0; i < algos.length; i += 10) await call('POST', 'trade/cancel-algos', algos.slice(i, i + 10).map(order => ({ instId: order.instId, algoId: order.id })));
    }, t('已撤销本市场 {0} 笔挂单', open.length));
  };

  /** The TP/SL that closes this whole position, if any (closeFraction 1, or a size equal to the position). */
  const protectionFor = (position: TradePosition) => (account?.protects ?? []).find(item => item.instId === position.instId && (item.posSide === position.posSide || item.posSide === 'net')
    && (item.full || Math.abs(item.contracts - position.contracts) < 1e-9)) ?? null;
  /** Sets or clears the whole-position TP/SL. Same legs -> amend prices in place; a different leg set -> cancel, then place anew. */
  const protectPosition = async (position: TradePosition, input: ProtectInput): Promise<boolean> => {
    const inst = instrument(position.instId), cfg = configRef.current;
    if (!inst || !cfg) return false;
    const current = protectionFor(position);
    const cancelCurrent = () => current ? call('POST', 'trade/cancel-algos', [{ instId: current.instId, algoId: current.id }]) : Promise.resolve([]);
    if (!input.tp && !input.sl) return current ? writeThenRefresh(cancelCurrent, t('已删除止盈止损')) : true;
    if (current && !!current.tp === !!input.tp && !!current.sl === !!input.sl)
      return writeThenRefresh(() => call('POST', 'trade/amend-algos', { instId: current.instId, algoId: current.id, ...legs(input, inst.tickSz, true) }), t('止盈止损已更新'));
    const net = cfg.posMode !== 'long_short_mode';
    // closeFraction=1 follows the position size and is cancelled with it; OKX allows it in net mode outside portfolio margin only.
    const size = net && cfg.acctLv !== '4' ? { closeFraction: '1', reduceOnly: true } : net ? { sz: String(position.contracts), reduceOnly: true } : { sz: String(position.contracts), posSide: position.posSide };
    // A net-mode conditional order with both legs runs only the stop loss, so two legs always use oco.
    const body = { instId: position.instId, tdMode: position.mgnMode === 'isolated' ? 'isolated' : 'cross', side: position.side === 'long' ? 'sell' : 'buy',
      ordType: input.tp && input.sl ? 'oco' : 'conditional', algoClOrdId: clientOrderId(), ...size, ...legs(input, inst.tickSz) };
    // OKX keeps one whole-position TP/SL, so the old one goes first; a failed placement leaves the position unprotected and says so.
    if (current && !await writeThenRefresh(cancelCurrent, t('已撤销旧的止盈止损'))) return false;
    return writeThenRefresh(() => call('POST', 'trade/order-algo', body), t('止盈止损已设置'), current ? t('旧的止盈止损已撤销，新的设置失败，当前持仓没有止盈止损：') : '');
  };
  /** Chart drag moves one leg; × removes it (the other leg, if any, stays). */
  const amendProtect = (position: TradePosition, item: TradeProtect, leg: 'tp' | 'sl', price: number | null) => {
    const inst = instrument(item.instId);
    if (!inst) return Promise.resolve(false);
    if (price === null) return protectPosition(position, { tp: leg === 'tp' ? null : item.tp, sl: leg === 'sl' ? null : item.sl });
    return writeThenRefresh(() => call('POST', 'trade/amend-algos', { instId: item.instId, algoId: item.id, ...legs(leg === 'tp' ? { tp: price, sl: null } : { tp: null, sl: price }, inst.tickSz, true) }),
      t('{0}已改到 {1}', leg === 'tp' ? t('止盈') : t('止损'), roundTo(price, inst.tickSz)));
  };

  const orders = [...(account?.orders ?? []), ...local.filter(order => !(account?.orders ?? []).some(item => item.clOrdId === order.clOrdId))];
  return { vault, status, relay, config, account, orders, pollError, leverage, uncertain, instrument, unlock, save, forget, lock, place, amend, cancel, cancelAll, refresh, protectionFor, protectPosition, amendProtect };
}
export type OkxAccount = ReturnType<typeof useOkxAccount>;
