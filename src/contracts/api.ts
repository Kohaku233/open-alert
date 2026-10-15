import type { Alert, ChannelProfile, CreateAlert, Market, PatchAlert, PutChannel, SystemStatus, UserIdentity, UserSettings } from './domain.js';
import type { ObservabilitySnapshot } from './observability.js';

export interface ApiSuccess<T> { ok: true; data: T; requestId: string; effects?: { schedulerWake: 'confirmed' | 'pending' } }
export interface ApiError {
  ok: false;
  error: { code: ApiErrorCode; message: string; fields?: Record<string, string> };
  requestId: string;
}
export type ApiResponse<T> = ApiSuccess<T> | ApiError;
export type ApiErrorCode =
  | 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'generation_conflict' | 'pending_delivery' | 'limit_exceeded' | 'account_exists'
  | 'rate_limited' | 'channel_unconfigured' | 'service_unavailable'
  | 'notification_failed' | 'notification_uncertain' | 'internal_error';
export interface Paginated<T> { items: T[]; cursor: string | null }
export interface InvitationResult {
  id: string; email: string; expiresAt: number; reused: boolean;
  emailDelivery: { status: 'accepted' | 'not_attempted' | 'failed' | 'uncertain'; reason: 'resend_sandbox' | 'existing_invitation' | 'delivery_cooldown' | 'email_rejected' | 'email_unavailable' | 'email_uncertain' | null };
}
export interface InvitationSummary { id: string; email: string; expiresAt: number; status: 'pending' | 'accepted' | 'expired' | 'revoked' }
export interface SessionPrincipal { userId: string; role: 'user' | 'admin'; sessionId: string }
export interface TestNotificationResult { outcome: 'sent'; at: number }
export interface PatchSettings extends Partial<UserSettings> { expectedGeneration: number }
export interface PublicHealth { state: 'healthy' | 'degraded' | 'unhealthy' | 'starting' }
export interface AuthCapabilities {
  google: boolean; emailOtp: boolean; registration: 'invite' | 'open' | 'closed';
  inviteOnly: boolean; emailProvider: 'console' | 'smtp' | 'resend' | 'unconfigured';
  emailSenderMode: 'console' | 'smtp' | 'resend_domain_check' | 'resend_sending_only' | 'resend_sandbox' | 'unconfigured';
}

/** Application routes use this envelope; /api/auth/* retains Better Auth's native API. */
export interface ApiRouteMap {
  'GET /api/auth-capabilities': { request: never; response: AuthCapabilities };
  'GET /api/status': { request: never; response: SystemStatus & { alerts?: Alert[] } };
  'GET /api/markets': { request: never; response: { markets: Market[]; updatedAt: number | null; stale: boolean } };
  'GET /api/alerts': { request: never; response: { alerts: Alert[] } };
  'POST /api/alerts': { request: CreateAlert; response: { alert: Alert } };
  'PATCH /api/alerts/:id': { request: PatchAlert; response: { alert: Alert } };
  'DELETE /api/alerts/:id': { request: { expectedGeneration: number }; response: { deleted: true } };
  'POST /api/alerts/:id/rearm': { request: { expectedGeneration: number }; response: { alert: Alert } };
  'GET /api/channels': { request: never; response: ChannelProfile };
  'PUT /api/channels': { request: PutChannel; response: ChannelProfile };
  'DELETE /api/channels': { request: never; response: ChannelProfile };
  'POST /api/test-notification': { request: { confirm: true }; response: TestNotificationResult };
  'PATCH /api/settings': { request: PatchSettings; response: { settings: UserSettings; generation: number } };
  'GET /api/health': { request: never; response: PublicHealth };
  'GET /api/readiness': { request: never; response: { state: 'ready' | 'not_ready' | 'unknown' } };
  'POST /api/admin/bootstrap': { request: never; response: { bootstrapped: true } };
  'GET /api/admin/users': { request: never; response: Paginated<UserIdentity> };
  'PATCH /api/admin/users/:id': { request: { disabled: boolean }; response: UserIdentity };
  'POST /api/admin/invites': { request: { email: string }; response: InvitationResult };
  'GET /api/admin/invites': { request: never; response: Paginated<InvitationSummary> };
  'POST /api/admin/invites/:id/resend': { request: { expectedExpiresAt: number; confirm: true }; response: InvitationResult };
  'DELETE /api/admin/invites/:id': { request: { expectedExpiresAt: number }; response: { revoked: true } };
  'GET /api/admin/status': { request: never; response: { activeUsers: number; activeAlerts: number; health: SystemStatus['health'] } };
  'GET /api/admin/observability': { request: never; response: ObservabilitySnapshot };
}
export type RouteRequest<K extends keyof ApiRouteMap> = ApiRouteMap[K]['request'];
export type RouteResponse<K extends keyof ApiRouteMap> = ApiResponse<ApiRouteMap[K]['response']>;

/** Auth agent supplies Better Auth, email OTP, Google and server-side session verification. */
export interface AuthService {
  handler(request: Request): Promise<Response>;
  getPrincipal(request: Request): Promise<SessionPrincipal | null>;
}
