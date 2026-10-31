import { useSyncExternalStore } from 'react';
import type { WorkspaceData } from './model.js';

/** Server default for config.limits.alertsPerUser, used until /api/account has been read. */
const DEFAULT_ALERT_LIMIT = 20;
let accountAlertLimit: number | null | undefined;
const listeners = new Set<() => void>();

/** Called by the settings page after it reads /api/account; no extra request is made here. */
export function rememberAlertLimit(limit: number | null): void {
    if (limit === accountAlertLimit) return;
    accountAlertLimit = limit;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Per-user alert limit; null means unlimited (administrators). */
export function useAlertLimit(data: WorkspaceData | null): number | null {
    const cached = useSyncExternalStore(subscribe, () => accountAlertLimit, () => accountAlertLimit);
    if (data?.status.user.role === 'admin' && data.status.capabilities.canAdmin) return null;
    return cached === undefined ? DEFAULT_ALERT_LIMIT : cached;
}
