import type { Alert, PriceTick } from '../src/contracts/domain.js';

export const formatPrice = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 12 }).format(value);
export const formatTime = (value: number | null) => value === null ? '尚无记录' : new Date(value).toLocaleString('zh-CN', { hour12: false });
export function freshTick(tick: PriceTick | undefined, now = Date.now()): tick is PriceTick {
  return !!tick && Number.isFinite(tick.price) && tick.price > 0 && tick.price <= 1e12
    && Number.isFinite(tick.timestamp) && Number.isFinite(tick.receivedAt)
    && tick.timestamp <= now + 5000 && now - tick.timestamp <= 30000
    && tick.receivedAt <= now && now - tick.receivedAt <= 30000;
}
export function breached(side: 'upper' | 'lower', threshold: number, tick: PriceTick | undefined): boolean {
  return freshTick(tick) && (side === 'upper' ? tick.price >= threshold : tick.price <= threshold);
}
export function safeChartSymbol(symbol: string): boolean { return /^OKX:[A-Z0-9]{1,24}USDT\.P$/.test(symbol); }
export const healthLabels = { healthy: '正常', degraded: '受限', unhealthy: '不可用', starting: '启动中' };
export const outcomeLabels = { sent: '已交给 Pushover', failed: '投递失败', expired: '投递已过期', cancelled: '已取消', uncertain: '结果不确定', daily_limit: '达到当日上限' };
export function alertState(alert: Alert): string {
  if (alert.pending?.phase === 'queued') return '通知排队中';
  if (alert.pending?.phase === 'sending') return '正在发送';
  if (alert.triggered) return alert.last ? outcomeLabels[alert.last.outcome] : '已触发';
  return alert.enabled ? '已武装' : '已暂停';
}
