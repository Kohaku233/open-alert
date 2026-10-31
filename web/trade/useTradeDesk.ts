/* Trade-mode controller for the Markets page: arming the chart, keyboard shortcuts,
   the order form and the per-order notional cap for one-click chart orders. */
import { useEffect, useMemo, useRef, useState } from 'react';
/** The subset of a directory market that trade mode needs. */
type Market = { instrument: string; base: string; venue?: string; type?: string; nativeId?: string };
import type { ChartArmed, ChartOverlay, ChartTradeLine } from '../components/NativeChart.js';
import { t } from '../i18n.js';
import { formatQuotePrice } from '../utils.js';
import { baseFor, contractsFor } from './okx.js';
import type { TradeKind, TradeOrder, TradeSide } from './useOkxAccount.js';
import { useOkxAccount } from './useOkxAccount.js';

const KEYBOARD_KEY = 'open-alert-trade-keyboard';
const CAP_KEY = 'open-alert-trade-cap';
export const DEFAULT_CAP = 5000;
export const NOTIONAL_PRESETS = [100, 500, 1000, 2500] as const;
const readText = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeText = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* keep in memory */ } };
// Keys never fire while the user types or a dialog, list or menu has focus.
export function typingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || !!target.closest('[role="dialog"],[role="listbox"],[role="menu"],[role="combobox"]');
}
// A buy above the market (or a sell below it) cannot rest as a limit, so it becomes a trigger order.
export function chartKind(side: TradeSide, price: number, last: number): Exclude<TradeKind, 'market'> {
  return (side === 'buy' ? price > last : price < last) ? 'trigger' : 'limit';
}
export const sideText = (side: TradeSide) => side === 'buy' ? t('买入') : t('卖出');
export const kindText = (kind: TradeKind, side: TradeSide) => kind === 'limit' ? t('限价') : kind === 'market' ? t('市价') : side === 'buy' ? t('突破触发') : t('跌破触发');
export const formatQty = (value: number) => Number(value.toPrecision(10)).toString();
export const formatSigned = (value: number, digits = 2) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;
export function tradableMarket(market: Market | undefined): market is Market & { nativeId: string } { return market?.venue === 'okx' && market.type === 'swap' && !!market.nativeId; }
function readMode(): 'alert' | 'trade' {
  const query = new URLSearchParams(window.location.search).get('mode');
  if (query === 'trade' || query === 'alert') return query;
  return readText('open-alert-dashboard-mode') === 'trade' ? 'trade' : 'alert';
}
export function useDashboardMode(allowed: boolean) {
  const [mode, setState] = useState(readMode);
  const setMode = (next: 'alert' | 'trade') => {
    setState(next); writeText('open-alert-dashboard-mode', next);
    const url = new URL(window.location.href);
    url.searchParams.set('mode', next);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };
  return [allowed ? mode : 'alert', setMode] as const;
}
export function useTradeDesk({ enabled, market, last, notify, onAlertAt }: { enabled: boolean; market: Market | undefined; last: number | undefined; notify: (text: string) => void; onAlertAt: (price: number) => void }) {
  const instId = tradableMarket(market) ? market.nativeId : null;
  const account = useOkxAccount({ enabled, instId, notify });
  const [armed, setArmed] = useState<ChartArmed>(null);
  const [keyboard, setKeyboardState] = useState(() => readText(KEYBOARD_KEY) !== 'off');
  const [cap, setCapState] = useState(() => readText(CAP_KEY) ?? String(DEFAULT_CAP));
  const [keyDialog, setKeyDialog] = useState(false);
  const [side, setSide] = useState<TradeSide>('buy');
  const [type, setType] = useState<'limit' | 'market'>('limit');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const priceInput = useRef<HTMLInputElement>(null);
  const setKeyboard = (on: boolean) => { setKeyboardState(on); writeText(KEYBOARD_KEY, on ? 'on' : 'off'); if (!on) setArmed(null); };
  const setCap = (value: string) => { setCapState(value); writeText(CAP_KEY, value); };
  const inst = account.instrument(instId);
  const ready = account.status === 'ready' && !!inst;
  useEffect(() => { setArmed(null); setPrice(''); setQty(''); setReduceOnly(false); }, [instId]);
  useEffect(() => { if (!enabled || !ready) setArmed(null); }, [enabled, ready]);

  const qtyValue = Number(qty) || 0;
  const position = account.account?.positions.find(item => item.instId === instId);
  const orders = account.orders.filter(order => order.instId === instId);
  const capValue = Number(cap) || 0;

  async function send(input: { side: TradeSide; kind: TradeKind; price?: number; qty: number; reduceOnly: boolean }, source: 'chart' | 'form') {
    if (!instId) return false;
    const notional = input.qty * (input.price ?? last ?? 0);
    if (source === 'chart' && capValue > 0 && notional > capValue) {
      notify(t('超过单笔上限：{0} > {1} USDT，订单未发送。', Math.round(notional), capValue));
      return false;
    }
    setBusy(true);
    try {
      const result = await account.place({ instId, ...input });
      if (result.state === 'rejected') { notify(result.message); return false; }
      notify(result.state === 'placed' ? t('已提交：{0}', result.label) : t('{0}：交易所结果未知，正在按客户端订单号核对，请勿重复下单。', result.label));
      return true;
    } finally { setBusy(false); }
  }
  function arm(next: Exclude<ChartArmed, null>) {
    if (next !== 'alert' && !ready) {
      notify(account.status === 'empty' ? t('请先连接 OKX API Key。') : t('交易密钥已锁定，请先在本机解锁。'));
      if (account.status !== 'connecting') setKeyDialog(true);
      return;
    }
    if (next !== 'alert' && !(qtyValue > 0)) { notify(t('请先在下单面板填写数量。')); return; }
    setArmed(current => current === next ? null : next);
  }
  const armedRef = useRef(armed);
  armedRef.current = armed;
  function onArmedClick(at: number, keepArmed: boolean) {
    const mode = armedRef.current;
    if (!keepArmed || mode === 'alert') setArmed(null);
    if (mode === 'alert') { onAlertAt(at); return; }
    if (!mode || !last) return;
    void send({ side: mode, kind: chartKind(mode, at, last), price: at, qty: qtyValue, reduceOnly }, 'chart');
  }

  // Keyboard mode: B / S arm a side, A arms an alert, C cancels this market's orders, Esc disarms.
  const keys = useRef({ enabled, keyboard, keyDialog, armed, arm, cancelAll: () => { if (instId) void account.cancelAll(instId); } });
  keys.current = { enabled, keyboard, keyDialog, armed, arm, cancelAll: () => { if (instId) void account.cancelAll(instId); } };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const k = keys.current;
      if (!k.enabled || !k.keyboard || k.keyDialog || event.metaKey || event.ctrlKey || event.altKey || event.repeat || typingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') { if (k.armed) { event.preventDefault(); setArmed(null); } return; }
      if (key === 'b' || key === 's' || key === 'a') { event.preventDefault(); k.arm(key === 'b' ? 'buy' : key === 's' ? 'sell' : 'alert'); return; }
      if (key === 'c') { event.preventDefault(); k.cancelAll(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function submit() {
    if (type === 'market') return send({ side, kind: 'market', qty: qtyValue, reduceOnly }, 'form');
    const at = Number(price);
    if (!(at > 0)) { notify(t('请输入限价价格。')); priceInput.current?.focus(); return Promise.resolve(false); }
    return send({ side, kind: 'limit', price: at, qty: qtyValue, reduceOnly }, 'form');
  }
  function closePosition(kind: 'market' | 'limit') {
    if (!position) return;
    const closeSide: TradeSide = position.side === 'long' ? 'sell' : 'buy';
    if (kind === 'market') { void send({ side: closeSide, kind: 'market', qty: position.qty, reduceOnly: true }, 'form'); return; }
    setSide(closeSide); setType('limit'); setQty(String(position.qty)); setReduceOnly(true); if (last) setPrice(String(last));
    priceInput.current?.focus();
  }
  function presetQty(notional: number) {
    if (!inst || !last) return;
    setQty(String(baseFor(Number(contractsFor(notional / last, inst)), inst)));
  }

  const orderLine = (order: TradeOrder): ChartTradeLine => ({
    id: order.clOrdId || order.id, price: order.price, tone: order.side, style: order.kind === 'trigger' ? 'dashed' : 'solid',
    draggable: order.status === 'open' && !!order.id && order.id !== order.clOrdId, cancellable: order.status === 'open',
    chip: { badge: order.side === 'buy' ? t('买') : t('卖'), text: `${kindText(order.kind, order.side)}${order.reduceOnly ? ` · ${t('只减仓')}` : ''}`, qty: formatQty(order.qty - order.filled),
      ...(order.status !== 'open' ? { state: order.status === 'sending' ? t('发送中') : t('结果不确定') } : {}) },
  });
  const lines = useMemo(() => {
    if (!enabled || account.status !== 'ready') return [];
    const list = orders.filter(order => order.kind !== 'market' && order.price > 0).map(orderLine);
    if (position) {
      list.push({ id: 'position', price: position.entry, tone: 'position', style: 'dashed',
        chip: { badge: position.side === 'long' ? t('多') : t('空'), text: formatQuotePrice(position.entry), qty: formatQty(position.qty), pnl: { text: `${formatSigned(position.upnl)} USDT`, positive: position.upnl >= 0 } } });
      if (position.liq) list.push({ id: 'liq', price: position.liq, tone: 'liq', style: 'dotted', title: t('强平') });
    }
    return list;
  }, [enabled, account.status, orders, position]);
  const findOrder = (id: string) => orders.find(order => (order.clOrdId || order.id) === id);
  const ghost = (at: number): ReturnType<ChartOverlay['ghost']> => {
    if (!armed || !last) return null;
    if (armed === 'alert') return { tone: 'alert', text: `${t('警报')} · ${at >= last ? t('↑ 达到或高于') : t('↓ 达到或低于')} ${formatQuotePrice(at)}`, hint: t('点击后打开警报设置') };
    const kind = chartKind(armed, at, last);
    return { tone: armed, text: `${sideText(armed)} · ${kindText(kind, armed)} ${formatQty(qtyValue)} ${market?.base ?? ''} @ ${formatQuotePrice(at)}`, hint: t('点击发送 · Shift+点击连续下单') };
  };
  const caption = armed === 'alert' ? t('A 新建警报已就绪：在图表上点击价格位置，Esc 取消。')
    : armed ? t('{0}已就绪：在图表上点击价格下单（{1} {2}），Shift+点击可连续下单，Esc 取消。', armed === 'buy' ? t('B 买入') : t('S 卖出'), formatQty(qtyValue), market?.base ?? '')
    : keyboard ? t('键盘模式：B 买 / S 卖 / A 警报，然后在图上点击价格。拖动订单线改价，点 × 撤单。') : t('点「图上买 / 图上卖」后在图表上点击价格下单。拖动订单线改价，点 × 撤单。');
  const overlay: ChartOverlay | undefined = enabled ? {
    trading: true, lines, armed, caption, ghost, onArmedClick,
    onModify: (id, to) => { const order = findOrder(id); if (order) void account.amend(order, to); },
    onCancel: id => { const order = findOrder(id); if (order) void account.cancel(order); },
  } : undefined;
  const contracts = inst && qtyValue > 0 ? contractsFor(qtyValue, inst) : '0';
  return {
    account, instId, inst, ready, armed, setArmed, arm, keyboard, setKeyboard, cap, setCap, keyDialog, setKeyDialog, busy,
    form: { side, setSide, type, setType, price, setPrice, qty, setQty, reduceOnly, setReduceOnly, priceInput, qtyValue, contracts, submit, presetQty },
    position, orders, overlay, closePosition,
  };
}
export type TradeDesk = ReturnType<typeof useTradeDesk>;
