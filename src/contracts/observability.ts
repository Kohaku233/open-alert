import type { ComponentHealth } from './domain.js';

export type OperationalState = 'ok' | 'idle' | 'warning' | 'critical' | 'unknown';
export type OperationalComponent = 'database' | 'scheduler' | 'prices' | 'notifications' | 'email' | 'api' | 'cron' | 'queue' | 'monitor';
export interface OperationalIssue { component: OperationalComponent; code: string; severity: 'info' | 'warning' | 'critical' }
export interface OperationalEvent extends OperationalIssue { openedAt: number; lastSeenAt: number; resolvedAt: number | null }
export interface LatencyMetric { count: number; totalMs: number; buckets: number[]; boundsMs: number[] }
export interface SchedulerMetrics {
  ticks: number; tickFailures: number; budgetHits: number; reservations: number;
  attempts: number; sent: number; failed: number; uncertain: number; retries: number; uncommitted: number;
  tickMs: LatencyMetric; deliveryMs: LatencyMetric; triggerToResultMs: LatencyMetric;
}
export interface SqlTelemetry {
  operations: number; errors: number; conflicts: number; rowsRead: number; rowsWritten: number; durationMs: number;
}
export interface QueueTelemetry { queued: number; due: number; sending: number; oldestDueAt: number | null; oldestSendingAt: number | null }
export interface OperationalProbe { at: number; api: ComponentHealth; email: ComponentHealth }
export interface ObservabilitySnapshot {
  observedAt: number; state: OperationalState; expectedIdle: boolean; issues: OperationalIssue[];
  runId: string; startedAt: number; lastPollAt: number | null; lastCronAt: number | null; cronRequired: boolean;
  metrics: SchedulerMetrics; database: SqlTelemetry | null; databaseScope: 'coordinator';
  queue: QueueTelemetry | null;
  sources: { venue: string; type?: string; catalogAt: number | null; catalogCode: string | null; priceCode: string | null; retryAt: number; pollRequests: number; pollFailures: number }[];
  events: OperationalEvent[]; history: { at: number; state: OperationalState; queued: number | null; sending: number | null }[];
  persistence: 'durable' | 'memory'; notifications: 'disabled';
}
