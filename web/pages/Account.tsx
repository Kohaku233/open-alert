import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceModel } from '../model.js';
import type { AccountOverview } from '../../src/contracts/access.js';
import { Preferences } from '../components/Preferences.js';
import { AdminBootstrap } from '../components/AdminBootstrap.js';
import { usePageMotion } from '../motion.js';
import { Panel, PageHeader, ListSkeleton } from '../components/Surface.js';
import { Button } from '../components/ui/button.js';
import { Badge } from '../components/ui/badge.js';
import { FormError } from '../components/Dialog.js';
import { errorText, request } from '../api.js';
import { t } from '../i18n.js';
import { formatTime } from '../utils.js';

export function Account({ model, notify, navigate, logout, logoutBusy }: {
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
  async function feedback(){
    try {await navigator.clipboard.writeText(t('反馈类型：问题 / 功能建议\n使用场景：\n希望改进的地方：\n复现步骤（如有）：\n版本：Pro 邀请测试版'));notify(t('反馈模板已复制，可填写后发给邀请你的人。'));}
    catch{notify(t('复制失败，请直接将问题或功能建议发给邀请你的人。'));}
  }
  const metrics=usage&&limits?[
    [t('价格警报'),usage.alerts,limits.alerts,t('{0} 条规则已启用',usage.activeAlerts)],
    [t('监控市场'),usage.instruments,limits.instruments,t('按交易所与市场类型分别计数')],
    [t('通知渠道'),usage.channels,limits.channels,t('在通知中心管理')],
    [t('标的收藏'),usage.favorites,limits.favorites,t('跨交易所的标的收藏')],
  ] as const:[];
  return <section ref={root} className="settings-page product-settings-page">
    <PageHeader className="page-heading"><div><span className="page-index">04 — SETTINGS</span><h1>{t('设置')}</h1><p>{t('管理账户、测试资格与使用偏好。')}</p></div></PageHeader>
    <div className="product-settings-grid">
      <Panel className="settings-panel settings-identity"><span className="section-index">01 — ACCOUNT</span><h2>{t('账户信息')}</h2>
        <div className="settings-user"><span className="settings-avatar" aria-hidden="true">{(user?.name||user?.email||'O')[0]?.toUpperCase()}</span><div><strong>{user?.name||user?.email?.split('@')[0]||'—'}</strong><small>{user?.email??'—'}</small></div></div>
        <dl className="settings-details"><div><dt>{t('账户角色')}</dt><dd>{user?.role==='admin'?t('管理员'):t('成员')}</dd></div>
          <div><dt>{t('可用登录方式')}</dt><dd>{[capabilities?.emailOtp?t('邮箱验证码'):null,capabilities?.google?'Google':null].filter(Boolean).join(' · ')||'—'}</dd></div></dl>
        <p className="small muted">{t('警报、收藏和通知渠道仅属于当前账户。')}</p>
        <div className="settings-account-actions"><Button disabled={logoutBusy} loading={logoutBusy} onClick={logout}>{logoutBusy?t('正在退出…'):t('退出登录')}</Button>
          {admin&&<Button className="mobile-admin-link" onClick={()=>navigate('/admin')}>{t('进入管理台')} ↗</Button>}</div>
      </Panel>
      <Panel className="settings-panel settings-access"><div className="settings-section-head"><div><span className="section-index">02 — ACCESS</span><h2>{t('测试资格与用量')}</h2></div>{overview&&<Badge variant="outline" className="settings-beta-badge">Pro · {t('邀请测试版')}</Badge>}</div>
        {!overview&&loading?<ListSkeleton label={t('正在读取测试资格与用量…')} rows={3}/>:overview&&<>
          <p className="settings-beta-copy">{t('邀请测试期间，所有成员均可使用完整 Pro 功能，当前不收费。本轮测试未设置到期时间。')}</p>
          <div className="settings-features" aria-label={t('已开放功能')}>{([
            ['price_alerts',t('价格警报')],['anomaly_crypto',t('币种异动')],['anomaly_tradfi',t('股票异动')],
            ['notification_channels',t('全部通知渠道')],['native_charts',t('内置图表')],['drawing_tools',t('画线工具')],['market_favorites',t('跨交易所收藏')],
          ] as const).filter(([feature])=>overview.access.features[feature]).map(([feature,label])=><span key={feature}>{label}</span>)}</div>
          <dl className="settings-usage">{metrics.map(([label,value,limit,hint])=><div key={label}><dt>{label}</dt><dd><strong>{value??'—'}</strong><span> / {limit}</span></dd><small>{hint}</small></div>)}</dl>
          <div className="settings-daily"><span>{t('今日价格警报投递尝试')}<small>{t('含失败与重试，按 UTC 零点重置')}</small></span><strong>{usage?.priceAttempts} / {limits?.priceAttemptsPerDay}</strong></div>
          <p className="small muted">{t('异动通知的每日上限分别在通知中心设置。测试期间的容量上限用于控制服务负载。')}</p>
          <small className="muted settings-updated">{t('用量更新于 {0}',formatTime(usage?.observedAt??null))}</small>
        </>}
        <FormError message={error}/><Button className="text-button" disabled={loading} onClick={()=>void load()}>{loading?t('正在读取…'):t('刷新用量')}</Button>
      </Panel>
      <Panel className="settings-panel settings-preferences"><span className="section-index">03 — PREFERENCES</span><h2>{t('偏好设置')}</h2><Preferences labels/><p className="small muted">{t('外观和语言保存在当前浏览器中。')}</p></Panel>
      <Panel className="settings-panel settings-shortcuts"><span className="section-index">04 — WORKSPACE</span><h2>{t('工作区设置')}</h2>
        <Button variant="ghost" className="settings-link" onClick={()=>navigate('/notifications')}><span><strong>{t('通知中心')}</strong><small>{t('接收渠道、推送规则与发送记录')}</small></span><span aria-hidden="true">↗</span></Button>
        <Button variant="ghost" className="settings-link" onClick={()=>navigate('/anomaly')}><span><strong>{t('异动监测')}</strong><small>{t('监测范围与价格过滤条件')}</small></span><span aria-hidden="true">↗</span></Button>
        <div className="settings-feedback"><strong>{t('一起完善测试版')}</strong><p className="small muted">{t('遇到问题或有功能建议，可以整理后发给邀请你的人。')}</p><Button onClick={()=>void feedback()}>{t('复制反馈模板')}</Button></div>
      </Panel>
    </div>
    {new URLSearchParams(window.location.search).get('setup')==='admin'&&<AdminBootstrap model={model} notify={notify}/>}
  </section>;
}
