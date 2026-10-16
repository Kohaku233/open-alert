import { usePageMotion } from '../motion.js';
import { Panel, PageHeader, PageSkeleton } from '../components/Surface.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { t } from '../i18n.js';
import { useState, useRef } from 'react';
import type { FormEvent } from 'react';
import type { WorkspaceModel } from '../model.js';
import { errorText, request } from '../api.js';
import { formatTime, healthLabels } from '../utils.js';
import { FormError } from '../components/Dialog.js';
export function Account({ model, notify }: {
    model: WorkspaceModel;
    notify: (text: string) => void;
}) {
    const pageRef = useRef<HTMLElement>(null);
    usePageMotion(pageRef, !!model.data, true, 'settings');
    const { data, busy, mutate } = model;
    const [token, setToken] = useState('');
    const [error, setError] = useState('');
    const [setup, setSetup] = useState(false);
    if (!data)
        return <PageSkeleton title={t("我的账户")} label={t("正在读取账户信息…")} error={model.error}/>;
    async function bootstrap(event: FormEvent) {
        event.preventDefault();
        if (busy || !token)
            return;
        setError('');
        const onceToken = token.trim();
        setToken('');
        try {
            await mutate(() => request<{
                bootstrapped: true;
            }>('/api/admin/bootstrap', 'POST', undefined, { bearer: onceToken }));
            setSetup(false);
            notify(t("初始管理员已设置。"));
        }
        catch (cause) {
            setError(errorText(cause));
        }
    }
    const components = [['database', t("数据库")], ['scheduler', t("后台监控")], ['prices', t("交易所行情")], ['notifications', t("通知服务")], ['email', t("邮件服务")]] as const;
    return <section ref={pageRef} className="settings-page"><PageHeader className="page-heading"><div><h1>{t("我的账户")}</h1><p>{t("账户身份、配额与后台运行状态。")}</p></div></PageHeader><div className="settings-grid"><Panel className="settings-panel"><h2>{t("账户信息")}</h2><dl className="key-state"><div><dt>{t("邮箱")}</dt><dd>{data.status.user.email}</dd></div><div><dt>{t("名称")}</dt><dd>{data.status.user.name || t("尚未设置")}</dd></div><div><dt>{t("角色")}</dt><dd>{data.status.user.role === 'admin' ? t("管理员") : t("普通用户")}</dd></div><div><dt>{t("监控")}</dt><dd>{data.status.settings.enabled ? t("已启用") : t("已暂停")}</dd></div><div><dt>{t("今日通知尝试")}</dt><dd>{data.status.daily.attempts} / {data.status.daily.limit}</dd></div></dl><p className="small muted">{t("仅显示你自己的警报、行情与通知设置。每日配额按 UTC 日期计算。")}</p>
      {data.status.user.role !== 'admin' && <div className="bootstrap-section"><Button variant="ghost" className="text-button" onClick={() => setSetup(value => !value)}>{t("设置初始管理员")}</Button>{setup && <form onSubmit={event => void bootstrap(event)}><p className="small muted">{t("仅供首次部署且尚无管理员时使用。需已验证的登录账户与部署者持有的一次性引导令牌。")}</p><Label>{t("一次性引导令牌")}<Input type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" required minLength={32} value={token} onChange={event => setToken(event.target.value)}/></Label><Button variant="default" className="primary" disabled={busy || !!model.error}>{busy ? t("正在设置…") : t("设为初始管理员")}</Button><FormError message={error}/></form>}</div>}
    </Panel><Panel className="settings-panel"><h2>{t("后台运行状态")}</h2><div className="runtime-health">{components.map(([key, label]) => { const health = data.status.health[key]; return <div className="health-row" key={key}><span>{label}</span><span className={health.state === 'healthy' ? 'success-text' : 'amber-text'}>{healthLabels[health.state]}</span><small>{t("最近成功：")}{formatTime(health.lastSuccessAt)}{health.code ? ` · ${health.code}` : ''}</small></div>; })}</div><p className="small muted">{t("最近行情轮询：")}{formatTime(data.status.scheduler.lastPollAt)}{t("。目标间隔约 5 秒，网络与调度延迟可能影响实际周期。")}</p><p className="small muted">{t("行情缺失或超过 30 秒时停止触发。通知结果不确定时保持锁定，不会自动重发。")}</p></Panel></div>
  </section>;
}
