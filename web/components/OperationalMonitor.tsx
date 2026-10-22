import { useCallback, useEffect, useRef, useState } from 'react';
import type { LatencyMetric, ObservabilitySnapshot, OperationalComponent, OperationalState } from '../../src/contracts/observability.js';
import { request, errorText } from '../api.js';
import { t } from '../i18n.js';
import { formatTime } from '../utils.js';
import { Panel, Disclosure, LoadingRegion } from './Surface.js';
import { Button } from './ui/button.js';
import { Skeleton } from './ui/skeleton.js';

const stateLabels: Record<OperationalState,string> = { ok:'未发现需处理的异常',idle:'空闲待命',warning:'需要关注',critical:'发现异常',unknown:'等待巡检确认' };
const componentLabels:Record<OperationalComponent,string>={database:'数据库',scheduler:'监控',prices:'行情',notifications:'通知',email:'邮件',api:'接口',cron:'定时巡检',queue:'投递队列',monitor:'监控记录'};
const reasons:Record<string,string>={
  idle_no_active_alerts:'暂无可调度工作，未持续抓取行情。',provider_not_checked:'尚无实际投递样本，通知提供方未验证。',
  awaiting_first_probe:'等待首次后台巡检。',probe_missing:'接口巡检结果缺失或已过期。',cron_overdue:'超过三分钟没有收到定时巡检。',
  queue_delayed:'有到期通知等待超过一分钟。',delivery_stuck:'有发送占用超过一分钟，请检查恢复状态。',
  queue_probe_failed:'无法读取队列，不能视为空队列。',service_startup_unavailable:'接口初始化或依赖检查失败。',
  email_unavailable:'邮件服务不可用。',monitor_storage_unavailable:'监控记录无法可靠保存。',
  cycle_budget_exceeded:'本轮达到工作预算，剩余规则继续轮转。',
};
function percentile(metric:LatencyMetric):string {
  if(!metric.count)return t('尚无样本');
  let count=0;for(let i=0;i<metric.buckets.length;i++){count+=metric.buckets[i]!;if(count>=Math.ceil(metric.count*.95))return i<metric.boundsMs.length?'≤ '+metric.boundsMs[i]+' ms':'> '+metric.boundsMs.at(-1)+' ms';}
  return t('尚无样本');
}
export function OperationalMonitor(){
  const [data,setData]=useState<ObservabilitySnapshot|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(false),flight=useRef<AbortController|null>(null);
  const load=useCallback(async()=>{
    if(flight.current)return;
    const controller=new AbortController();flight.current=controller;setBusy(true);
    try{const report=await request<ObservabilitySnapshot>('/api/admin/observability','GET',undefined,{signal:controller.signal});if(alive.current){setData(report);setError('');}}
    catch(cause){if(alive.current&&!controller.signal.aborted)setError(errorText(cause));}
    finally{if(flight.current===controller)flight.current=null;if(alive.current)setBusy(false);}
  },[]);
  useEffect(()=>{
    alive.current=true;void load();
    const refresh=()=>{if(!document.hidden)void load();},timer=setInterval(refresh,30_000);
    document.addEventListener('visibilitychange',refresh);
    return()=>{alive.current=false;flight.current?.abort();flight.current=null;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[load]);
  return <Panel className="ops-panel">
    <div className="ops-heading"><div><h2>{t('服务运行诊断')}</h2><p className="small muted">{t('服务自身的健康与恢复记录，与币价提醒分开。')}</p></div><Button onClick={()=>void load()} disabled={busy}>{busy?t('正在读取…'):t('刷新诊断')}</Button></div>
    {error&&<p role="alert" className="form-error">{error} {data&&t('以下为上次成功读取的数据。')}</p>}
    {!data?error?<p role="status">{t('诊断暂不可用，请重试。')}</p>:<LoadingRegion label={t('正在读取运行诊断…')} className="ops-loading">
      <div className="ops-state ops-state-loading"><Skeleton className="ops-skeleton-heading"/><Skeleton className="ops-skeleton-time"/></div>
      <div className="ops-loading-issues"><Skeleton/><Skeleton/></div>
      <div className="ops-metrics ops-metrics-loading">
        {Array.from({length:6},(_,index)=><div key={index}><div className="ops-skeleton-label"><Skeleton/></div><div className="ops-skeleton-value"><Skeleton/></div></div>)}
      </div>
    </LoadingRegion>:<>
      <div className="ops-state" data-state={error?'unknown':data.state}><strong>{t(error?'诊断已过期':stateLabels[data.state])}</strong><span>{t('采集时间')} {formatTime(data.observedAt)}</span></div>
      <ul className="ops-issues">{data.issues.length?data.issues.map(issue=><li key={issue.component+issue.code}><strong>{t(componentLabels[issue.component])}</strong><span>{t(reasons[issue.code]??'需要检查组件状态。')} <code>{issue.code}</code></span></li>):<li>{t('当前未发现需要处理的服务异常。')}</li>}</ul>
      <dl className="ops-metrics">
        <div><dt>{t('队列：到期 / 等待 / 发送')}</dt><dd>{data.queue?`${data.queue.due} / ${data.queue.queued} / ${data.queue.sending}`:'—'}</dd></div>
        <div><dt>{t('投递：成功 / 不确定 / 失败')}</dt><dd>{data.metrics.sent} / {data.metrics.uncertain} / {data.metrics.failed}</dd></div>
        <div><dt>{t('预留至结果 P95（分桶上界）')}</dt><dd>{percentile(data.metrics.triggerToResultMs)}</dd></div>
        <div><dt>{t('评估：周期 / 异常 / 达预算')}</dt><dd>{data.metrics.ticks} / {data.metrics.tickFailures} / {data.metrics.budgetHits}</dd></div>
        <div><dt>{t('后台 D1：读取行 / 写入行')}</dt><dd>{data.database?`${data.database.rowsRead.toLocaleString()} / ${data.database.rowsWritten.toLocaleString()}`:t('此适配器未采集')}</dd></div>
        <div><dt>{t('最近定时巡检')}</dt><dd>{data.cronRequired?formatTime(data.lastCronAt):t('Node 使用进程内巡检')}</dd></div>
      </dl>
      <p className="small muted">{t('计数自本次后台实例启动，重启后重新计数；D1 仅含协调器 SQL，不是账号账单总量。')} {t('自动异常推送未启用。')}</p>
      <Disclosure title={t('查看行情源与异常恢复记录')}>
        <div className="ops-sources">{data.sources.map(source=><p key={source.venue+source.type}><strong>{source.venue.toUpperCase()} {source.type??''}</strong><span>{t('目录时间')} {formatTime(source.catalogAt)}</span><span>{t('行情轮询调用 / 异常')} {source.pollRequests} / {source.pollFailures}</span><code>{source.catalogCode??source.priceCode??'no_recorded_error'}</code></p>)}</div>
        <p className="small muted">{data.persistence==='durable'?t('异常及恢复记录跨后台实例保留，最多保存最近一天的 50 条。'):t('此运行时的诊断记录仅保存在内存。')}</p>
        {data.events.length?<ol className="ops-events">{[...data.events].reverse().map(event=><li key={event.component+event.code+event.openedAt}><strong>{t(componentLabels[event.component])} · {t(event.resolvedAt===null?'未恢复':'已恢复')}</strong><code>{event.code}</code><span>{formatTime(event.openedAt)}{event.resolvedAt!==null?' → '+formatTime(event.resolvedAt):''}</span></li>)}</ol>:<p>{t('尚无异常记录；这不代表通知投递已验证。')}</p>}
      </Disclosure>
    </>}
  </Panel>;
}
