import { t } from './i18n.js';
import { getLanguage } from './i18n.js';
import type { Alert, PriceTick } from '../src/contracts/domain.js';
export const formatPrice = (value: number) => new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: 12 }).format(value);
/** Human-readable quotes; this never changes saved thresholds or evaluated prices. */
export const formatQuotePrice = (value: number) => new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: Math.abs(value) >= 1000 ? 2 : Math.abs(value) >= 1 ? 4 : 12 }).format(value);
export const formatQuoteDelta = (value: number) => formatQuotePrice(Number(value.toPrecision(8)));
export const formatTime = (value: number | null) => value === null ? t("尚无记录") : new Date(value).toLocaleString(getLanguage(), { hour12: false });
export function freshTick(tick: PriceTick | undefined, now = Date.now()): tick is PriceTick {
    return !!tick && Number.isFinite(tick.price) && tick.price > 0 && tick.price <= 1e12
        && Number.isFinite(tick.timestamp) && Number.isFinite(tick.receivedAt)
        && tick.timestamp <= now + 5000 && now - tick.timestamp <= 30000
        && tick.receivedAt <= now && now - tick.receivedAt <= 30000;
}
export function breached(side: 'upper' | 'lower', threshold: number, tick: PriceTick | undefined): boolean {
    return freshTick(tick) && (side === 'upper' ? tick.price >= threshold : tick.price <= threshold);
}
export { verifiedChartSymbol as safeChartSymbol } from './markets.js';
export const healthLabels = { get healthy() {
        return t("正常");
    }, get degraded() {
        return t("受限");
    }, get unhealthy() {
        return t("不可用");
    }, get starting() {
        return t("启动中");
    } };
export const outcomeLabels = { get sent() {
        return t("已交给 Pushover");
    }, get failed() {
        return t("投递失败");
    }, get expired() {
        return t("投递已过期");
    }, get cancelled() {
        return t("已取消");
    }, get uncertain() {
        return t("结果不确定");
    }, get daily_limit() {
        return t("达到当日上限");
    } };
export function alertState(alert: Alert): string {
    if (alert.pending?.phase === 'queued')
        return t("通知排队中");
    if (alert.pending?.phase === 'sending')
        return t("正在发送");
    if (alert.triggered)
        return alert.last ? outcomeLabels[alert.last.outcome] : t("已触发");
    return alert.enabled ? t("已武装") : t("已暂停");
}
