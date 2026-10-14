import { t } from './i18n.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Alert, Market, SystemStatus } from '../src/contracts/domain.js';
import { AppError, assertBusinessReady, errorText, getBusinessCooldown, request, subscribeBusinessCooldown } from './api.js';
export interface WorkspaceData {
    status: SystemStatus;
    alerts: Alert[];
    markets: Market[];
    marketStale: boolean;
}
export function useWorkspace(onUnauthorized: () => void) {
    const [data, setData] = useState<WorkspaceData | null>(null);
    const [failure, setFailure] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);
    const [loadedAt, setLoadedAt] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());
    const current = useRef<{
        controller: AbortController;
        promise: Promise<void>;
    } | null>(null);
    const lock = useRef(false);
    const mounted = useRef(true);
    const recoveryAt = useRef(0);
    const unauthorized = useRef(onUnauthorized);
    unauthorized.current = onUnauthorized;
    const read = useCallback((duringMutation = false): Promise<void> => {
        if (!mounted.current || (lock.current && !duringMutation))
            return Promise.resolve();
        if (current.current)
            return current.current.promise;
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
        const promise = (async () => {
            try {
                // Keep the flight until all siblings settle, including a delayed 429 header.
                // Commit a complete snapshot only; concurrent visibility/manual reads join it.
                const results = await Promise.allSettled([
                    request<SystemStatus>('/api/status', 'GET', undefined, { signal: controller.signal }),
                    request<{
                        alerts: Alert[];
                    }>('/api/alerts', 'GET', undefined, { signal: controller.signal }),
                    request<{
                        markets: Market[];
                        stale: boolean;
                    }>('/api/markets', 'GET', undefined, { signal: controller.signal }),
                ]);
                if (!mounted.current || controller.signal.aborted)
                    return;
                const rejected = results.find(result => result.status === 'rejected');
                if (rejected?.status === 'rejected')
                    throw rejected.reason;
                const [status, alerts, markets] = results;
                if (status.status !== 'fulfilled' || alerts.status !== 'fulfilled' || markets.status !== 'fulfilled')
                    return;
                setData({ status: status.value, alerts: alerts.value.alerts, markets: markets.value.markets, marketStale: markets.value.stale });
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
        current.current = { controller, promise };
        return promise;
    }, []);
    const refresh = useCallback(() => read(), [read]);
    useEffect(() => {
        mounted.current = true;
        const onCooldown = (cause: AppError) => { recoveryAt.current = cause.retryAt; setFailure(cause); };
        const unsubscribe = subscribeBusinessCooldown(onCooldown);
        const existing = getBusinessCooldown();
        if (existing && existing.retryAt > Date.now())
            onCooldown(existing);
        void refresh();
        const clock = window.setInterval(() => {
            const time = Date.now();
            setNow(time);
            if (recoveryAt.current && time >= recoveryAt.current && !document.hidden && !lock.current && !current.current) {
                recoveryAt.current = 0;
                void refresh();
            }
        }, 1000);
        const interval = window.setInterval(() => { if (!document.hidden && !lock.current)
            void refresh(); }, 5000);
        const onVisible = () => { if (!document.hidden && !lock.current)
            void refresh(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { mounted.current = false; unsubscribe(); current.current?.controller.abort(); window.clearInterval(interval); window.clearInterval(clock); document.removeEventListener('visibilitychange', onVisible); };
    }, [refresh]);
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
    return { data, error, busy, loadedAt, now, refresh, mutate };
}
export type WorkspaceModel = ReturnType<typeof useWorkspace>;
