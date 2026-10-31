import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceModel } from '../model.js';
import type { AccountOverview } from '../../src/contracts/access.js';
import { Preferences } from '../components/Preferences.js';
import { usePageMotion } from '../motion.js';
import { Panel, PageHeader, ListSkeleton } from '../components/Surface.js';
import { Button } from '../components/ui/button.js';
import { Badge } from '../components/ui/badge.js';
import { FormError } from '../components/Dialog.js';
import { errorText, request } from '../api.js';
import { t } from '../i18n.js';
import { DOCS_ORIGIN, DocsLink } from '../components/DocsLink.js';

export function Account({ model, navigate, logout, logoutBusy }: {
  model: WorkspaceModel; notify: (text: string) => void; navigate: (path: string) => void;
  logout: () => void; logoutBusy: boolean;
}) {
  const root=useRef<HTMLElement>(null);
  const [overview,setOverview]=useState<AccountOverview|null>(null);
  const [loading,setLoading]=useState(true),[error,setError]=useState('');
  usePageMotion(root,!!model.data,true,'settings');
  const load=useCallback(async(signal?:AbortSignal)=>{
    setLoading(true);setError('');
    try { const value=await request<AccountOverview>('/api/account','GET',undefined,signal?{signal}:{});if(!signal?.aborted)setOverview(value); }
    catch(cause){if(!signal?.aborted)setError(errorText(cause));}
    finally{if(!signal?.aborted)setLoading(false);}
  },[]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);return()=>controller.abort();},[load]);
  const user=overview?.user??model.data?.status.user;
  const admin=user?.role==='admin'&&model.data?.status.capabilities.canAdmin;
  const capabilities=model.data?.status.capabilities;
  const usage=overview?.usage,limits=overview?.access.limits;
  const metrics=usage&&limits?[
    [t('价格警报'),usage.alerts,limits.alerts],
    [t('监控市场'),usage.instruments,limits.instruments],
    [t('通知渠道'),usage.channels,limits.channels],
    [t('标的收藏'),usage.favorites,limits.favorites],
    [t('今日价格警报投递尝试'),usage.priceAttempts,limits.priceAttemptsPerDay],
  ] as const:[];
  return <section ref={root} className="settings-page product-settings-page">
    <PageHeader className="page-heading"><div><span className="page-index">04 — SETTINGS</span><h1>{t('设置')}</h1></div></PageHeader>
    <div className="settings-grid product-settings-grid">
      <Panel className="settings-panel settings-identity"><span className="section-index">01 — ACCOUNT</span><h2>{t('账户信息')}</h2>
        <div className="settings-user"><span className="settings-avatar" aria-hidden="true">{(user?.name||user?.email||'O')[0]?.toUpperCase()}</span><div><strong>{user?.name||user?.email?.split('@')[0]||'—'}</strong><small>{user?.email??'—'}</small></div></div>
        <dl className="settings-details"><div><dt>{t('账户角色')}</dt><dd>{user?.role==='admin'?t('管理员'):t('成员')}</dd></div>
          <div><dt>{t('可用登录方式')}</dt><dd>{[capabilities?.emailOtp?t('邮箱验证码'):null,capabilities?.google?'Google':null].filter(Boolean).join(' · ')||'—'}</dd></div></dl>
        <div className="settings-account-actions"><Button disabled={logoutBusy} loading={logoutBusy} onClick={logout}>{logoutBusy?t('正在退出…'):t('退出登录')}</Button>
          {admin&&<Button className="mobile-admin-link" onClick={()=>navigate('/admin')}>{t('进入管理台')} ↗</Button>}
          <Button asChild className="mobile-docs-link"><a href={DOCS_ORIGIN+'/'} target="_blank" rel="noopener">{t('使用文档')} ↗<span className="sr-only">{t('（在新标签页打开）')}</span></a></Button></div>
      </Panel>
      <Panel className="settings-panel settings-access"><div className="settings-section-head"><div><span className="section-index">02 — ACCESS</span><h2>{t('测试资格与用量')}</h2></div>{overview&&<Badge variant="outline" className="settings-beta-badge">Pro · {t('邀请测试版')}</Badge>}</div>
        {!overview&&loading?<ListSkeleton label={t('正在读取测试资格与用量…')} rows={3}/>:overview&&
          <dl className="settings-usage">{metrics.map(([label,value,limit])=><div key={label}><dt>{label}</dt><dd><strong>{value??'—'}</strong><span> / {limit === null ? t('无限') : limit}</span></dd></div>)}</dl>}
        <FormError message={error}/><div className="settings-access-actions"><Button disabled={loading} loading={loading} onClick={()=>void load()}>{t('刷新用量')}</Button><DocsLink path="/account/limits/">{t('额度说明')}</DocsLink></div>
      </Panel>
      <Panel className="settings-panel settings-preferences"><span className="section-index">03 — PREFERENCES</span><h2>{t('偏好设置')}</h2><Preferences labels/></Panel>
    </div>
  </section>;
}
