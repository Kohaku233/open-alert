import { Spinner } from './ui/spinner.js';
import { Notice } from './Surface.js';
import { Switch } from './ui/switch.js';
import { useMarketQuote } from '../useMarketQuote.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';
import { t } from '../i18n.js';
import { DocsLink } from './DocsLink.js';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Alert } from '../../src/contracts/domain.js';
import { api, errorText } from '../api.js';
import { breached, formatPrice, formatQuotePrice, freshTick } from '../utils.js';
import { findMarket, marketLabel, marketQuote, sameMarket, selectableMarket, useRetainedMarket } from '../markets.js';
import type { WorkspaceModel } from '../model.js';
import { Dialog, FormError } from './Dialog.js';
import { MarketPicker } from './MarketPicker.js';
export function AlertEditor({ model, alert, instrument, initialThreshold, initialSide, onClose, notify }: {
    model: WorkspaceModel;
    alert: Alert | null;
    instrument: string;
    /** Prefill from a chart price for a new alert; the caller derives direction from the live price. */
    initialThreshold?: number;
    initialSide?: 'upper' | 'lower';
    onClose: () => void;
    notify: (text: string) => void;
}) {
    const { data, busy, mutate } = model;
    const [name, setName] = useState(alert?.name ?? '');
    const [selected, setSelected] = useState(alert?.instrument ?? instrument);
    const [side, setSide] = useState<'upper' | 'lower'>(alert?.side ?? initialSide ?? 'upper');
    const [threshold, setThreshold] = useState(alert ? String(alert.threshold) : initialThreshold !== undefined ? String(initialThreshold) : '');
    const [enabled, setEnabled] = useState(alert?.enabled ?? true);
    const [error, setError] = useState('');
    const market = useRetainedMarket(data?.markets ?? [], selected);
    const available = selectableMarket(findMarket(data?.markets ?? [], selected));
    const unchangedMarket = !!alert && sameMarket(alert.instrument, selected);
    const canSaveMarket = available || (unchangedMarket && (!enabled || alert?.enabled === enabled));
    const quote = marketQuote(selected, market);
    const quoteState = useMarketQuote(selected, available);
    const viewed = quoteState.quote;
    const tick = viewed?.timestamp ? { instrument: selected, price: viewed.price, timestamp: viewed.timestamp, receivedAt: viewed.observedAt } : data?.status.prices.find(price => sameMarket(price.instrument, selected));
    const distance = tick && parsedValue(threshold) ? (Number(threshold) / tick.price - 1) * 100 : null;
    const current = alert ? data?.alerts.find(item => item.id === alert.id) : null;
    const pending = !!current?.pending;
    const parsedThreshold = Number(threshold);
    const hit = threshold.trim() !== '' && Number.isFinite(parsedThreshold) && parsedThreshold > 0 && parsedThreshold <= 1e12 && breached(side, parsedThreshold, tick);
    async function save(event: FormEvent) {
        event.preventDefault();
        if (!data || busy || pending || model.error)
            return;
        const value = Number(threshold);
        if (!name.trim() || [...name.trim()].length > 80 || !Number.isFinite(value) || value <= 0 || value > 1e12 || !canSaveMarket) {
            setError(t("请填写有效名称、大于零的价格，并选择可用市场。"));
            return;
        }
        if (alert && current?.generation !== alert.generation) {
            setError(t("警报已在其他页面更新，请关闭窗口后重新打开。"));
            return;
        }
        setError('');
        try {
            const fields = { name: name.trim(), side, threshold: value };
            await mutate(() => alert ? api('PATCH /api/alerts/:id', { ...fields, ...(enabled !== alert.enabled ? { enabled } : {}), ...(!unchangedMarket ? { instrument: selected } : {}), expectedGeneration: alert.generation }, alert.id) : api('POST /api/alerts', { ...fields, enabled, instrument: selected }));
            notify(alert ? t("警报已保存；已触发的警报仍保持锁定。") : t("警报已创建。"));
            onClose();
        }
        catch (cause) {
            setError(errorText(cause));
        }
    }
    return <Dialog className="alert-editor-dialog" eyebrow={alert ? 'EDIT RULE' : 'NEW RULE'} title={alert ? t("编辑价格警报") : t("创建价格警报")} onClose={onClose} busy={busy}>
    <form className="alert-editor-form" onSubmit={event => void save(event)}><fieldset className="alert-editor-fields" disabled={busy || pending || !!model.error}>
      <MarketPicker labelOutside compact label={t("警报市场")} markets={data?.markets ?? []} value={selected} onChange={setSelected} disabled={busy || pending || !!model.error} stale={data?.marketStale ?? false} error={model.error} onRetry={() => void model.refresh()}/>
      <p className="small muted rule-market-note">{t("始终按这里保存的交易所和市场判断，与当前参考图表选择无关。")}</p>
      <Label>{t("警报名称")}<Input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder={t("例如：突破前高")} autoFocus/></Label>
      <div className="alert-condition"><span className="field-label">{t("触发条件")}</span><div className="direction-segments" role="group" aria-label={t("触发条件")}>{(['upper', 'lower'] as const).map(value => <Button key={value} type="button" aria-pressed={side === value} onClick={() => setSide(value)} className={value}>{value === 'upper' ? '↑ ' : '↓ '}{value === 'upper' ? t("达到或高于") : t("达到或低于")}</Button>)}</div></div>
      <div className="threshold-field"><Label className="threshold-label">{t("价格 · ")}{quote}<span className="threshold-control"><Input className="threshold-input" type="number" min="0" max="1000000000000" step="any" required value={threshold} onChange={event => setThreshold(event.target.value)} placeholder={tick ? formatQuotePrice(tick.price) : '0.00'}/><span className="mobile-threshold-unit">{quote}</span></span></Label><div className="price-shortcuts desktop-price-shortcuts">{[-1, 1, 5].map(percent => <Button type="button" key={percent} disabled={!freshTick(tick)} onClick={() => { if (tick) setThreshold(String(Number((tick.price * (1 + percent / 100)).toPrecision(12)))); }}>{percent > 0 ? '+' : ''}{percent}%</Button>)}</div></div>
      {distance !== null && <div className="threshold-distance"><div className="distance-track"><i style={{left: `${Math.max(10, Math.min(94, 69 + distance * 6))}%`}}/></div><div className="distance-labels"><span>{t('现价')} {tick && formatQuotePrice(tick.price)}</span><strong>{distance >= 0 ? '↑ +' : '↓ '}{distance.toFixed(2)}%</strong></div></div>}
      <div className="price-shortcuts mobile-price-shortcuts">{[-5, -1, 1, 5].map(percent => <Button type="button" key={percent} disabled={!freshTick(tick)} onClick={() => { if (tick) setThreshold(String(Number((tick.price * (1 + percent / 100)).toPrecision(12)))); }}>{percent > 0 ? '+' : ''}{percent}%</Button>)}</div>
      <Label className="check-label enable-rule"><span>{t("启用这条警报")}</span><Switch checked={enabled} onCheckedChange={setEnabled} disabled={busy || pending || !!model.error} aria-label={t("启用这条警报")}/></Label>

    </fieldset>
    {!available && unchangedMarket && <Notice as="p" className="warning">{t("原警报市场当前不可用。可保留原市场修改其他设置或暂停警报。重新启用前需选择可用市场；保存不会自动更换市场。")}</Notice>}
    {pending && <Notice as="p" className="warning">{t("该警报的通知正在排队或发送，请等待完成后再修改。")}</Notice>}
    {hit && enabled && <Notice as="p" className="warning">{marketLabel(selected, market)}{t(" 当前新鲜成交价 ")}{tick ? formatQuotePrice(tick.price) : ''} {quote}{t(" 已满足条件。保存后首次收到满足条件的新鲜价格可能立即触发。")}</Notice>}
    {!freshTick(tick) && <p className="small muted">{t("当前没有可用的新鲜后台价格。恢复行情后，首次满足条件的价格也会触发。")}</p>}
    {alert?.triggered && <Notice as="p" className="warning">{t("此警报已触发。编辑价格或启用状态不会重新武装，请在列表中明确操作。")}</Notice>}
    {!data?.status.settings.enabled && <p className="small muted">{t("你的监控总开关目前关闭。保存后需在仪表盘明确启用监控。")}</p>}
    <p className="small muted">{t("每条警报触发一次，包含恰好达到阈值。图表画线不会创建手机警报。")} <DocsLink path="/alerts/how-it-works/">{t("触发规则")}</DocsLink></p>
    <FormError message={error || model.error}/><Button variant="default" className="primary wide" disabled={busy || pending || !data || !canSaveMarket || !!model.error}>{busy && <Spinner/>}{busy ? t("正在保存…") : alert ? t("保存警报") : t("创建警报")}</Button></form>
  </Dialog>;
}

function parsedValue(value: string) { return value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) > 0; }
