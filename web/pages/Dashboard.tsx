import { useEffect, useState } from 'react';
import type { Alert } from '../../src/contracts/domain.js';
import type { WorkspaceModel } from '../model.js';
import { api, errorText } from '../api.js';
import { alertState, breached, formatPrice, formatTime, freshTick, healthLabels, outcomeLabels, safeChartSymbol } from '../utils.js';
import { TradingChart } from '../components/TradingChart.js';
import { AlertEditor } from '../components/AlertEditor.js';
import { Dialog, FormError } from '../components/Dialog.js';
import { MarketPicker } from '../components/MarketPicker.js';
import { findMarket, marketIdentity, marketLabel, marketQuote, sameMarket, selectableMarket, typeLabels, useRetainedMarket, venueLabels } from '../markets.js';

type ConfirmAction = { kind: 'delete' | 'rearm'; alert: Alert } | { kind: 'disable' };
export function Dashboard({ model, active, notify, navigate }: { model: WorkspaceModel; active: boolean; notify: (text: string) => void; navigate: (path: string) => void }) {
  const { data, error, busy, loadedAt, mutate } = model;
  const [chartVisited, setChartVisited] = useState(active);
  useEffect(() => { if (active) setChartVisited(true); }, [active]);
  const [selected, setSelected] = useState('');
  const [editor, setEditor] = useState<{ alert: Alert | null } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [actionError, setActionError] = useState('');
  useEffect(() => {
    if (!selected && data) {
      const initial = data.alerts[0]?.instrument ?? data.markets.find(selectableMarket)?.instrument;
      if (initial) setSelected(initial);
    }
  }, [data?.markets, selected]);
  const market = useRetainedMarket(data?.markets ?? [], selected);
  if (!data) return <section hidden={!active} className="page-loading"><h1>我的监控</h1><p>{error || '正在读取你的警报与行情…'}</p></section>;
  const available = selectableMarket(findMarket(data.markets, selected));
  const identity = marketIdentity(selected, market);
  const source = identity.venue ? venueLabels[identity.venue] : '所选交易所';
  const tick = data.status.prices.find(item => sameMarket(item.instrument, selected));
  const fresh = freshTick(tick);
  const settings = data.status.settings;
  const marketMode = data.status.scheduler.marketMode;
  const modeCopy = marketMode === 'polling'
    ? '成交价轮询：默认每 5 秒采样最新有效成交，限流或调度可能延长间隔；可能漏掉短暂越过阈值的成交。'
    : marketMode === 'stream'
      ? '成交流监控：逐条检查收到的有效新鲜成交；重连或数据溢出期间可能漏掉越过阈值的成交。'
      : '行情模式未报告，请查看后台运行配置。';
  const settingsPending = data.alerts.some(alert => alert.pending);
  async function enableMonitoring() {
    if (!data || busy) return; setActionError('');
    try { await mutate(() => api('PATCH /api/settings', { enabled: true, expectedGeneration: data.status.settingsGeneration })); notify('监控已启用。'); }
    catch (cause) { setActionError(errorText(cause)); }
  }
  async function confirmAction() {
    if (!data || !confirm || busy) return; setActionError('');
    try {
      if (confirm.kind === 'disable') { await mutate(() => api('PATCH /api/settings', { enabled: false, expectedGeneration: data.status.settingsGeneration })); notify('监控已暂停。'); }
      else if (confirm.kind === 'delete') { await mutate(() => api('DELETE /api/alerts/:id', { expectedGeneration: confirm.alert.generation }, confirm.alert.id)); notify('警报已删除。'); }
      else { await mutate(() => api('POST /api/alerts/:id/rearm', { expectedGeneration: confirm.alert.generation }, confirm.alert.id)); notify('警报已重新武装。'); }
      setConfirm(null);
    } catch (cause) { setActionError(errorText(cause)); }
  }
  function openConfirm(action: ConfirmAction) { setActionError(''); setConfirm(action); }
  const resultAlerts = data.alerts.filter(alert => alert.last).sort((a, b) => b.last!.at - a.last!.at);
  const rearmTick = confirm && confirm.kind === 'rearm' ? data.status.prices.find(item => sameMarket(item.instrument, confirm.alert.instrument)) : undefined;
  const rearmHit = confirm && confirm.kind === 'rearm' && breached(confirm.alert.side, confirm.alert.threshold, rearmTick);
  return <section hidden={!active} aria-label="行情与警报">
    <div className="market-header"><div className="market-title"><h1>{identity.base || identity.nativeId || '—'} <span className="quote">/ {identity.quote || '—'}</span></h1><span className="contract">{source} · {identity.type ? typeLabels[identity.type] : '市场类型未知'}</span></div><div className="price-block"><strong>{tick ? formatPrice(tick.price) : '—'}{tick && <small className="price-unit"> {marketQuote(selected, market)}</small>}</strong><span>{tick ? `${fresh ? `${source} 最新成交价` : '价格已过期，停止触发'} · ${formatTime(tick.timestamp)}` : '尚未获得后台价格'}</span></div><div className="health"><span className={`dot ${fresh ? 'live' : 'stale'}`} /><span>{fresh ? '成交价新鲜' : tick ? '成交价已过期' : '暂无新鲜成交价'}</span><small>今日通知尝试 {data.status.daily.attempts} / {data.status.daily.limit}</small></div></div>
    <div className={`banner ${settings.enabled && data.status.channel.configured ? 'active' : ''}`}>
      {!data.status.channel.configured ? <><strong>先配置手机通知。</strong> 添加你的 Pushover 用户密钥，再明确启用监控。<button className="text-button" onClick={() => navigate('/notifications')}>配置通知</button></> : settings.enabled ? '监控已启用。每条警报触发一次，后台运行时无需保持页面打开。' : '监控已暂停。已有警报不会触发，启用后首次满足条件的新鲜价格也会触发。'}
    </div>
    <p className="history-note" aria-label="行情采集模式">{modeCopy}</p>
    <p className="history-note">仅采集启用且未锁定规则所需的成交价。暂停规则或只查看市场不请求报价；其他用户规则可能共享价格。近期无成交不代表断线。</p>
    <div className="workspace"><section className="chart-panel" aria-label="TradingView 参考图表"><div className="chart-toolbar"><MarketPicker label="查看市场" markets={data.markets} value={selected} onChange={setSelected} disabled={busy} stale={data.marketStale} error={error} onRetry={() => void model.refresh()} /><button className="accent" onClick={() => setEditor({ alert: null })} disabled={busy || !available || !!error || data.alerts.length >= 20}>＋ 创建警报</button></div>
      {chartVisited && market && safeChartSymbol(market.tradingViewSymbol, market) ? <TradingChart symbol={market.tradingViewSymbol} source={source} /> : <div className="empty-chart"><div><strong>{selected ? '此市场暂无已验证的参考图表' : '请选择要查看的市场'}</strong><p>警报使用所选交易所的后台最新成交价；TradingView 仅供参考。</p>{!data.markets.length && <p>市场目录暂时不可用，请重新读取状态。</p>}</div></div>}
      {data.marketStale && <p className="warning inline-warning">市场目录已过期，新增市场仍需服务端确认支持。</p>}
    </section><aside className="alerts-panel"><div className="panel-heading"><div><h2>价格警报 <span>{data.alerts.length} / 20</span></h2><p>每条触发一次，重新武装后再生效</p></div><button className="icon-button" aria-label="创建价格警报" disabled={busy || !available || !!error || data.alerts.length >= 20} onClick={() => setEditor({ alert: null })}>＋</button></div>
      <div className="global-switch"><span>手机报警总开关</span><button role="switch" aria-checked={settings.enabled} aria-label="手机报警总开关" className="switch" disabled={busy || (!settings.enabled && (!data.status.channel.configured || settingsPending || !!error))} onClick={() => settings.enabled ? openConfirm({ kind: 'disable' }) : void enableMonitoring()} /></div><p className="limits-note">最多 20 条警报、8 个市场；包含暂停的警报。</p>
      <div className="alerts-list">{data.alerts.length ? data.alerts.map(alert => <article className="alert-row" key={alert.id}><div className="alert-top"><strong className="alert-name">{alert.name}</strong><span className={`state-label ${alert.triggered ? 'latched' : ''} ${alert.last?.outcome === 'uncertain' ? 'uncertain' : ''}`}>{alertState(alert)}</span></div><button className="instrument-button" onClick={() => setSelected(alert.instrument)}>{marketLabel(alert.instrument, findMarket(data.markets, alert.instrument))}</button><div className="alert-detail"><span>{alert.side === 'upper' ? '达到或高于' : '达到或低于'}</span><strong>{formatPrice(alert.threshold)} <small>{marketQuote(alert.instrument, findMarket(data.markets, alert.instrument))}</small></strong></div>
        {alert.pending && <p className="pending-inline">{alert.pending.phase === 'queued' ? '已排队，等待投递' : '已开始发送，请勿重复操作'} · 已尝试 {alert.pending.attempts} 次</p>}
        {alert.triggered && !alert.pending && <p className="pending-inline">已触发并锁定；编辑不会解除锁定。{alert.last?.outcome === 'uncertain' ? '可能已经送达，请先查看手机。' : ''}</p>}
        {!settings.enabled && !alert.triggered && <p className="pending-inline">总开关关闭时不会触发。</p>}
        <div className="alert-buttons"><button disabled={busy || !!alert.pending || !!error} onClick={() => setEditor({ alert })}>编辑</button><button disabled={busy || !!alert.pending || !alert.triggered || !!error} onClick={() => openConfirm({ kind: 'rearm', alert })}>重新武装</button><button disabled={busy || !!alert.pending || !!error} onClick={() => openConfirm({ kind: 'delete', alert })}>删除</button></div></article>) : <div className="empty-list"><strong>还没有价格警报</strong><p>选择交易所和市场，填写你关心的价格。创建后需明确打开监控总开关。</p><button onClick={() => setEditor({ alert: null })} disabled={!available || busy || !!error}>创建第一条警报</button></div>}</div>
      <div className="monitor-control"><span>后台监控 {healthLabels[data.status.health.scheduler.state]}</span><span>{loadedAt ? `更新于 ${new Date(loadedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '尚未更新'}</span></div></aside></div>
    {!confirm && <FormError message={actionError} />}
    <section className="history"><div className="history-heading"><h2>最近触发</h2><span>每条现有警报保留最近一次投递结果</span></div>{resultAlerts.length ? resultAlerts.map(alert => <div className="history-row" key={alert.id}><span>{alert.name}<small>{marketLabel(alert.instrument, findMarket(data.markets, alert.instrument))}</small></span><span className={alert.last?.outcome === 'uncertain' ? 'uncertain' : ''}>{outcomeLabels[alert.last!.outcome]}</span><span>{formatTime(alert.last!.at)}</span></div>) : <p className="muted">暂无触发记录</p>}<p className="history-note">「已交给 Pushover」表示服务已确认接收；送达与提醒确认请在手机查看。</p></section>
    {editor && <AlertEditor model={model} alert={editor.alert} instrument={selected} onClose={() => setEditor(null)} notify={notify} />}
    {confirm && <Dialog title={confirm.kind === 'disable' ? '暂停所有监控？' : confirm.kind === 'delete' ? '删除这条警报？' : '重新武装这条警报？'} onClose={() => setConfirm(null)} busy={busy}>
      <p>{confirm.kind === 'disable' ? '暂停后不再触发新通知，并取消仍在队列中的投递。已经开始发送的请求无法撤回，结果可能不确定。' : confirm.kind === 'delete' ? `将删除「${confirm.alert.name}」。历史投递记录由后台保留。` : `「${confirm.alert.name}」将解除触发锁定。之后首次满足条件的新鲜价格会再次触发。`}</p>
      {confirm.kind === 'rearm' && confirm.alert.last?.outcome === 'uncertain' && <p className="warning">上次投递结果不确定，可能已经送达。请先查看手机，再决定是否重新武装。</p>}
      {rearmHit && <p className="warning">当前新鲜成交价已经满足条件，重新武装后可能立即再次触发。</p>}
      <FormError message={actionError} /><div className="confirm-actions"><button disabled={busy} onClick={() => setConfirm(null)}>取消</button><button className="primary" disabled={busy} onClick={() => void confirmAction()}>{busy ? '正在处理…' : confirm.kind === 'disable' ? '暂停监控' : confirm.kind === 'delete' ? '删除警报' : '重新武装'}</button></div>
    </Dialog>}
  </section>;
}
