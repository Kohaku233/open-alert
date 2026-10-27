import { t } from './i18n.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Alert, Market, SystemStatus } from '../src/contracts/domain.js';
import { AppError, assertBusinessReady, errorText, getBusinessCooldown, request, subscribeBusinessCooldown, subscribeSchedulerWake } from './api.js';
import { isRealtimeConnected, subscribeAlertChanges } from './realtime.js';
export interface WorkspaceData {
    status: SystemStatus;
    alerts: Alert[];
    markets: Market[];
    marketStale: boolean;
}
interface CatalogData { markets: Market[]; stale: boolean }
export function useWorkspace(onUnauthorized: () => void) {
    const [data, setData] = useState<WorkspaceData | null>(null);
    const [failure, setFailure] = useState<unknown>(null);
    const [wakePending, setWakePending] = useState(false);
    const [busy, setBusy] = useState(false);
    const [loadedAt, setLoadedAt] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());
    const current = useRef<{
        controller: AbortController;
        promise: Promise<void>;
        catalogRequested: boolean;
    } | null>(null);
    const lock = useRef(false);
    const mounted = useRef(true);
    const recoveryAt = useRef(0);
    const unauthorized = useRef(onUnauthorized);
    const catalog = useRef<CatalogData | null>(null);
    unauthorized.current = onUnauthorized;
    const read = useCallback((duringMutation = false, forceCatalog = false): Promise<void> => {
        if (!mounted.current || (lock.current && !duringMutation))
            return Promise.resolve();
        if (current.current) {
            const flight = current.current;
            // An explicit directory refresh must not disappear into an ongoing
            // status-only poll. Coalesce callers once that poll has settled.
            return forceCatalog && !flight.catalogRequested
                ? flight.promise.then(() => read(duringMutation, true)) : flight.promise;
        }
        // Admit the whole snapshot once; do not start three rejected promises in cooldown.
        try {
            assertBusinessReady();
        }
        catch (cause) {
            setFailure(cause);
            return Promise.resolve();
        }
        // An admitted manual/poll read also satisfies pending expiry recovery.
        recoveryAt.current = 0;
        const controller = new AbortController();
        const cachedCatalog = catalog.current;
        const fetchCatalog = forceCatalog || !cachedCatalog;
        const promise = (async () => {
            try {
                // Keep the flight until all siblings settle, including a delayed 429 header.
                // Status and alerts form one snapshot. Directory metadata may be
                // retained, explicitly stale, when only its transport fails.
                const statusRead = request<SystemStatus & { alerts?: Alert[] }>('/api/status?include=alerts', 'GET', undefined, { signal: controller.signal });
                const alertsRead = statusRead.then(status => Array.isArray(status.alerts)
                    ? { alerts: status.alerts }
                    : request<{ alerts: Alert[] }>('/api/alerts', 'GET', undefined, { signal: controller.signal }));
                const results = await Promise.allSettled([
                    statusRead,
                    alertsRead,
                    fetchCatalog ? request<CatalogData>('/api/markets', 'GET', undefined, { signal: controller.signal })
                        : Promise.resolve(cachedCatalog!),
                ]);
                if (!mounted.current || controller.signal.aborted)
                    return;
                // Retain a successful directory even if a sibling status read
                // failed; its recovery must not download the directory again.
                if (fetchCatalog && results[2].status === 'fulfilled')
                    catalog.current = results[2].value;
                const rejected = results.find((result, index) => result.status === 'rejected' &&
                    (index !== 2 || !cachedCatalog || !(result.reason instanceof AppError) ||
                        !(result.reason.status >= 500 || ['network_error', 'invalid_response'].includes(result.reason.code))));
                if (rejected?.status === 'rejected')
                    throw rejected.reason;
                const [status, alerts, markets] = results;
                if (status.status !== 'fulfilled' || alerts.status !== 'fulfilled')
                    return;
                let directory: CatalogData;
                if (markets.status === 'fulfilled') {
                    directory = markets.value;
                    // A loaded directory belongs to this workspace session.
                    // Polling, focus recovery and mutations reuse it; only an
                    // explicit refresh or a new page load requests it again.
                } else {
                    directory = { ...cachedCatalog!, stale: true };
                    catalog.current = directory;
                }
                setData({ status: status.value, alerts: alerts.value.alerts, markets: directory.markets, marketStale: directory.stale });
                // A successful runtime snapshot reconciles the durable alarm after a lost wake.
                setWakePending(false);
                // A separate business request may have received 429 while this snapshot ran.
                const cooldown = getBusinessCooldown();
                if (!cooldown || cooldown.retryAt <= Date.now())
                    setFailure(null);
                setLoadedAt(Date.now());
            }
            catch (cause) {
                if (!mounted.current || controller.signal.aborted)
                    return;
                setFailure(cause);
                if (cause instanceof AppError && cause.status === 401)
                    unauthorized.current();
                if (cause instanceof AppError && cause.status === 403)
                    setData(null);
            }
            finally {
                if (current.current?.controller === controller)
                    current.current = null;
            }
        })();
        current.current = { controller, promise, catalogRequested: fetchCatalog };
        return promise;
    }, []);
    const refresh = useCallback(() => read(false, true), [read]);
    useEffect(() => {
        mounted.current = true;
        const onCooldown = (cause: AppError) => { recoveryAt.current = cause.retryAt; setFailure(cause); };
        const unsubscribe = subscribeBusinessCooldown(onCooldown);
        const unsubscribeWake = subscribeSchedulerWake(state => setWakePending(state === 'pending'));
        const existing = getBusinessCooldown();
        if (existing && existing.retryAt > Date.now())
            onCooldown(existing);
        void read();
        const clock = window.setInterval(() => {
            const time = Date.now();
            setNow(time);
            if (recoveryAt.current && time >= recoveryAt.current && !document.hidden && !lock.current && !current.current) {
                recoveryAt.current = 0;
                void read();
            }
        }, 1000);
        // Pushed `changed` frames make status reads event-driven. While the socket
        // is up a 30 s read only reconciles health/quota; otherwise poll every 5 s.
        let lastRead = Date.now();
        const pushed = () => { if (!lock.current) { lastRead = Date.now(); void read(); } };
        const unsubscribeChanges = subscribeAlertChanges(pushed);
        const interval = window.setInterval(() => {
            if (document.hidden || lock.current || Date.now() - lastRead < (isRealtimeConnected() ? 30000 : 5000) - 50)
                return;
            lastRead = Date.now();
            void read();
        }, 5000);
        const onVisible = () => { if (!document.hidden && !lock.current)
            void read(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { mounted.current = false; unsubscribe(); unsubscribeWake(); unsubscribeChanges(); current.current?.controller.abort(); window.clearInterval(interval); window.clearInterval(clock); document.removeEventListener('visibilitychange', onVisible); };
    }, [read]);
    const mutate = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
        if (!mounted.current)
            throw new DOMException('Workspace unmounted', 'AbortError');
        if (lock.current)
            throw new AppError('busy', t("上一项操作尚未完成，请稍候。"));
        // Check before invoking any callback, including actions that bypass request().
        assertBusinessReady();
        lock.current = true;
        setBusy(true);
        try {
            // Finish the admitted read instead of aborting it and losing a 429 response.
            await current.current?.promise;
            if (!mounted.current)
                throw new DOMException('Workspace unmounted', 'AbortError');
            assertBusinessReady();
            const result = await action();
            await read(true);
            return result;
        }
        catch (cause) {
            // CAS errors need a fresh generation. Other failures wait for normal polling;
            // in particular a 429 must never trigger a follow-up burst or replay the action.
            if (mounted.current && cause instanceof AppError) {
                if (cause.code === 'generation_conflict')
                    await read(true);
                if (cause.status === 401)
                    unauthorized.current();
            }
            throw cause;
        }
        finally {
            lock.current = false;
            if (mounted.current)
                setBusy(false);
        }
    }, [read]);
    const error = failure ? errorText(failure, now) : '';
    return { data, error, wakePending, busy, loadedAt, now, refresh, mutate };
}
export type WorkspaceModel = ReturnType<typeof useWorkspace>;
