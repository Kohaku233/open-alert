import type { D1Database, DurableObjectNamespace, Fetcher } from '@cloudflare/workers-types';
import type { AppConfig } from '../config.js';
import type { AlertInput, EncryptedSecret, EpochMs, Id, NotificationOptions, PriceTick, UserSettings } from './domain.js';

export type SqlValue = string | number | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;
export interface SqlStatement { sql: string; params?: readonly SqlValue[] }
export interface SqlDatabase {
  readonly driver: 'sqlite' | 'postgres' | 'd1';
  /** Canonical SQL uses positional ? bindings. Rows normalize PG bigint to safe JS numbers. */
  query<T extends object = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  execute(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  /** All-or-nothing, same DB, ordered statements; zero changed rows does not abort. */
  atomic(statements: readonly SqlStatement[]): Promise<number[]>;
  /** Roll back all statements if any expectedChanges mismatches. D1 uses CHECK assertions inside its batch. */
  atomicCAS(statements: readonly (SqlStatement & { expectedChanges?: number })[]): Promise<boolean>;
  close(): Promise<void>;
}
export interface CloudflareBindings {
  DB: D1Database;
  COORDINATOR: DurableObjectNamespace;
  ASSETS?: Fetcher;
  [name: string]: unknown;
}
export type DbEnvironment =
  | { deployment: 'node' }
  | { deployment: 'cloudflare'; bindings: CloudflareBindings };
/** Implementation is owned by the adapter agent; this is its required signature. */
export type CreateDb = (config: AppConfig, environment: DbEnvironment) => Promise<SqlDatabase>;

export interface AlertRecord extends AlertInput {
  id: Id;
  userId: Id;
  generation: number;
  triggered: boolean;
  triggerId: Id | null;
  pendingTriggerId: Id | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  deletedAt: EpochMs | null;
}
/** Joined scheduling snapshot: no credentials or per-user hydration required. */
export interface SchedulableAlertRecord extends AlertRecord {
  settingsGeneration: number;
  channelGeneration: number;
  hasPrivateAppToken: boolean;
}
export interface UserSettingsRecord extends UserSettings {
  userId: Id;
  generation: number;
  disabled: boolean;
}
export interface ChannelRecord {
  userId: Id;
  generation: number;
  userKey: EncryptedSecret;
  privateAppToken: EncryptedSecret | null;
  updatedAt: EpochMs;
}
export interface SchedulerLease {
  id: 'coordinator-v1';
  ownerId: Id;
  fence: number;
  expiresAt: EpochMs;
}
export interface TriggerReservation {
  triggerId: Id;
  alertId: Id;
  userId: Id;
  generation: number;
  settingsGeneration: number;
  channelGeneration: number;
  tick: PriceTick;
  now: EpochMs;
  lease: SchedulerLease;
}
export interface OutboxRecord {
  triggerId: Id;
  alertId: Id;
  userId: Id;
  generation: number;
  channelGeneration: number;
  settingsGeneration: number;
  instrument: string;
  name: string;
  side: 'upper' | 'lower';
  threshold: number;
  price: number;
  timestamp: EpochMs;
  notification: NotificationOptions;
  phase: 'queued' | 'sending' | 'sent' | 'failed' | 'expired' | 'cancelled' | 'uncertain' | 'daily_limit';
  attempts: number;
  nextAt: EpochMs;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  claimId: Id | null;
  claimFence: number | null;
  receipt: EncryptedSecret | null;
  code: string | null;
}

export interface AlertRepository {
  listForUser(userId: Id): Promise<AlertRecord[]>;
  getForUser(userId: Id, alertId: Id): Promise<AlertRecord | null>;
  /** Indexed enabled, unlatched active rules; never scan all users each 5-second poll. */
  listActive(limit: number, cursor?: string): Promise<{ items: AlertRecord[]; cursor: string | null }>;
  /** Same active keyset as listActive, with joined revisions/token availability. */
  listActiveWithProfiles(limit: number, cursor?: string): Promise<{ items: SchedulableAlertRecord[]; cursor: string | null }>;
  /** Limits checked atomically; userId always comes from verified server session. */
  create(userId: Id, input: AlertInput, now: EpochMs): Promise<AlertRecord>;
  /** CAS edit increments generation, preserves latch; pending causes conflict. */
  patch(userId: Id, alertId: Id, expectedGeneration: number, patch: Partial<AlertInput>, now: EpochMs): Promise<AlertRecord>;
  remove(userId: Id, alertId: Id, expectedGeneration: number, now: EpochMs): Promise<void>;
  rearm(userId: Id, alertId: Id, expectedGeneration: number, now: EpochMs): Promise<AlertRecord>;
  /** Reservation + matching INSERT SELECT outbox in one atomic DB batch. */
  reserveTrigger(input: TriggerReservation): Promise<boolean>;
}
export interface SchedulerRepository {
  /** SQL EXISTS only: schedulable rules with credentials, or queued/sending outbox. */
  hasWork(sharedAppTokenAvailable: boolean): Promise<boolean>;
  /** Acquire after expiry with incremented fence; renew only matching owner+fence. */
  acquireLease(ownerId: Id, now: EpochMs, durationMs: number): Promise<SchedulerLease | null>;
  renewLease(lease: SchedulerLease, now: EpochMs, durationMs: number): Promise<SchedulerLease | null>;
  releaseLease(lease: SchedulerLease, now: EpochMs): Promise<void>;
  /** Indexed queued + nextAt query; keyset pagination, bounded batches. */
  listDue(now: EpochMs, limit: number, cursor?: { nextAt: EpochMs; triggerId: Id }): Promise<OutboxRecord[]>;
  /** CAS phase+claim, generation, settings/channel revisions, lease fence and atomic UTC quota. */
  claimDelivery(triggerId: Id, claimId: Id, lease: SchedulerLease, now: EpochMs): Promise<OutboxRecord | null>;
  finishDelivery(triggerId: Id, claimId: Id, lease: SchedulerLease, outcome: OutboxRecord['phase'], code: string | null, receipt: EncryptedSecret | null, now: EpochMs): Promise<boolean>;
  /** Previous-owner sending events become uncertain, remain latched, never auto-resend. */
  recoverInterrupted(lease: SchedulerLease, now: EpochMs): Promise<number>;
}
export class RepositoryConflict extends Error {
  constructor(public readonly code: 'generation_conflict' | 'pending_delivery' | 'limit_exceeded' | 'not_found') {
    super(code);
    this.name = 'RepositoryConflict';
  }
}

export interface SettingsRepository {
  get(userId: Id): Promise<UserSettingsRecord | null>;
  /** Initializes only an existing auth user; disabled by default. */
  initialize(userId: Id, now: EpochMs): Promise<UserSettingsRecord>;
  patch(userId: Id, expectedGeneration: number, patch: Partial<UserSettings>, now: EpochMs): Promise<UserSettingsRecord>;
  dailyUsage(userId: Id, now: EpochMs): Promise<{ date: string; attempts: number }>;
}
export interface ChannelRepository {
  get(userId: Id): Promise<ChannelRecord | null>;
  /** Null expectedGeneration means absent; omitted private token retains the prior value. */
  put(userId: Id, expectedGeneration: number | null, userKey: EncryptedSecret, privateAppToken: EncryptedSecret | null | undefined, now: EpochMs): Promise<ChannelRecord>;
  remove(userId: Id, expectedGeneration: number, now: EpochMs): Promise<void>;
}
export interface InvitationRecord { id: Id; email: string; expiresAt: EpochMs; consumedBy: Id | null; consumedAt: EpochMs | null }
export interface AdministrationRepository {
  bootstrap(userId: Id, now: EpochMs): Promise<boolean>;
  listUsers(limit: number, cursor?: string): Promise<{ items: import('./domain.js').UserIdentity[]; cursor: string | null }>;
  setDisabled(userId: Id, disabled: boolean, now: EpochMs): Promise<import('./domain.js').UserIdentity>;
  createInvitation(email: string, expiresAt: EpochMs, now: EpochMs): Promise<InvitationRecord & { reused: boolean }>;
  getInvitation(email: string, now: EpochMs): Promise<InvitationRecord | null>;
  consumeInvitation(id: Id, userId: Id, now: EpochMs): Promise<boolean>;
  counts(): Promise<{ activeUsers: number; activeAlerts: number }>;
}
export interface TestDeliveryRecord {
  id: Id; userId: Id; channelGeneration: number; settingsGeneration: number;
  claimId: Id; phase: 'sending' | 'sent' | 'failed' | 'uncertain';
  createdAt: EpochMs; updatedAt: EpochMs; code: string | null;
}
export interface TestNotificationRepository {
  /** Allocates a trusted ID, consumes user/global daily quota once, commits before dispatch. */
  claim(userId: Id, channelGeneration: number, settingsGeneration: number, now: EpochMs): Promise<TestDeliveryRecord | null>;
  finish(userId: Id, id: Id, claimId: Id, outcome: 'sent' | 'failed' | 'uncertain', code: string | null, now: EpochMs): Promise<boolean>;
  recoverInterrupted(now: EpochMs): Promise<number>;
}
export interface Repositories {
  alerts: AlertRepository; scheduler: SchedulerRepository; settings: SettingsRepository;
  channels: ChannelRepository; admin: AdministrationRepository; tests: TestNotificationRepository;
  outbox: { lastForAlert(userId: Id, alertId: Id): Promise<OutboxRecord | null>; getForUser(userId: Id, triggerId: Id): Promise<OutboxRecord | null>; listForUser(userId: Id, limit: number, cursor?: string): Promise<{ items: OutboxRecord[]; cursor: string | null }> };
}
