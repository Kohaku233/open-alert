import { useCompactLayout } from '../useCompactLayout.js';
import { useBootClaim } from '../components/BootStage.js';
import { SignalTrace, PriceDigits } from '../components/SignalTrace.js';
import { DialogPresence, usePageMotion } from '../motion.js';
import { Panel, PageHeader, EmptyState, Notice, Disclosure, PageError } from '../components/Surface.js';
import { Switch } from '../components/ui/switch.js';
import { Badge } from '../components/ui/badge.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { Button } from '../components/ui/button.js';
import { t } from '../i18n.js';
import { Icon } from '../components/Icon.js';
import { useEffect, useState, useRef } from 'react';
import type { Alert, Market } from '../../src/contracts/domain.js';
import type { WorkspaceModel } from '../model.js';
import { api, errorText } from '../api.js';
import { alertState, breached, formatPrice, formatQuotePrice, formatTime, healthLabels, outcomeLabels, safeChartSymbol } from '../utils.js';
import { TradingChart } from '../components/TradingChart.js';
import { NativeChart } from '../components/NativeChart.js';
import { setChartKind, useChartKind } from '../chartPreference.js';
import { AlertEditor } from '../components/AlertEditor.js';
import { Dialog, FormError } from '../components/Dialog.js';
import { MarketPicker } from '../components/MarketPicker.js';
import { MarketSourceSelector } from '../components/MarketSourceSelector.js';
import { FirstRunGuide } from '../components/FirstRunGuide.js';
import { useMarketQuote } from '../useMarketQuote.js';
import { findMarket, marketIdentity, marketLabel, marketQuote, sameMarket, selectableMarket, typeLabels, useRetainedMarket, venueLabels } from '../markets.js';
type ConfirmAction = {
    kind: 'delete' | 'rearm';
    alert: Alert;
} | {
    kind: 'retarget';
    alert: Alert;
    price: number;
} | {
    kind: 'disable';
};
export function Dashboard({ model, active, alertsOnly = false, notify, navigate }: {
    model: WorkspaceModel;
    active: boolean;
    alertsOnly?: boolean;
    notify: (text: string) => void;
    navigate: (path: string) => void;
}) {
    const compact = useCompactLayout();
    const pageRef = useRef<HTMLElement>(null);
    usePageMotion(pageRef, !!model.data, active, 'workspace');
    const { data, error, busy, loadedAt, mutate } = model;
    const [chartVisited, setChartVisited] = useState(active);
    useEffect(() => { if (active)
        setChartVisited(true); }, [active]);
    const [selected, setSelected] = useState('');
    const [showAllAlerts, setShowAllAlerts] = useState(false);
    useEffect(() => { if (alertsOnly) setShowAllAlerts(true); }, [alertsOnly]);
    const [mobileChartOpen, setMobileChartOpen] = useState(false);
    const [editor, setEditor] = useState<{
        alert: Alert | null;
        threshold?: number;
        side?: 'upper' | 'lower';
    } | null>(null);
    const chartKind = useChartKind();
    const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
    const [actionError, setActionError] = useState('');
    useEffect(() => {
        if (!selected && data) {
            // Push links open a specific market: /dashboard?market=<instrument>.
            const linked = new URLSearchParams(window.location.search).get('market');
            const initial = (linked && data.markets.some(m => m.instrument === linked) ? linked : null) ?? data.alerts[0]?.instrument ?? data.markets.find(selectableMarket)?.instrument;
            if (initial)
                setSelected(initial);
        }
    }, [data?.markets, selected]);
    // The dashboard stays mounted, so a later in-app link must also switch markets.
    useEffect(() => {
        const linked = active ? new URLSearchParams(window.location.search).get('market') : null;
        if (linked && data?.markets.some(m => m.instrument === linked)) setSelected(linked);
    }, [active, data?.markets]);
    const market = useRetainedMarket(data?.markets ?? [], selected);
    const quoteState = useMarketQuote(selected, active && selectableMarket(findMarket(data?.markets ?? [], selected)));
    const tick = quoteState.quote;
    useBootClaim(t('正在读取交易所行情…'), active && !!selected && !tick && !quoteState.error && selectableMarket(findMarket(data?.markets ?? [], selected)), 'prices');
    const priceText = tick ? formatQuotePrice(tick.price) : '—,———.——';
    if (!data)
        return error ? <PageError title={t("我的监控")}/> : null;
    const available = selectableMarket(findMarket(data.markets, selected));
    const identity = marketIdentity(selected, market);
    const source = identity.venue ? venueLabels[identity.venue] : t("所选交易所");
    const fresh = available && !!tick && !quoteState.error && Date.now() - tick.observedAt < 15000;
    const visibleAlerts = showAllAlerts ? data.alerts : data.alerts.filter(alert => sameMarket(alert.instrument, selected));
    const settings = data.status.settings;
    const marketMode = data.status.scheduler.marketMode;
    const modeCopy = marketMode === 'polling'
        ? t("成交价轮询：默认每 5 秒采样最新有效成交，限流或调度可能延长间隔；可能漏掉短暂越过阈值的成交。") : marketMode === 'stream'
        ? t("成交流监控：逐条检查收到的有效新鲜成交；重连或数据溢出期间可能漏掉越过阈值的成交。") : t("行情模式未报告，请查看后台运行配置。");
    const settingsPending = data.alerts.some(alert => alert.pending);
    const armedCount = data.alerts.filter(alert => alert.enabled && !alert.triggered).length;
    const triggeredCount = data.alerts.filter(alert => alert.triggered).length;
    const dailyRatio = data.status.daily.limit ? Math.min(100, data.status.daily.attempts / data.status.daily.limit * 100) : 0;
    const marketAlerts = data.alerts.filter(alert => sameMarket(alert.instrument, selected));
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
            else if (confirm.kind === 'retarget') {
                const current = data.alerts.find(alert => alert.id === confirm.alert.id);
                if (!current || current.generation !== confirm.alert.generation || current.pending) {
                    setActionError(t("警报已在其他页面更新，请关闭窗口后重新打开。"));
                    return;
                }
                await mutate(() => api('PATCH /api/alerts/:id', { threshold: confirm.price, expectedGeneration: confirm.alert.generation }, confirm.alert.id));
                notify(confirm.alert.triggered ? t("目标价已更新；已触发的警报仍保持锁定。") : t("目标价已更新。"));
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
    const retargetTick = tick && confirm?.kind === 'retarget' && sameMarket(tick.instrument, confirm.alert.instrument) ? { instrument: tick.instrument, price: tick.price, timestamp: tick.timestamp ?? tick.observedAt, receivedAt: tick.observedAt } : undefined;
    const retargetHit = confirm?.kind === 'retarget' && confirm.alert.enabled && !confirm.alert.triggered && breached(confirm.alert.side, confirm.price, retargetTick);
    const nativeAvailable = !!market?.symbol && available;
    const tradingViewAvailable = !!market && safeChartSymbol(market.tradingViewSymbol, market);
    const showNative = chartVisited && !!market && nativeAvailable && (chartKind === 'native' || !tradingViewAvailable);
    const canCreate = available && !busy && !error && data.alerts.length < 20;
    return <section ref={pageRef} className={`route-surface dashboard-v2 ${alertsOnly ? 'alerts-route' : ''}`} hidden={!active} data-mobile-chart={mobileChartOpen ? 'open' : 'closed'} aria-label={t("行情与警报")}>
    <PageHeader className="page-heading dashboard-heading">
      <div className="heading-lockup"><span className="page-index">{alertsOnly ? '02 — ALERT RULES' : '01 — MARKETS · ALERTS'}</span><h1>{alertsOnly ? t("价格警报") : t("行情与警报")}</h1></div>
      <div className="heading-actions"><Button variant="default" className="primary create-alert-button" onClick={() => setEditor({ alert: null })} disabled={busy || !available || !!error || data.alerts.length >= 20}><Icon name="plus"/>{t("创建警报")}</Button></div>
    </PageHeader>

    {!alertsOnly && <FirstRunGuide channelConfigured={data.status.channel.configured} alertCount={data.alerts.length} monitoring={settings.enabled}
      canCreate={available && !error && data.alerts.length < 20} canEnable={data.status.channel.configured && data.alerts.length > 0 && !settingsPending && !error} seasoned={data.alerts.some(alert => !!alert.last || alert.triggered)} busy={busy}
      onConfigure={() => navigate('/notifications')} onCreate={() => setEditor({ alert: null })} onEnable={() => void enableMonitoring()}/>}

    <section className="market-header signal-hero" aria-label={t("当前市场信号")}>
      <div className="signal-hero-main">
        <div className="market-selection"><MarketPicker compact assetOnly label={t("查看市场")} markets={data.markets} value={selected} onChange={setSelected} disabled={busy} stale={data.marketStale} error={error} onRetry={() => void model.refresh()}/>
          <MarketSourceSelector markets={data.markets} value={selected} onChange={setSelected} disabled={busy}/></div>
        <div className="price-block"><strong><span className="price-value" style={{fontSize:priceText.length > 10 ? `${Math.max(24, 540 / priceText.length)}px` : undefined}}><PriceDigits text={priceText} price={tick?.price} instrument={selected}/></span><small className="price-unit"> {marketQuote(selected, market)}</small></strong><span><i className={`quote-pip ${fresh ? 'is-fresh' : ''}`}/>{tick ? `${fresh ? t("后台参考成交") : t("报价更新暂停")} · ${new Date(tick.timestamp ?? tick.observedAt).toLocaleTimeString(undefined, {hour12:false})}` : quoteState.error ? t("报价暂时不可用") : 'ACQUIRING SIGNAL'}<small className="mobile-price-unit"> · {marketQuote(selected, market)}</small></span></div>
      </div>
      <SignalTrace instrument={selected} tick={tick} alerts={marketAlerts} fresh={fresh}/>
      <aside className="telemetry-stack" aria-label={t("运行概览")}>
        <label className="telemetry-item monitor-cell"><div><span className="telemetry-label"><span className="desktop-telemetry-label">{t("监控总开关")}</span><span className="mobile-telemetry-label">{t("监控")}</span></span><strong className={settings.enabled ? 'signal-text' : 'amber-text'}>{settings.enabled ? t("武装中") : t("已暂停")}</strong><small>{settings.enabled ? t("后台正在判断价格") : t("已有规则不会触发")}</small></div><Switch checked={settings.enabled} aria-label={t("监控总开关")} className="ui-monitor-switch" disabled={busy || (!settings.enabled && (!data.status.channel.configured || settingsPending || !!error))} onCheckedChange={checked => checked ? void enableMonitoring() : openConfirm({ kind: 'disable' })}/></label>
        <div className="telemetry-item"><span className="telemetry-label"><span className="desktop-telemetry-label">{t("已武装规则")}</span><span className="mobile-telemetry-label">{t("已武装")}</span></span><div className="telemetry-value"><strong>{armedCount}<em> / {data.alerts.length}</em></strong><small className="amber-text">{triggeredCount ? t("{0} 条已锁定", triggeredCount) : t("全部等待价格信号")}</small></div></div>
        <div className="telemetry-item"><div className="telemetry-budget"><span className="telemetry-label">{t("今日通知")}</span><span>{data.status.daily.attempts} / {data.status.daily.limit === null ? t('无限') : data.status.daily.limit}<i> · UTC</i></span></div><div className="quota-segments" aria-label={t("今日通知尝试")}>{Array.from({ length: 10 }, (_, i) => <i key={i} className={i < Math.ceil(dailyRatio / 10) ? 'is-used' : ''}/>)}</div></div>
      </aside>
    </section>

    {quoteState.error && <Notice as="p" className="warning inline-warning" role="status">{t("行情报价更新失败，将自动重试。")}{quoteState.error}</Notice>}
    {compact && !alertsOnly && <Panel className="mobile-market-alerts"><div className="mobile-alerts-heading"><h2>{t('本市场警报')} · {marketAlerts.length}</h2><Button variant="ghost" onClick={() => navigate('/alerts')}>{t('全部')} {data.alerts.length} →</Button></div>{marketAlerts.length ? marketAlerts.map(alert => <Button key={alert.id} variant="ghost" className={`mobile-alert-summary ${alert.side}`} onClick={() => navigate('/alerts')}><span><strong>{alert.name}</strong><small>{alert.triggered ? t('已锁定') : !settings.enabled ? t('总开关关闭') : tick ? `${t('距现价')} ${((alert.threshold / tick.price - 1) * 100).toFixed(2)}%` : t('等待报价')}</small></span><b>{alert.side === 'upper' ? '↑' : '↓'} {formatPrice(alert.threshold)}</b></Button>) : <p className="small muted">{t('此市场暂无警报')}</p>}<Button variant="ghost" className="mobile-chart-toggle" aria-expanded={mobileChartOpen} onClick={() => setMobileChartOpen(value => !value)}>{t('参考图表')} · {chartKind === 'native' ? t('内置图表') : 'TradingView'} <span>{mobileChartOpen ? '−' : '›'}</span></Button></Panel>}
    <div className="workspace dashboard-grid"><Panel className="chart-panel" aria-label={showNative ? t("内置图表") : t("TradingView 参考图表")}><div className="chart-panel-head"><div><h2>{t("参考图表")}</h2><p>{showNative ? t("拖动警报线可直接改价。") : t("显示用图表，不参与警报判断。")}</p></div><div className="chart-toolbar">{nativeAvailable && tradingViewAvailable ? <div className="chart-kind-switch" role="group" aria-label={t("图表类型")}>{(['native', 'tradingview'] as const).map(kind => <Button key={kind} type="button" variant="ghost" aria-pressed={(kind === 'native') === showNative} onClick={() => setChartKind(kind)}>{kind === 'native' ? t('内置图表') : 'TradingView'}</Button>)}</div> : <span>{showNative ? t('内置图表') : 'TradingView'}</span>}</div></div>
      {showNative && market ? <NativeChart market={market} tick={tick} alerts={marketAlerts} source={source} canCreate={canCreate}
          onRetarget={({ alert, price }) => openConfirm({ kind: 'retarget', alert, price })}
          onCreateAt={price => setEditor({ alert: null, threshold: price, side: tick && price < tick.price ? 'lower' : 'upper' })}/>
        : chartVisited && market && tradingViewAvailable ? <TradingChart symbol={market.tradingViewSymbol} source={source} onUseNative={nativeAvailable ? () => setChartKind('native') : undefined}/>
        : <EmptyState className="empty-chart"><div><strong>{selected ? t("此市场暂无已验证的参考图表") : t("请选择要查看的市场")}</strong><p>{t("警报使用所选交易所的后台最新成交价；TradingView 仅供参考。")}</p>{!data.markets.length && <p>{t("市场目录暂时不可用，请重新读取状态。")}</p>}</div></EmptyState>}
      {data.marketStale && <Notice as="p" className="warning inline-warning">{t("市场目录已过期，新增市场仍需服务端确认支持。")}</Notice>}
    </Panel>{(!compact || alertsOnly) && <Panel as="aside" className="alerts-panel">
      <Tabs value={showAllAlerts ? 'all' : 'market'} onValueChange={value => setShowAllAlerts(value === 'all')} className="alert-market-tabs">
      <div className="panel-heading"><h2>{t("价格警报 ")}<span>{data.alerts.length} / 20</span></h2><div className="alert-scope"><TabsList aria-label={t("警报范围")}>{(compact && alertsOnly ? ['all', 'market'] : ['market', 'all']).map(scope => <TabsTrigger key={scope} value={scope} aria-label={t(scope === 'all' ? '全部警报' : '当前市场')}>{scope === 'all' ? `${t('全部')} · ${data.alerts.length}` : `${identity.base || t('当前市场')}/${identity.quote || ''} · ${marketAlerts.length}`}</TabsTrigger>)}</TabsList><Badge variant="outline" className="alert-scope-count">{t("{0} 条", visibleAlerts.length)}</Badge></div></div>
      <TabsContent value={showAllAlerts ? 'all' : 'market'} className="alerts-list">{visibleAlerts.length ? visibleAlerts.map(alert => <AlertRow key={alert.id} alert={alert} markets={data.markets} settingsEnabled={settings.enabled} price={(sameMarket(alert.instrument, selected) ? tick?.price : undefined) ?? data.status.prices.find(price => sameMarket(price.instrument, alert.instrument))?.price} busy={busy} error={!!error} onSelect={() => setSelected(alert.instrument)} onEdit={() => setEditor({ alert })} onRearm={() => openConfirm({ kind: 'rearm', alert })} onDelete={() => openConfirm({ kind: 'delete', alert })}/>) : <EmptyState className="empty-list"><strong>{showAllAlerts ? t("还没有价格警报") : t("此市场暂无警报")}</strong><p>{t("为这个交易对设置目标价格，创建后开启监控总开关。")}</p><Button onClick={() => setEditor({ alert: null })} disabled={!available || busy || !!error}>{t("设置价格警报")}</Button></EmptyState>}</TabsContent></Tabs>
      <div className="monitor-control"><span>{t("后台监控 ")}{healthLabels[data.status.health.scheduler.state]}</span><span className="monitor-updated">{loadedAt ? t("更新于 {0}", new Date(loadedAt).toLocaleTimeString('zh-CN', { hour12: false })) : t("尚未更新")}</span></div></Panel>}</div>
    <Disclosure className="monitor-notes" title={t("监控说明与限制")}>    <div className={`banner ${settings.enabled && data.status.channel.configured ? 'active' : ''}`}>
      {!data.status.channel.configured ? <><strong>{t("先配置手机通知。")}</strong>{t(" 添加通知渠道并选择接收价格警报，再明确启用监控。")}<Button variant="ghost" className="text-button" onClick={() => navigate('/notifications')}>{t("配置通知")}</Button></> : settings.enabled ? t("监控已启用。每条警报触发一次，后台运行时无需保持页面打开。") : t("监控已暂停。已有警报不会触发，启用后首次满足条件的新鲜价格也会触发。")}
    </div>
    <p className="history-note" aria-label={t("行情采集模式")}>{modeCopy}</p>
    <p className="history-note">{t("查看市场时每 5 秒更新报价，无需创建警报。后台监控仅采集启用且未锁定规则所需的成交价；参考报价不会触发警报。近期无成交不代表断线。")}</p>
    </Disclosure>
    {!confirm && <FormError message={actionError}/>}
    <DialogPresence present={!!editor}>{editor && <AlertEditor model={model} alert={editor.alert} instrument={selected} {...(editor.threshold !== undefined ? { initialThreshold: editor.threshold } : {})} {...(editor.side ? { initialSide: editor.side } : {})} onClose={() => setEditor(null)} notify={notify}/>}</DialogPresence>
    <DialogPresence present={!!confirm}>{confirm && <Dialog title={confirm.kind === 'disable' ? t("暂停所有监控？") : confirm.kind === 'delete' ? t("删除这条警报？") : confirm.kind === 'retarget' ? t("修改目标价？") : t("重新武装这条警报？")} onClose={() => setConfirm(null)} busy={busy}>
      {confirm.kind === 'retarget' ? <div className="retarget-summary"><p>{t("「{0}」", confirm.alert.name)}</p><div className={`retarget-values ${confirm.alert.side}`}><span><small>{t("原目标价")}</small><s>{formatPrice(confirm.alert.threshold)}</s></span><b aria-hidden="true">→</b><span><small>{t("新目标价")}</small><strong>{formatPrice(confirm.price)}</strong></span></div>{tick && <p className="small muted">{t("距现价")} {((confirm.price - tick.price) / tick.price * 100) >= 0 ? '+' : ''}{((confirm.price - tick.price) / tick.price * 100).toFixed(2)}% · {confirm.alert.side === 'upper' ? t("达到或高于") : t("达到或低于")}</p>}</div>
      : <p>{confirm.kind === 'disable' ? t("暂停后不再触发新通知，并取消仍在队列中的投递。已经开始发送的请求无法撤回，结果可能不确定。") : confirm.kind === 'delete' ? t("将删除「{0}」。历史投递记录由后台保留。", confirm.alert.name) : t("「{0}」将解除触发锁定。之后首次满足条件的新鲜价格会再次触发。", confirm.alert.name)}</p>}
      {retargetHit && <Notice as="p" className="warning">{t("当前新鲜成交价已经满足新的条件，保存后可能立即触发。")}</Notice>}
      {confirm.kind === 'retarget' && confirm.alert.triggered && <Notice as="p" className="warning">{t("此警报已触发。修改目标价不会重新武装，请在列表中明确操作。")}</Notice>}
      {confirm.kind === 'rearm' && confirm.alert.last?.outcome === 'uncertain' && <Notice as="p" className="warning">{t("上次投递结果不确定，可能已经送达。请先查看手机，再决定是否重新武装。")}</Notice>}
      {rearmHit && <Notice as="p" className="warning">{t("当前新鲜成交价已经满足条件，重新武装后可能立即再次触发。")}</Notice>}
      <FormError message={actionError}/><div className="confirm-actions"><Button disabled={busy} onClick={() => setConfirm(null)}>{t("取消")}</Button><Button variant="default" className="primary" disabled={busy} onClick={() => void confirmAction()}>{busy ? t("正在处理…") : confirm.kind === 'disable' ? t("暂停监控") : confirm.kind === 'delete' ? t("删除警报") : confirm.kind === 'retarget' ? t("确认修改") : t("重新武装")}</Button></div>
    </Dialog>}</DialogPresence>
  </section>;
}

function AlertRow({ alert, markets, settingsEnabled, price, busy, error, onSelect, onEdit, onRearm, onDelete }: {
    alert: Alert;
    markets: Market[];
    settingsEnabled: boolean;
    price: number | undefined;
    busy: boolean;
    error: boolean;
    onSelect: () => void;
    onEdit: () => void;
    onRearm: () => void;
    onDelete: () => void;
}) {
    const market = findMarket(markets, alert.instrument);
    const quote = marketQuote(alert.instrument, market);
    const state = alertState(alert);
    return <article className={`alert-row ${alert.triggered ? 'is-triggered' : ''} ${alert.pending ? 'is-pending' : ''}`}>
      <div className="alert-top"><div className="alert-title-block"><strong className="alert-name">{alert.name}</strong><span className={`state-label ${alert.triggered ? 'latched' : ''} ${alert.last?.outcome === 'uncertain' ? 'uncertain' : ''}`}>{!settingsEnabled && !alert.triggered && !alert.pending ? t("总开关关闭") : state}</span></div></div>
      <Button className="instrument-button" onClick={onSelect}>{marketLabel(alert.instrument, market)}</Button>
      <div className={`alert-detail ${alert.side}`}><span>{alert.side === 'upper' ? '↑ ' : '↓ '}{alert.side === 'upper' ? t("达到或高于") : t("达到或低于")}</span><strong>{formatPrice(alert.threshold)} <small>{quote}</small></strong>{price && <span className="alert-distance">{t("距现价")} {((alert.threshold - price) / price * 100) >= 0 ? '+' : ''}{((alert.threshold - price) / price * 100).toFixed(2)}%</span>}</div>
      {alert.pending && <p className="pending-inline">{alert.pending.phase === 'queued' ? t("已排队，等待投递") : t("已开始发送，请勿重复操作")}{t(" · 已尝试 ")}{alert.pending.attempts}{t(" 次")}</p>}
      {alert.triggered && <div className="latch-bar"><span>{t("已触发并锁定；编辑不会解除锁定。")}{alert.last?.outcome === 'uncertain' ? t("可能已经送达，请先查看手机。") : ''}</span><Button className="rearm-button" disabled={busy || !!alert.pending || error} onClick={onRearm}>{t("重新武装")}</Button></div>}
      {!settingsEnabled && !alert.triggered && <p className="pending-inline">{t("总开关关闭时不会触发。")}</p>}
      <div className={`rule-result ${alert.triggered ? 'trigger-result' : ''}`}>{alert.last && <><span className={alert.last.outcome === "uncertain" ? "uncertain" : "muted"}>{outcomeLabels[alert.last.outcome]}</span><time dateTime={new Date(alert.last.at).toISOString()}>{formatTime(alert.last.at)}</time></>}</div>
      <div className="alert-buttons"><Button disabled={busy || !!alert.pending || error} onClick={onEdit}>{t("编辑")}</Button><Button disabled={busy || !!alert.pending || error} onClick={onDelete}>{t("删除")}</Button></div>
    </article>;
}
