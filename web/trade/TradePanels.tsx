/* Trade-mode surfaces for the Markets page. Markup follows the approved preview (prototype-trade). */
import { forwardRef, useState } from 'react';
import type { ComponentProps, FormEvent } from 'react';
import { Copy, KeyRound, Keyboard, Lock, ShieldCheck } from 'lucide-react';
import { Dialog, FormError } from '../components/Dialog.js';
import { Notice } from '../components/Surface.js';
import { Button } from '../components/ui/button.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Switch } from '../components/ui/switch.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { t } from '../i18n.js';
import { formatQuotePrice } from '../utils.js';
import type { TradeDesk } from './useTradeDesk.js';
import type { TradePosition } from './useOkxAccount.js';
import { NOTIONAL_PRESETS, decimalDraft, formatQty, formatSigned, kindText, pnlAt, protectProblem, sideText } from './useTradeDesk.js';

const money = (value: number, digits = 2) => new Intl.NumberFormat(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const baseOf = (instId: string) => instId.split('-')[0] ?? instId;

/** Price / size field. A text input with a decimal keypad: no browser spinner, no wheel or arrow-key
    stepping, and pasted "67,420.5" or full-width digits are cleaned instead of rejected. */
const DecimalInput = forwardRef<HTMLInputElement, Omit<ComponentProps<'input'>, 'onChange' | 'value' | 'type'> & { value: string; onValue: (value: string) => void }>(
  function DecimalInput({ value, onValue, ...props }, ref) {
    return <Input ref={ref} {...props} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={value}
      onChange={event => onValue(decimalDraft(event.target.value.normalize('NFKC')))}/>;
  });

/** One TP or SL field with the P&L it would book, shown next to the price as the user types. */
function ProtectField({ leg, value, onValue, side, entry, qty, problem }: { leg: 'tp' | 'sl'; value: string; onValue: (value: string) => void; side: 'long' | 'short'; entry: number; qty: number; problem: string | null }) {
  const at = Number(value) || 0;
  const pnl = at > 0 && entry > 0 && qty > 0 ? pnlAt(side, entry, at, qty) : null;
  const pct = at > 0 && entry > 0 ? (at / entry - 1) * 100 : null;
  return <Label className={`order-field protect-field ${leg}`}>
    <span className="protect-label">{leg === 'tp' ? t('止盈触发价') : t('止损触发价')}{pct !== null && <small>{formatSigned(pct)}%</small>}</span>
    <span className="order-input"><DecimalInput value={value} onValue={onValue} placeholder={leg === 'tp' ? t('不设止盈') : t('不设止损')} aria-invalid={problem ? true : undefined}/>
      {value && <button type="button" aria-label={leg === 'tp' ? t('清除止盈') : t('清除止损')} onClick={() => onValue('')}>{t('清除')}</button>}</span>
    <small className={problem ? 'danger-text' : pnl === null ? '' : pnl >= 0 ? 'signal-text' : 'danger-text'} aria-live="polite">
      {problem ?? (pnl === null ? t('触发后市价平仓') : t('预计 {0} USDT', formatSigned(pnl)))}</small>
  </Label>;
}

export function TradeTelemetry({ desk }: { desk: TradeDesk }) {
  const { account, status, relay, vault } = desk.account;
  const ready = status === 'ready';
  const state = relay.state === 'unavailable' ? t('转发离线') : status === 'ready' ? t('可交易') : status === 'connecting' ? t('正在连接') : status === 'locked' ? t('已锁定') : t('未连接');
  return <aside className="telemetry-stack" aria-label={t('交易账户概览')}>
    <div className={`telemetry-item monitor-cell account-cell ${ready ? '' : 'is-locked'}`}><div>
      <span className="telemetry-label">{t('交易账户')}<span className="venue-label"> · OKX{vault?.demo ? ` · ${t('模拟盘')}` : ''}</span></span>
      <strong className={ready ? 'signal-text' : 'amber-text'}>{state}</strong>
      <small>{ready ? t('本地签名 · 服务器只转发') : vault ? t('密钥加密保存在此浏览器') : t('API Key 只保存在此浏览器')}</small></div>
      <Button className="account-lock" disabled={relay.state === 'unavailable' || status === 'connecting'} aria-label={ready ? t('锁定交易密钥') : vault ? t('解锁交易密钥') : t('连接 OKX')}
        onClick={() => ready ? (desk.account.lock(t('交易密钥已锁定。')), desk.setArmed(null)) : desk.setKeyDialog(true)}>
        {ready ? <Lock aria-hidden="true"/> : <KeyRound aria-hidden="true"/>}{ready ? t('锁定') : vault ? t('解锁') : t('连接')}</Button>
    </div>
    <div className="telemetry-item"><span className="telemetry-label">{t('权益 · 可用')}</span><div className="telemetry-value"><strong>{account ? money(account.equity) : '—'}<em> USDT</em></strong><small>{account ? money(account.available) : '—'}</small></div></div>
    <div className="telemetry-item"><span className="telemetry-label">{t('未实现盈亏')}</span><div className="telemetry-value"><strong className={!account ? '' : account.upnl >= 0 ? 'signal-text' : 'amber-text'}>{account ? formatSigned(account.upnl) : '—'}<em> USDT</em></strong><small>{account ? t('{0} 个持仓', account.positions.length) : ''}</small></div></div>
  </aside>;
}

export function ArmGroup({ desk, trade }: { desk: TradeDesk; trade: boolean }) {
  return <div className="arm-group" role="group" aria-label={t('图上操作')}>
    {trade && (['buy', 'sell'] as const).map(side => <Button key={side} type="button" variant="ghost" className={side} disabled={!desk.ready} aria-pressed={desk.armed === side} onClick={() => desk.arm(side)}>
      {desk.keyboard && <kbd className="trade-kbd">{side === 'buy' ? 'B' : 'S'}</kbd>}{side === 'buy' ? t('图上买') : t('图上卖')}</Button>)}
    <Button type="button" variant="ghost" className="alert" aria-pressed={desk.armed === 'alert'} onClick={() => desk.arm('alert')}>{desk.keyboard && trade && <kbd className="trade-kbd">A</kbd>}{t('建警报')}</Button>
  </div>;
}

export function OrderPanel({ desk, last, base }: { desk: TradeDesk; last: number | undefined; base: string }) {
  const { form, inst, ready, account } = desk;
  const lever = desk.instId ? account.leverage[desk.instId] : undefined;
  const px = form.type === 'limit' ? Number(form.price) || last || 0 : last || 0;
  const notional = form.qtyValue * px;
  const uncertain = account.uncertain;
  const disabled = !ready || !!uncertain || desk.busy;
  async function submit(event: FormEvent) { event.preventDefault(); if (!disabled) await form.submit(); }
  const label = !ready ? (account.status === 'empty' ? t('请先连接 OKX') : t('交易密钥已锁定'))
    : `${sideText(form.side)} ${formatQty(form.qtyValue)} ${base}${form.type === 'limit' && Number(form.price) > 0 ? ` @ ${formatQuotePrice(Number(form.price))}` : form.type === 'market' ? ` · ${t('市价')}` : ''}${form.attachProtect && (form.tpValue || form.slValue) ? ` · ${t('带止盈止损')}` : ''}`;
  const protectInvalid = !!(form.protectErrors.tp || form.protectErrors.sl);
  return <>
    <div className="panel-heading"><h2>{t('下单')} <span>{desk.instId ?? ''} · OKX</span></h2></div>
    <form className="order-form" onSubmit={event => void submit(event)}>
      {desk.position && <PositionCard desk={desk} position={desk.position} base={base}/>}
      <div className="order-chips"><span>{t('全仓')}</span>{lever ? <span>{lever}x</span> : null}<span>{account.config?.posMode === 'long_short_mode' ? t('双向持仓') : t('单向持仓')}</span>{account.vault?.demo && <span>{t('模拟盘')}</span>}</div>
      <div className="direction-segments order-side" role="group" aria-label={t('方向')}>{(['buy', 'sell'] as const).map(side => <Button key={side} type="button" aria-pressed={form.side === side} className={side === 'sell' ? 'lower' : ''} onClick={() => form.setSide(side)}>{side === 'buy' ? t('买入 / 做多') : t('卖出 / 做空')}</Button>)}</div>
      <Tabs value={form.type} onValueChange={value => form.setType(value as 'limit' | 'market')}><TabsList aria-label={t('订单类型')} className="order-type"><TabsTrigger value="limit">{t('限价')}</TabsTrigger><TabsTrigger value="market">{t('市价')}</TabsTrigger></TabsList></Tabs>
      {form.type === 'limit' && <Label className="order-field">{t('价格 · USDT')}<span className="order-input"><DecimalInput ref={form.priceInput} value={form.price} placeholder={last ? formatQuotePrice(last) : ''} onValue={form.setPrice}/>
        <button type="button" disabled={!last} onClick={() => last && form.setPrice(String(last))}>{t('最新')}</button></span></Label>}
      <Label className="order-field">{t('数量 · {0}', base)}<span className="order-input"><DecimalInput value={form.qty} placeholder="0" onValue={form.setQty}/><span className="order-unit">{base}</span></span>
        {inst && <small>{t('{0} 张 · 每张 {1} {2}', form.contracts, inst.ctVal, base)}</small>}</Label>
      <div className="price-shortcuts qty-presets" role="group" aria-label={t('按名义价值填写数量')}>{NOTIONAL_PRESETS.map(value => <Button key={value} type="button" disabled={!inst || !last} onClick={() => form.presetQty(value)}>{value >= 1000 ? `${value / 1000}k` : value} U</Button>)}</div>
      <dl className="order-summary"><div><dt>{t('名义价值')}</dt><dd>{money(notional)} USDT</dd></div><div><dt>{t('所需保证金')}</dt><dd>{lever ? `${money(notional / lever)} USDT` : '—'}</dd></div><div><dt>{t('可用')}</dt><dd>{account.account ? `${money(account.account.available)} USDT` : '—'}</dd></div></dl>
      <div className="order-toggles">
        <Label className="check-label order-reduce"><Checkbox checked={form.protect && !form.reduceOnly} disabled={form.reduceOnly} onCheckedChange={value => form.setProtect(value === true)}/><span>{t('止盈止损')}</span></Label>
        <Label className="check-label order-reduce"><Checkbox checked={form.reduceOnly} onCheckedChange={value => form.setReduceOnly(value === true)}/><span>{t('只减仓')}</span></Label>
      </div>
      {form.attachProtect && <div className="protect-grid">
        <ProtectField leg="tp" value={form.tp} onValue={form.setTp} side={form.side === 'buy' ? 'long' : 'short'} entry={form.entryRef} qty={form.qtyValue} problem={form.protectErrors.tp}/>
        <ProtectField leg="sl" value={form.sl} onValue={form.setSl} side={form.side === 'buy' ? 'long' : 'short'} entry={form.entryRef} qty={form.qtyValue} problem={form.protectErrors.sl}/>
        <p className="protect-note">{t('按{0}估算；成交后交易所自动挂出止盈止损，触发后市价平仓。', form.type === 'limit' && Number(form.price) > 0 ? t('委托价') : t('最新价'))}</p>
      </div>}
      {uncertain && <Notice as="p" className="warning" role="status">{t('下单结果不确定，正在按客户端订单号 {0} 向交易所核对；核对完成前不会重发，也不接受新订单。', uncertain.clOrdId)}</Notice>}
      {account.pollError && <Notice as="p" className="warning" role="status">{t('账户数据刷新失败：{0}', account.pollError)}</Notice>}
      <Button variant="default" className={`primary wide order-submit ${form.side}`} disabled={disabled || !(form.qtyValue > 0) || protectInvalid}>{desk.busy ? t('正在提交…') : label}</Button>
    </form>
    <section className="keyboard-settings" aria-label={t('键盘模式')}>
      <Label className="check-label keyboard-toggle"><span><Keyboard aria-hidden="true"/>{t('键盘模式')}<small>{t('按键后在图上点一下即下单，不再确认')}</small></span><Switch checked={desk.keyboard} onCheckedChange={desk.setKeyboard} aria-label={t('键盘模式')}/></Label>
      {desk.keyboard && <ul className="kbd-legend">
        <li><kbd className="trade-kbd">B</kbd><span>{t('图上买：点击处低于现价挂限价，高于现价为突破触发')}</span></li>
        <li><kbd className="trade-kbd">S</kbd><span>{t('图上卖：点击处高于现价挂限价，低于现价为跌破触发')}</span></li>
        <li><kbd className="trade-kbd">A</kbd><span>{t('在点击价位创建警报')}</span></li>
        <li><kbd className="trade-kbd">C</kbd><span>{t('撤销本市场全部挂单')}</span></li>
        <li><kbd className="trade-kbd">Shift</kbd><span>{t('Shift+点击保持就绪，连续下单')}</span></li>
        <li><kbd className="trade-kbd">Esc</kbd><span>{t('取消就绪')}</span></li>
      </ul>}
      <Label className="order-field limit-field">{t('单笔上限 · USDT')}<span className="order-input"><DecimalInput value={desk.cap} onValue={desk.setCap}/></span><small>{t('超过上限的图上订单不会发送；0 表示不限制')}</small></Label>
    </section>
  </>;
}

export function BookPanel({ desk, onSelect }: { desk: TradeDesk; onSelect: (instId: string) => void }) {
  const [tab, setTab] = useState('positions');
  const { account } = desk.account;
  const positions = account?.positions ?? [], orders = desk.account.orders, fills = account?.fills ?? [];
  const here = desk.orders.some(order => order.status === 'open');
  if (desk.account.status !== 'ready') return <p className="book-empty">{desk.account.status === 'connecting' ? t('正在连接 OKX…') : t('连接或解锁 OKX API Key 后显示持仓、委托和成交。')}</p>;
  return <Tabs value={tab} onValueChange={setTab}>
    <div className="panel-heading book-heading"><TabsList aria-label={t('账户明细')}>
      <TabsTrigger value="positions">{t('持仓')} · {positions.length}</TabsTrigger><TabsTrigger value="orders">{t('委托')} · {orders.length}</TabsTrigger><TabsTrigger value="fills">{t('成交')} · {fills.length}</TabsTrigger>
    </TabsList>{tab === 'orders' && here && <Button variant="ghost" className="text-button" onClick={() => desk.instId && void desk.account.cancelAll(desk.instId)}>{t('撤销本市场全部')}{desk.keyboard && <kbd className="trade-kbd">C</kbd>}</Button>}</div>
    <TabsContent value="positions" className="book-list">{positions.length ? positions.map(p => <article key={`${p.instId}-${p.posSide}`} className="book-row position-row">
      <button type="button" className="book-market" onClick={() => onSelect(p.instId)}><strong>{baseOf(p.instId)}/USDT</strong><small>OKX · {p.mgnMode === 'isolated' ? t('逐仓') : t('全仓')} {p.lever}x</small></button>
      <span className={`book-side ${p.side === 'long' ? 'buy' : 'sell'}`}>{p.side === 'long' ? t('多') : t('空')} {formatQty(p.qty)}</span>
      <dl><div><dt>{t('均价')}</dt><dd>{formatQuotePrice(p.entry)}</dd></div><div><dt>{t('标记')}</dt><dd>{formatQuotePrice(p.mark)}</dd></div><div><dt>{t('强平价')}</dt><dd className="danger-text">{p.liq ? formatQuotePrice(p.liq) : '—'}</dd></div>
        <ProtectSummary desk={desk} position={p}/></dl>
      <span className={`book-pnl ${p.upnl >= 0 ? 'signal-text' : 'amber-text'}`}>{formatSigned(p.upnl)}<small>{formatSigned(p.uplRatio)}%</small></span>
      <div className="book-actions">{p.instId === desk.instId ? <><Button disabled={!desk.ready || desk.busy} onClick={() => desk.setProtectDialog(true)}>{t('止盈止损')}</Button><Button disabled={!desk.ready || desk.busy} onClick={() => desk.closePosition('limit')}>{t('限价平仓')}</Button><Button disabled={!desk.ready || desk.busy} onClick={() => desk.closePosition('market')}>{t('市价平仓')}</Button></> : <Button onClick={() => onSelect(p.instId)}>{t('切换到此市场')}</Button>}</div>
    </article>) : <p className="book-empty">{t('没有持仓')}</p>}</TabsContent>
    <TabsContent value="orders" className="book-list">{orders.length ? orders.map(o => <article key={o.clOrdId || o.id} className="book-row order-row">
      <button type="button" className="book-market" onClick={() => onSelect(o.instId)}><strong>{baseOf(o.instId)}/USDT</strong><small>OKX · {o.clOrdId || o.id}</small></button>
      <span className={`book-side ${o.side}`}>{sideText(o.side)} {formatQty(o.qty)}</span>
      <dl><div><dt>{o.kind === 'trigger' ? t('触发价') : t('价格')}</dt><dd>{o.price ? formatQuotePrice(o.price) : t('市价')}</dd></div><div><dt>{t('已成交')}</dt><dd>{formatQty(o.filled)}</dd></div><div><dt>{t('类型')}</dt><dd>{kindText(o.kind, o.side)}{o.reduceOnly ? ` · ${t('只减仓')}` : ''}</dd></div>
        {(o.tp || o.sl) && <div className="book-protect"><dt>{t('止盈 / 止损')}</dt><dd><span className="signal-text">{o.tp ? formatQuotePrice(o.tp) : '—'}</span> / <span className="danger-text">{o.sl ? formatQuotePrice(o.sl) : '—'}</span></dd></div>}</dl>
      <span className={`state-label ${o.status === 'uncertain' ? 'uncertain' : ''}`}>{o.status === 'open' ? t('挂单中') : o.status === 'sending' ? t('发送中') : t('结果不确定')}</span>
      <div className="book-actions"><Button disabled={o.status !== 'open' || !desk.ready} onClick={() => void desk.account.cancel(o)}>{t('撤单')}</Button></div>
    </article>) : <p className="book-empty">{t('没有挂单')}</p>}</TabsContent>
    <TabsContent value="fills" className="book-list">{fills.length ? fills.map(f => <article key={f.id} className="book-row fill-row">
      <span className="book-market"><strong>{baseOf(f.instId)}/USDT</strong><small>{new Date(f.at).toLocaleString(undefined, { hour12: false })}</small></span>
      <span className={`book-side ${f.side}`}>{sideText(f.side)} {formatQty(f.qty)}</span>
      <dl><div><dt>{t('成交价')}</dt><dd>{formatQuotePrice(f.price)}</dd></div><div><dt>{t('手续费')}</dt><dd>{f.fee.toFixed(4)}</dd></div><div><dt>{f.liquidity === 'maker' ? 'Maker' : 'Taker'}</dt><dd>{f.pnl ? formatSigned(f.pnl) : '—'}</dd></div></dl>
    </article>) : <p className="book-empty">{t('最近没有成交')}</p>}</TabsContent>
  </Tabs>;
}

export function KeyDialog({ desk, notify }: { desk: TradeDesk; notify: (text: string) => void }) {
  const { vault, relay } = desk.account;
  const [setup, setSetup] = useState(!vault);
  const [form, setForm] = useState({ key: '', secret: '', passphrase: '', password: '', confirm: '', demo: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (name: keyof typeof form) => (event: { target: { value: string } }) => setForm(value => ({ ...value, [name]: event.target.value }));
  const close = () => { if (!busy) desk.setKeyDialog(false); };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (setup) {
      if (!form.key.trim() || !form.secret.trim() || !form.passphrase) { setError(t('请填写 API Key、Secret 和 Passphrase。')); return; }
      if (form.password.length < 8) { setError(t('本机口令至少 8 位。')); return; }
      if (form.password !== form.confirm) { setError(t('两次输入的本机口令不一致。')); return; }
    } else if (!form.password) return;
    setBusy(true);
    try {
      if (setup) await desk.account.save({ key: form.key.trim(), secret: form.secret.trim(), passphrase: form.passphrase, demo: form.demo }, form.password);
      else await desk.account.unlock(form.password);
      desk.setKeyDialog(false);
      notify(setup ? t('OKX API Key 已验证并加密保存在此浏览器。') : t('交易密钥已在本机解锁，仅本次会话有效。'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('连接失败，请重试。')); }
    finally { setBusy(false); }
  }
  function forget() {
    desk.account.forget(); setSetup(true); setError('');
    notify(t('已从此浏览器删除 OKX API Key。'));
  }
  async function copy() {
    if (!relay.egress) return;
    try { await navigator.clipboard.writeText(relay.egress); notify(t('已复制 IP {0}', relay.egress)); } catch { notify(relay.egress); }
  }
  return <Dialog title={setup ? t('连接 OKX API Key') : t('解锁交易密钥')} eyebrow="LOCAL KEY VAULT" onClose={close} busy={busy} className="key-dialog">
    <form onSubmit={event => void submit(event)}>
      {!setup && vault && <div className="key-identity"><ShieldCheck aria-hidden="true"/><div><strong>OKX{vault.demo ? ` · ${t('模拟盘')}` : ''}</strong><small>API Key ···· {vault.hint} · {t('仅保存在此浏览器')}</small></div></div>}
      {setup && <>
        <Notice as="p" className="warning">{t('在 OKX 新建 API Key 时只勾选「读取」和「交易」，不要勾选「提现」。带提现权限的 Key 会被拒绝。')}</Notice>
        <dl className="key-perms"><div><dt>{t('读取')}</dt><dd>{t('需要')}</dd></div><div><dt>{t('交易')}</dt><dd>{t('需要')}</dd></div><div><dt>{t('提现')}</dt><dd className="amber-text">{t('必须关闭')}</dd></div></dl>
        {relay.egress && <div className="key-identity"><Copy aria-hidden="true"/><div><strong>{t('IP 白名单：{0}', relay.egress)}</strong><small>{t('把这个地址加到 API Key 的 IP 白名单')}</small></div><Button type="button" className="key-copy" onClick={() => void copy()}>{t('复制')}</Button></div>}
        <Label className="order-field">API Key<Input autoComplete="off" spellCheck={false} value={form.key} onChange={set('key')}/></Label>
        <Label className="order-field">Secret<Input type="password" autoComplete="off" value={form.secret} onChange={set('secret')}/></Label>
        <Label className="order-field">Passphrase<Input type="password" autoComplete="off" value={form.passphrase} onChange={set('passphrase')}/></Label>
        <Label className="check-label order-reduce"><Checkbox checked={form.demo} onCheckedChange={value => setForm(current => ({ ...current, demo: value === true }))}/><span>{t('这是 OKX 模拟盘 Key（Demo Trading）')}</span></Label>
      </>}
      <Label className="order-field">{t('本机口令')}<Input type="password" autoComplete={setup ? 'new-password' : 'current-password'} autoFocus={!setup} value={form.password} onChange={set('password')}/></Label>
      {setup && <Label className="order-field">{t('再次输入本机口令')}<Input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')}/></Label>}
      <p className="small muted">{t('密钥用本机口令加密后只存放在此浏览器。下单时由浏览器签名，服务器只转发已签名的请求，不保存密钥和请求内容。被篡改的页面代码仍可能读取已解锁的密钥，请只在可信设备上使用。')}</p>
      <FormError message={error}/>
      <div className="confirm-actions">
        {!setup && <Button type="button" variant="ghost" className="text-button" disabled={busy} onClick={forget}>{t('删除此 Key')}</Button>}
        <Button type="button" disabled={busy} onClick={close}>{t('取消')}</Button>
        <Button variant="default" className="primary" disabled={busy || !form.password}>{busy ? t('正在验证…') : setup ? t('验证并保存') : t('解锁本次会话')}</Button>
      </div>
    </form>
  </Dialog>;
}

function ProtectSummary({ desk, position }: { desk: TradeDesk; position: TradePosition }) {
  const item = desk.account.protectionFor(position);
  const money = (at: number | null) => at ? formatSigned(pnlAt(position.side, position.entry, at, position.qty)) : '';
  return <div className="book-protect"><dt>{t('止盈 / 止损')}</dt><dd>{item ? <>
    <span className="signal-text" title={money(item.tp)}>{item.tp ? formatQuotePrice(item.tp) : '—'}</span> / <span className="danger-text" title={money(item.sl)}>{item.sl ? formatQuotePrice(item.sl) : '—'}</span></> : <span className="muted">{t('未设置')}</span>}</dd></div>;
}

/** Current position for this market, at the top of the ticket so it is visible next to the chart. */
function PositionCard({ desk, position, base }: { desk: TradeDesk; position: TradePosition; base: string }) {
  const item = desk.protection;
  const leg = (at: number | null) => at ? pnlAt(position.side, position.entry, at, position.qty) : null;
  const tp = leg(item?.tp ?? null), sl = leg(item?.sl ?? null);
  return <section className={`position-card ${position.side}`} aria-label={t('当前仓位')}>
    <div className="position-card-head"><span className={`book-side ${position.side === 'long' ? 'buy' : 'sell'}`}>{position.side === 'long' ? t('多') : t('空')} {formatQty(position.qty)} {base}</span>
      <span className="position-lever">{position.mgnMode === 'isolated' ? t('逐仓') : t('全仓')} {position.lever}x</span>
      <strong className={position.upnl >= 0 ? 'signal-text' : 'danger-text'}>{formatSigned(position.upnl)}<small> USDT · {formatSigned(position.uplRatio)}%</small></strong></div>
    <dl><div><dt>{t('均价')}</dt><dd>{formatQuotePrice(position.entry)}</dd></div><div><dt>{t('强平价')}</dt><dd className="danger-text">{position.liq ? formatQuotePrice(position.liq) : '—'}</dd></div>
      <div><dt>{t('止盈')}</dt><dd>{item?.tp ? <><span>{formatQuotePrice(item.tp)}</span><small className="signal-text">{formatSigned(tp!)}</small></> : '—'}</dd></div>
      <div><dt>{t('止损')}</dt><dd>{item?.sl ? <><span>{formatQuotePrice(item.sl)}</span><small className="danger-text">{formatSigned(sl!)}</small></> : '—'}</dd></div></dl>
    <Button type="button" className="position-protect" disabled={!desk.ready || desk.busy} onClick={() => desk.setProtectDialog(true)}>{item ? t('修改止盈止损') : t('设置止盈止损')}</Button>
  </section>;
}

/** Whole-position TP/SL: one OKX conditional/oco order that closes the position at market when triggered. */
export function ProtectDialog({ desk, last }: { desk: TradeDesk; last: number | undefined }) {
  const position = desk.position, current = desk.protection;
  const [tp, setTp] = useState(current?.tp ? String(current.tp) : '');
  const [sl, setSl] = useState(current?.sl ? String(current.sl) : '');
  const [busy, setBusy] = useState(false);
  const close = () => { if (!busy) desk.setProtectDialog(false); };
  if (!position) return <Dialog title={t('止盈止损')} onClose={close}><p>{t('此市场当前没有持仓。')}</p><div className="confirm-actions"><Button onClick={close}>{t('关闭')}</Button></div></Dialog>;
  const reference = position.mark || last || position.entry;
  const tpValue = Number(tp) || 0, slValue = Number(sl) || 0;
  const problems = { tp: tpValue ? protectProblem(position.side, 'tp', tpValue, reference) : null, sl: slValue ? protectProblem(position.side, 'sl', slValue, reference) : null };
  const unchanged = (current?.tp ?? 0) === tpValue && (current?.sl ?? 0) === slValue;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || problems.tp || problems.sl || !position) return;
    setBusy(true);
    try { if (await desk.account.protectPosition(position, { tp: tpValue || null, sl: slValue || null })) desk.setProtectDialog(false); }
    finally { setBusy(false); }
  }
  const base = baseOf(position.instId);
  return <Dialog title={t('持仓止盈止损')} eyebrow={`${base}/USDT · OKX`} onClose={close} busy={busy} className="protect-dialog">
    <form onSubmit={event => void submit(event)}>
      <dl className="protect-facts"><div><dt>{t('仓位')}</dt><dd className={position.side === 'long' ? 'signal-text' : 'amber-text'}>{position.side === 'long' ? t('多') : t('空')} {formatQty(position.qty)} {base}</dd></div>
        <div><dt>{t('均价')}</dt><dd>{formatQuotePrice(position.entry)}</dd></div><div><dt>{t('标记价')}</dt><dd>{formatQuotePrice(reference)}</dd></div></dl>
      <div className="protect-grid">
        <ProtectField leg="tp" value={tp} onValue={setTp} side={position.side} entry={position.entry} qty={position.qty} problem={problems.tp}/>
        <ProtectField leg="sl" value={sl} onValue={setSl} side={position.side} entry={position.entry} qty={position.qty} problem={problems.sl}/>
      </div>
      <p className="small muted">{t('金额按持仓均价和当前数量估算，未计手续费与滑点。触发后以市价平掉整个仓位；仓位变动时数量自动跟随。两个都清空并保存会删除止盈止损。')}</p>
      <div className="confirm-actions"><Button type="button" disabled={busy} onClick={close}>{t('取消')}</Button>
        <Button variant="default" className="primary" disabled={busy || unchanged || !!problems.tp || !!problems.sl || !desk.ready}>{busy ? t('正在提交…') : !tpValue && !slValue && current ? t('删除止盈止损') : t('保存')}</Button></div>
    </form>
  </Dialog>;
}
