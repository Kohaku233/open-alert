import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip.js';
import { Switch } from '../components/ui/switch.js';
import { Button } from '../components/ui/button.js';
import { t } from '../i18n.js';
import { Icon } from '../components/Icon.js';
import { useEffect, useState } from 'react';
import type { Alert } from '../../src/contracts/domain.js';
import type { WorkspaceModel } from '../model.js';
import { api, errorText } from '../api.js';
import { alertState, breached, formatPrice, formatTime, healthLabels, outcomeLabels, safeChartSymbol } from '../utils.js';
import { TradingChart } from '../components/TradingChart.js';
import { AlertEditor } from '../components/AlertEditor.js';
import { Dialog, FormError } from '../components/Dialog.js';
import { MarketPicker } from '../components/MarketPicker.js';
import { useMarketQuote } from '../useMarketQuote.js';
import { findMarket, marketIdentity, marketLabel, marketQuote, sameMarket, selectableMarket, typeLabels, useRetainedMarket, venueLabels } from '../markets.js';
type ConfirmAction = {
    kind: 'delete' | 'rearm';
    alert: Alert;
} | {
    kind: 'disable';
};
export function Dashboard({ model, active, notify, navigate }: {
    model: WorkspaceModel;
    active: boolean;
    notify: (text: string) => void;
    navigate: (path: string) => void;
}) {
    const { data, error, busy, loadedAt, mutate } = model;
    const [chartVisited, setChartVisited] = useState(active);
    useEffect(() => { if (active)
        setChartVisited(true); }, [active]);
    const [selected, setSelected] = useState('');
    const [showAllAlerts, setShowAllAlerts] = useState(false);
    const [editor, setEditor] = useState<{
        alert: Alert | null;
    } | null>(null);
    const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
    const [actionError, setActionError] = useState('');
    useEffect(() => {
        if (!selected && data) {
            const initial = data.alerts[0]?.instrument ?? data.markets.find(selectableMarket)?.instrument;
            if (initial)
                setSelected(initial);
        }
    }, [data?.markets, selected]);
    const market = useRetainedMarket(data?.markets ?? [], selected);
    const quoteState = useMarketQuote(selected, active && selectableMarket(findMarket(data?.markets ?? [], selected)));
    if (!data)
        return <section hidden={!active} className="page-loading"><h1>{t("我的监控")}</h1><p>{error || t("正在读取你的警报与行情…")}</p></section>;
    const available = selectableMarket(findMarket(data.markets, selected));
    const identity = marketIdentity(selected, market);
    const source = identity.venue ? venueLabels[identity.venue] : t("所选交易所");
    const tick = quoteState.quote;
    const fresh = available && !!tick && !quoteState.error && Date.now() - tick.observedAt < 15000;
    const visibleAlerts = showAllAlerts ? data.alerts : data.alerts.filter(alert => sameMarket(alert.instrument, selected));
    const settings = data.status.settings;
    const marketMode = data.status.scheduler.marketMode;
    const modeCopy = marketMode === 'polling'
        ? t("成交价轮询：默认每 5 秒采样最新有效成交，限流或调度可能延长间隔；可能漏掉短暂越过阈值的成交。") : marketMode === 'stream'
        ? t("成交流监控：逐条检查收到的有效新鲜成交；重连或数据溢出期间可能漏掉越过阈值的成交。") : t("行情模式未报告，请查看后台运行配置。");
    const settingsPending = data.alerts.some(alert => alert.pending);
    async function enableMonitoring() {
        if (!data || busy)
            return;
        setActionError('');
        try {
            await mutate(() => api('PATCH /api/settings', { enabled: true, expectedGeneration: data.status.settingsGeneration }));
            notify(t("监控已启用。"));
        }
        catch (cause) {
            setActionError(errorText(cause));
        }
    }
    async function confirmAction() {
        if (!data || !confirm || busy)
            return;
        setActionError('');
        try {
            if (confirm.kind === 'disable') {
                await mutate(() => api('PATCH /api/settings', { enabled: false, expectedGeneration: data.status.settingsGeneration }));
                notify(t("监控已暂停。"));
            }
            else if (confirm.kind === 'delete') {
                await mutate(() => api('DELETE /api/alerts/:id', { expectedGeneration: confirm.alert.generation }, confirm.alert.id));
                notify(t("警报已删除。"));
            }
            else {
                await mutate(() => api('POST /api/alerts/:id/rearm', { expectedGeneration: confirm.alert.generation }, confirm.alert.id));
                notify(t("警报已重新武装。"));
            }
            setConfirm(null);
        }
        catch (cause) {
            setActionError(errorText(cause));
        }
    }
    function openConfirm(action: ConfirmAction) { setActionError(''); setConfirm(action); }
    const rearmTick = confirm && confirm.kind === 'rearm' ? data.status.prices.find(item => sameMarket(item.instrument, confirm.alert.instrument)) : undefined;
    const rearmHit = confirm && confirm.kind === 'rearm' && breached(confirm.alert.side, confirm.alert.threshold, rearmTick);
    return <section hidden={!active} aria-label={t("行情与警报")}>
    <div className="page-heading"><h1>{t("行情与警报")}</h1><Button variant="default" className="primary" onClick={() => setEditor({ alert: null })} disabled={busy || !available || !!error || data.alerts.length >= 20}><Icon name="plus"/>{t("创建警报")}</Button></div>
    <div className="market-header"><div className="market-title"><h2>{identity.base || identity.nativeId || '—'} <span className="quote">/ {identity.quote || '—'}</span></h2><span className="contract">{source} · {identity.type ? typeLabels[identity.type] : t("市场类型未知")}</span></div><div className="price-block"><strong>{tick ? formatPrice(tick.price) : '—'}{tick && <small className="price-unit"> {marketQuote(selected, market)}</small>}</strong><span>{tick ? `${fresh ? t("{0} 最新报价", source) : t("报价更新暂停")} · ${formatTime(tick.observedAt)}` : quoteState.error ? t("报价暂时不可用") : t("正在获取所选市场报价…")}</span></div><div className="health"><span className={`dot ${fresh ? 'live' : 'stale'}`}/><span>{fresh ? t("报价已更新") : tick ? t("报价待更新") : t("等待市场报价")}</span><small>{t("今日通知尝试 ")}{data.status.daily.attempts} / {data.status.daily.limit}</small></div></div>
    {quoteState.error && <p className="warning inline-warning" role="status">{t("行情报价更新失败，将自动重试。")}{quoteState.error}</p>}
    <div className="workspace"><section className="chart-panel" aria-label={t("TradingView 参考图表")}><div className="chart-toolbar"><MarketPicker label={t("查看市场")} markets={data.markets} value={selected} onChange={setSelected} disabled={busy} stale={data.marketStale} error={error} onRetry={() => void model.refresh()}/></div>
      {chartVisited && market && safeChartSymbol(market.tradingViewSymbol, market) ? <TradingChart symbol={market.tradingViewSymbol} source={source}/> : <div className="empty-chart"><div><strong>{selected ? t("此市场暂无已验证的参考图表") : t("请选择要查看的市场")}</strong><p>{t("警报使用所选交易所的后台最新成交价；TradingView 仅供参考。")}</p>{!data.markets.length && <p>{t("市场目录暂时不可用，请重新读取状态。")}</p>}</div></div>}
      {data.marketStale && <p className="warning inline-warning">{t("市场目录已过期，新增市场仍需服务端确认支持。")}</p>}
    </section><aside className="alerts-panel"><div className="panel-heading"><div><h2>{t("价格警报 ")}<span>{data.alerts.length} / 20</span></h2><p>{t("每条触发一次，重新武装后再生效")}</p></div><Tooltip><TooltipTrigger asChild><Button type="button" size="icon" className="icon-button" aria-label={t("创建价格警报")} disabled={busy || !available || !!error || data.alerts.length >= 20} onClick={() => setEditor({ alert: null })}><Icon name="plus"/></Button></TooltipTrigger><TooltipContent>{t("创建价格警报")}</TooltipContent></Tooltip></div>
      <div className="global-switch"><span>{t("监控总开关")}</span><Switch checked={settings.enabled} aria-label={t("监控总开关")} className="ui-monitor-switch" disabled={busy || (!settings.enabled && (!data.status.channel.configured || settingsPending || !!error))} onCheckedChange={checked => checked ? void enableMonitoring() : openConfirm({ kind: 'disable' })}/></div><p className="limits-note">{t("最多 20 条警报、8 个市场；包含暂停的警报。")}</p>
      <div className="alert-scope" role="group" aria-label={t("警报范围")}><Button variant="ghost" aria-pressed={!showAllAlerts} onClick={() => setShowAllAlerts(false)}>{t("当前市场")}</Button><Button variant="ghost" aria-pressed={showAllAlerts} onClick={() => setShowAllAlerts(true)}>{t("全部警报")}</Button><small>{visibleAlerts.length}</small></div>
      <div className="alerts-list">{visibleAlerts.length ? visibleAlerts.map(alert => <article className="alert-row" key={alert.id}><div className="alert-top"><strong className="alert-name">{alert.name}</strong><span className={`state-label ${alert.triggered ? 'latched' : ''} ${alert.last?.outcome === 'uncertain' ? 'uncertain' : ''}`}>{alertState(alert)}</span></div><Button className="instrument-button" onClick={() => setSelected(alert.instrument)}>{marketLabel(alert.instrument, findMarket(data.markets, alert.instrument))}</Button><div className="alert-detail"><span>{alert.side === 'upper' ? t("达到或高于") : t("达到或低于")}</span><strong>{formatPrice(alert.threshold)} <small>{marketQuote(alert.instrument, findMarket(data.markets, alert.instrument))}</small></strong></div>
        {alert.pending && <p className="pending-inline">{alert.pending.phase === 'queued' ? t("已排队，等待投递") : t("已开始发送，请勿重复操作")}{t(" · 已尝试 ")}{alert.pending.attempts}{t(" 次")}</p>}
        {alert.triggered && !alert.pending && <p className="pending-inline">{t("已触发并锁定；编辑不会解除锁定。")}{alert.last?.outcome === 'uncertain' ? t("可能已经送达，请先查看手机。") : ''}</p>}
        {!settings.enabled && !alert.triggered && <p className="pending-inline">{t("总开关关闭时不会触发。")}</p>}
        <div className="rule-result">{alert.last && <><span className={alert.last.outcome === "uncertain" ? "uncertain" : "muted"}>{outcomeLabels[alert.last.outcome]}</span><time dateTime={new Date(alert.last.at).toISOString()}>{formatTime(alert.last.at)}</time></>}</div><div className="alert-buttons"><Button disabled={busy || !!alert.pending || !!error} onClick={() => setEditor({ alert })}>{t("编辑")}</Button><Button disabled={busy || !!alert.pending || !alert.triggered || !!error} onClick={() => openConfirm({ kind: 'rearm', alert })}>{t("重新武装")}</Button><Button disabled={busy || !!alert.pending || !!error} onClick={() => openConfirm({ kind: 'delete', alert })}>{t("删除")}</Button></div></article>) : <div className="empty-list"><strong>{showAllAlerts ? t("还没有价格警报") : t("此市场暂无警报")}</strong><p>{t("选择交易所和市场，填写你关心的价格。创建后需明确打开监控总开关。")}</p><Button onClick={() => setEditor({ alert: null })} disabled={!available || busy || !!error}>{t("创建第一条警报")}</Button></div>}</div>
      <div className="monitor-control"><span>{t("后台监控 ")}{healthLabels[data.status.health.scheduler.state]}</span><span>{loadedAt ? t("更新于 {0}", new Date(loadedAt).toLocaleTimeString('zh-CN', { hour12: false })) : t("尚未更新")}</span></div></aside></div>
    <details className="monitor-notes"><summary>{t("监控说明与限制")}</summary><div>    <div className={`banner ${settings.enabled && data.status.channel.configured ? 'active' : ''}`}>
      {!data.status.channel.configured ? <><strong>{t("先配置手机通知。")}</strong>{t(" 添加你的 Pushover 用户密钥，再明确启用监控。")}<Button variant="ghost" className="text-button" onClick={() => navigate('/notifications')}>{t("配置通知")}</Button></> : settings.enabled ? t("监控已启用。每条警报触发一次，后台运行时无需保持页面打开。") : t("监控已暂停。已有警报不会触发，启用后首次满足条件的新鲜价格也会触发。")}
    </div>
    <p className="history-note" aria-label={t("行情采集模式")}>{modeCopy}</p>
    <p className="history-note">{t("查看市场时每 5 秒更新报价，无需创建警报。后台监控仅采集启用且未锁定规则所需的成交价；参考报价不会触发警报。近期无成交不代表断线。")}</p>
    </div></details>
    {!confirm && <FormError message={actionError}/>}
    {editor && <AlertEditor model={model} alert={editor.alert} instrument={selected} onClose={() => setEditor(null)} notify={notify}/>}
    {confirm && <Dialog title={confirm.kind === 'disable' ? t("暂停所有监控？") : confirm.kind === 'delete' ? t("删除这条警报？") : t("重新武装这条警报？")} onClose={() => setConfirm(null)} busy={busy}>
      <p>{confirm.kind === 'disable' ? t("暂停后不再触发新通知，并取消仍在队列中的投递。已经开始发送的请求无法撤回，结果可能不确定。") : confirm.kind === 'delete' ? t("将删除「{0}」。历史投递记录由后台保留。", confirm.alert.name) : t("「{0}」将解除触发锁定。之后首次满足条件的新鲜价格会再次触发。", confirm.alert.name)}</p>
      {confirm.kind === 'rearm' && confirm.alert.last?.outcome === 'uncertain' && <p className="warning">{t("上次投递结果不确定，可能已经送达。请先查看手机，再决定是否重新武装。")}</p>}
      {rearmHit && <p className="warning">{t("当前新鲜成交价已经满足条件，重新武装后可能立即再次触发。")}</p>}
      <FormError message={actionError}/><div className="confirm-actions"><Button disabled={busy} onClick={() => setConfirm(null)}>{t("取消")}</Button><Button variant="default" className="primary" disabled={busy} onClick={() => void confirmAction()}>{busy ? t("正在处理…") : confirm.kind === 'disable' ? t("暂停监控") : confirm.kind === 'delete' ? t("删除警报") : t("重新武装")}</Button></div>
    </Dialog>}
  </section>;
}
