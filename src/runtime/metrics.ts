import type { LatencyMetric, SchedulerMetrics } from '../contracts/observability.js';

export const LATENCY_BOUNDS_MS = [10, 50, 100, 500, 1000, 2500, 5000, 10000, 30000] as const;
const latency = (): LatencyMetric => ({ count: 0, totalMs: 0, buckets: Array.from({ length: LATENCY_BOUNDS_MS.length + 1 }, () => 0), boundsMs:[...LATENCY_BOUNDS_MS] });
export function schedulerMetrics(): SchedulerMetrics {
  return { ticks: 0, tickFailures: 0, budgetHits: 0, reservations: 0, attempts: 0, sent: 0, failed: 0, uncertain: 0, retries: 0, uncommitted: 0, tickMs: latency(), deliveryMs: latency(), triggerToResultMs: latency() };
}
export function observeLatency(metric: LatencyMetric, value: number): void {
  if (!Number.isFinite(value)) return;
  const ms = Math.max(0, value), index = LATENCY_BOUNDS_MS.findIndex(bound => ms <= bound);
  metric.count++; metric.totalMs += ms; metric.buckets[index < 0 ? LATENCY_BOUNDS_MS.length : index]!++;
}
