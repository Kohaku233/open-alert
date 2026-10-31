import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { usePageMotion } from '../motion.js';
import { Panel, PageHeader, Notice, EmptyState, ListSkeleton } from '../components/Surface.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Switch } from '../components/ui/switch.js';
import { Spinner } from '../components/ui/spinner.js';
import { FormError } from '../components/Dialog.js';
import { t } from '../i18n.js';
import { DocsLink } from '../components/DocsLink.js';
import { errorText, request } from '../api.js';
import type { WorkspaceModel } from '../model.js';
import type { AnomalyEvent, AnomalySettings } from '../../src/anomaly/store.js';
import type { AnomalyStatus } from '../../src/anomaly/engine.js';

interface AnomalyView { settings: AnomalySettings; generation: number; events: AnomalyEvent[]; today: number; channelConfigured: boolean; monitor: AnomalyStatus }
const pct = (v: number) => `${v >= 0 ? '+' : '−'}${(Math.abs(v) * 100).toFixed(1)}%`;
const venueName = { binance: 'Binance', okx: 'OKX', mexc: 'MEXC' } as const;
function when(at: number) {
  const d = new Date(at), today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })} ${time}`;
}
function sessionLabel(e: AnomalyEvent) {
  if (e.category === 'crypto') return t('相对 BTC {0}', pct(e.relativeMove));
  return e.session === 'weekend' ? t('周末休市') : e.session === 'off' ? t('美股盘外') : t('美股盘中');
}

export function Anomaly({ notify, navigate }: { model: WorkspaceModel; notify: (text: string) => void; navigate: (path: string) => void }) {
  const pageRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<AnomalyView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [draft, setDraft] = useState<{ crypto: string; tradfi: string } | null>(null);
  usePageMotion(pageRef, !!view, true, 'settings');
  const load = useCallback(async (signal?: AbortSignal) => {
    try { setView(await request<AnomalyView>('/api/anomaly', 'GET', undefined, signal ? { signal } : {})); setLoadError(''); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setLoadError(errorText(cause)); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load]);
  async function save(patch: Partial<AnomalySettings>, message: string) {
    if (!view || busy) return;
    setBusy(true); setFormError('');
    try { setView(await request<AnomalyView>('/api/anomaly/settings', 'PATCH', { expectedGeneration: view.generation, ...patch })); notify(message); return true; }
    catch (cause) { setFormError(errorText(cause)); void load(); return false; }
    finally { setBusy(false); }
  }
  if (!view) return <section ref={pageRef} className="settings-page anomaly-page"><PageHeader className="page-heading"><div><span className="page-index">02 — ANOMALY</span><h1>{t('异动监测')}</h1></div></PageHeader>
    {loadError ? <Notice className="connection-error" role="alert"><p>{loadError}</p><Button onClick={() => void load()}>{t('重新读取')}</Button></Notice> : <ListSkeleton label={t('正在读取异动监测…')} rows={4}/>}</section>;
  const { settings, monitor } = view;
  const values = draft ?? { crypto: String(Math.round(settings.minMoveCrypto * 100)), tradfi: String(Math.round(settings.minMoveTradfi * 1000) / 10) };
  const ready = monitor.state === 'running' || monitor.state === 'degraded';
  async function saveFilters(event: FormEvent) {
    event.preventDefault();
    const crypto = Number(values.crypto), tradfi = Number(values.tradfi);
    if (!(crypto >= 10 && crypto <= 100) || !(tradfi >= 2 && tradfi <= 50)) {
      setFormError(t('币种门槛 10–100%，股票类门槛 2–50%。')); return;
    }
    if (await save({ minMoveCrypto: crypto / 100, minMoveTradfi: tradfi / 100 }, t('过滤条件已保存。'))) setDraft(null);
  }
  const edit = (key: 'crypto' | 'tradfi', value: string) => setDraft({ ...values, [key]: value });
  return <section ref={pageRef} className="settings-page anomaly-page">
    <PageHeader className="page-heading"><div><span className="page-index">02 — ANOMALY</span><h1>{t('异动监测')}</h1><p>{t('Binance、OKX、MEXC 的 USDT 永续合约出现极端行情时推送到手机。')}</p></div>
      <Badge variant="outline" className={`status-pill ${settings.enabled ? 'success' : ''}`}>{settings.enabled ? t('推送中') : t('未开启')}</Badge></PageHeader>
    {!view.channelConfigured && <Notice className="warning"><p>{t('没有已启用的推送渠道接收异动，暂时无法推送。')}</p><Button onClick={() => navigate('/notifications')}>{t('去通知中心设置')}</Button></Notice>}
    <div className="settings-grid anomaly-grid">
      <Panel className="settings-panel anomaly-switches"><span className="section-index">01 — SIGNAL</span><h2>{t('推送开关')}</h2>
        <div className="anomaly-toggles">
          <label className="anomaly-toggle is-primary"><span><strong>{t('异动推送')}</strong><small>{settings.enabled ? t('满足规则即推送，多交易所合并为一条') : t('只记录，不推送')}</small></span>
            <Switch checked={settings.enabled} aria-label={t('异动推送')} disabled={busy || (!settings.enabled && !view.channelConfigured)} onCheckedChange={checked => void save({ enabled: checked }, checked ? t('异动推送已开启。') : t('异动推送已关闭。'))}/></label>
          <label className="anomaly-toggle"><span><strong>{t('币种合约')}</strong><small>{t('扣除 BTC 同期涨跌后判断 · 流通市值 ≥ $10M')}</small></span>
            <Switch checked={settings.crypto} aria-label={t('币种合约')} disabled={busy} onCheckedChange={checked => void save({ crypto: checked }, t('已更新币种合约推送。'))}/></label>
          <label className="anomaly-toggle"><span><strong>{t('股票与 TradFi 合约')}</strong><small>{t('盘中、盘外、周末分别计算常态波动')}</small></span>
            <Switch checked={settings.tradfi} aria-label={t('股票与 TradFi 合约')} disabled={busy} onCheckedChange={checked => void save({ tradfi: checked }, t('已更新股票类推送。'))}/></label>
        </div>
        <p className="small muted">{t('与价格警报的监控总开关相互独立；接收渠道、提醒级别和免打扰在通知中心设置。')} <Button className="text-button" onClick={()=>navigate('/notifications')}>{t('设置推送规则')}</Button></p>
        <dl className="key-state anomaly-state"><div><dt>{t('监测范围')}</dt><dd>{monitor.series ? t('{0} 个合约 · 币种 {1} / 股票类 {2}', monitor.series, monitor.crypto, monitor.tradfi) : t('正在读取合约列表')}</dd></div>
          <div><dt>{t('行情连接')}</dt><dd>{(['binance', 'okx', 'mexc'] as const).map(v => <span key={v} className={`venue-dot ${monitor.streams[v] ? 'is-live' : ''}`}>{venueName[v]}</span>)}</dd></div>
          <div><dt>{t('波动基准')}</dt><dd>{ready ? t('{0} / {1} 已就绪', monitor.baselines, monitor.series) : t('正在载入 30 天历史 · {0} / {1}', monitor.baselines, monitor.series)}</dd></div>
          <div><dt>{t('今日推送')}</dt><dd>{view.today} · UTC</dd></div></dl>
      </Panel>
      <Panel className="settings-panel anomaly-filters"><span className="section-index">02 — FILTER</span><h2>{t('过滤条件')}</h2>
        <p className="small muted">{t('以下条件同时满足才推送：')} <DocsLink path="/anomaly/rules/"/></p>
        <ol className="anomaly-rules">
          <li><strong>{t('涨跌幅超过常态')}</strong><span>{t('15 分钟到 24 小时窗口内，币种达到自身 30 天波动的 6 倍，股票类达到同时段波动的 4 倍')}</span></li>
          <li><strong>{t('放量')}</strong><span>{t('窗口成交额至少是平时的 3 倍')}</span></li>
          <li><strong>{t('流动性')}</strong><span>{t('24 小时成交额 ≥ $10M；币种需 CoinGecko 可识别且流通市值 ≥ $10M')}</span></li>
          <li><strong>{t('冷却')}</strong><span>{t('按你自己收到的推送计算：同一标的 24 小时内只再推涨跌幅翻倍的行情，方向反转不受限制')} <DocsLink path="/anomaly/cooldown/">{t('冷却说明')}</DocsLink></span></li>
        </ol>
        <form onSubmit={event => void saveFilters(event)}><fieldset disabled={busy}><div className="delivery-fields anomaly-fields">
          <Label>{t('币种最小涨跌 · %')}<Input type="number" min={10} max={100} step={1} required value={values.crypto} onChange={event => edit('crypto', event.target.value)}/><span className="small muted">{t('扣除 BTC 后计算，默认 25')} · <DocsLink path="/anomaly/filters/">{t('如何设置')}</DocsLink></span></Label>
          <Label>{t('股票类最小涨跌 · %')}<Input type="number" min={2} max={50} step={0.5} required value={values.tradfi} onChange={event => edit('tradfi', event.target.value)}/><span className="small muted">{t('默认 3')}</span></Label>
        </div><Button variant="default" className="primary" disabled={!draft}>{busy && <Spinner/>}{busy ? t('正在保存…') : t('保存过滤条件')}</Button></fieldset>
          <FormError message={formError}/>{draft && <Button type="button" className="text-button" disabled={busy} onClick={() => { setDraft(null); setFormError(''); }}>{t('撤销修改')}</Button>}</form>
      </Panel>
    </div>
    <Panel className="settings-panel anomaly-feed"><div className="anomaly-feed-head"><div><span className="section-index">03 — LOG</span><h2>{t('最近异动')}</h2></div><span className="small muted">{t('全部用户共享的检测记录，推送时再按你的开关和门槛过滤')}</span></div>
      {view.events.length ? <ul className="anomaly-events">{view.events.map((e, row) => <li key={e.id} className={`anomaly-event is-${e.direction}`} style={{ '--row': Math.min(row, 8) } as CSSProperties}>
        <time dateTime={new Date(e.at).toISOString()}>{when(e.at)}</time>
        <div className="anomaly-event-main"><strong>{e.label}</strong><Badge variant="outline">{e.category === 'crypto' ? t('币种') : t('股票类')}</Badge><span className="anomaly-move">{pct(e.move)}<small> / {e.window}</small></span></div>
        <div className="anomaly-event-meta"><span>{t('常态 {0} 倍', Math.abs(e.z).toFixed(1))}</span><span>{t('成交量 {0} 倍', e.volumeMultiple.toFixed(1))}</span><span>{sessionLabel(e)}</span>{e.marketCap ? <span>{t('市值 ${0}M', Math.round(e.marketCap / 1e6))}</span> : null}</div>
        <div className="anomaly-event-venues">{e.venues.map(v => <a key={v.instrument} href={`/dashboard?market=${encodeURIComponent(v.instrument)}`} onClick={event => { event.preventDefault(); navigate(`/dashboard?market=${encodeURIComponent(v.instrument)}`); }}>{venueName[v.venue]} ↗</a>)}</div>
      </li>)}</ul> : <EmptyState className="empty-list"><strong>{t('暂无异动')}</strong><p>{t('规则较严格，平均每天几条。检测到后会出现在这里。')}</p></EmptyState>}
    </Panel>
  </section>;
}
