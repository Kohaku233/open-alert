import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Panel, ListSkeleton } from './Surface.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';
import { Switch } from './ui/switch.js';
import { Spinner } from './ui/spinner.js';
import { FieldSelect } from './FieldSelect.js';
import { Dialog, FormError } from './Dialog.js';
import { DialogPresence } from '../motion.js';
import { errorText, request } from '../api.js';
import { formatTime } from '../utils.js';
import { t } from '../i18n.js';
import { DocsLink } from './DocsLink.js';
import type { NotificationOptions } from '../../src/contracts/domain.js';
import type { HubDelivery, HubChannel, HubRoute, NotifySource, RouteOptions } from '../../src/notifications/hub.js';

type Channel = HubChannel & { configured: boolean; summary: Record<string, string | boolean> };
interface NotifyView { channels: Channel[]; routes: HubRoute[]; types: string[]; unlimited?: boolean; priceAttemptLimit?: number | null; profiles?: Record<NotifySource, NotificationOptions> }
type Routable = NotifySource;
type Quiet = NonNullable<RouteOptions['quiet']>;
type Modal = { kind: 'add' } | { kind: 'edit' | 'remove' | 'test'; channel: Channel } | null;

const ROUTABLE: readonly Routable[] = ['price_alert', 'anomaly_crypto', 'anomaly_tradfi'];
// Shown so the user sees where the hub is heading; only adapters the server reports are selectable.
const PLANNED = ['telegram', 'dingtalk', 'wecom', 'qq'] as const;
const typeName = (type: string) => ({ pushover: 'Pushover', telegram: 'Telegram', discord: 'Discord', dingtalk: t('钉钉'), wecom: t('企业微信'), qq: 'QQ' } as Record<string, string>)[type] ?? type;
const sourceName = (s: NotifySource) => s === 'price_alert' ? t('价格警报') : s === 'anomaly_crypto' ? t('币种异动') : t('股票异动');
const sourceHint = (s: NotifySource) => s === 'price_alert' ? t('价格到达目标时发送，失败时按渠道重试。') : s === 'anomaly_crypto' ? t('加密货币永续合约的异动推送。') : t('美股等 TradFi 合约的异动推送。');
const key = (s: string, c: string) => `${s}\u0000${c}`;

function outcomeText(c: Channel) {
  if (!c.configured) return t('未完成配置');
  if (!c.lastOutcome) return t('尚未发送');
  const label = c.lastOutcome === 'sent' ? t('最近发送成功') : c.lastOutcome === 'skipped' ? t('最近一次被跳过') : c.lastOutcome === 'uncertain' ? t('最近一次结果不确定') : t('最近发送失败');
  return c.lastAt ? `${label} · ${formatTime(c.lastAt)}` : label;
}
function summaryText(c: Channel) {
  if (c.type !== 'pushover') return String(c.summary.webhook ?? '');
  const token = c.summary.tokenSource === 'private' ? t('个人令牌') : c.summary.tokenSource === 'shared' ? t('共享令牌') : t('无应用令牌');
  return c.summary.userKey ? `${t('用户密钥')} ${String(c.summary.userKey)} · ${token}` : token;
}

/** Notification centre: the user's channels plus which event source reaches which channel. */
export function NotifyCenter({ notify }: { notify: (text: string) => void }) {
  const [view, setView] = useState<NotifyView | null>(null);
  const [logs,setLogs]=useState<HubDelivery[]>([]);
  const [logError,setLogError]=useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [draft, setDraft] = useState<Map<string, HubRoute> | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [modalError, setModalError] = useState('');
  const [form, setForm] = useState({ type: 'pushover', name: '', userKey: '', appToken: '', webhookUrl: '' });
  const load = useCallback(async (signal?: AbortSignal) => {
    try { setView(await request<NotifyView>('/api/notify', 'GET', undefined, signal ? { signal } : {})); setLoadError(''); try { setLogs((await request<{deliveries:HubDelivery[]}>('/api/notify/deliveries','GET',undefined,signal?{signal}:{})).deliveries);setLogError(''); } catch(cause) {setLogError(errorText(cause));} }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setLoadError(errorText(cause)); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  if (!view) return <Panel className="settings-panel notify-panel"><span className="section-index">01 — CHANNELS</span><h2>{t('通知中心')}</h2>
    {loadError ? <><FormError message={loadError}/><Button onClick={() => void load()}>{t('重新读取')}</Button></> : <ListSkeleton label={t('正在读取通知渠道')}/>}</Panel>;

  const stored = new Map(view.routes.map(r => [key(r.source, r.channelId), r]));
  const routes = draft ?? stored;
  const dirty = !!draft;
  const quietOf = (source: Routable): Quiet | null => [...routes.values()].find(r => r.source === source && r.options.quiet)?.options.quiet ?? null;
  const edit = (fn: (next: Map<string, HubRoute>) => void) => { const next = new Map(routes); fn(next); setDraft(next); setRouteError(''); };
  function toggleRoute(source: Routable, channelId: string, enabled: boolean) {
    edit(next => { const k = key(source, channelId), old = next.get(k); next.set(k, old ? { ...old, enabled } : { source, channelId, enabled, options: sourceOptions(source) }); });
  }
  // Quiet hours are set per source and written to every route of that source.
  function setQuiet(source: Routable, quiet: Quiet | null) {
    edit(next => { for (const c of view!.channels) { const k = key(source, c.id), old = next.get(k); next.set(k, old ? { ...old, options: { ...old.options, quiet } } : { source, channelId: c.id, enabled: false, options: { notification: null, quiet,dailyLimit:10 } }); } });
  }
  const sourceOptions=(source:Routable):RouteOptions => [...routes.values()].find(r=>r.source===source)?.options ?? {notification:null,quiet:null,dailyLimit:10};
  const profile=(source:Routable):NotificationOptions => sourceOptions(source).notification ?? view.profiles?.[source] ?? {priority:source==='price_alert'?2:1,retry:30,expire:1500,sound:'siren'};
  function setSource(source:Routable,patch:Partial<RouteOptions>) {
    edit(next=>{for(const c of view!.channels){const k=key(source,c.id),r=next.get(k);next.set(k,{source,channelId:c.id,enabled:r?.enabled??false,options:{...sourceOptions(source),...r?.options,...patch}});}});
  }
  async function run<T>(work: () => Promise<T>, done: string, onError: (text: string) => void): Promise<boolean> {
    setBusy(true);
    try { await work(); notify(done); await load(); return true; }
    catch (cause) { onError(errorText(cause)); return false; }
    finally { setBusy(false); }
  }
  async function saveRoutes() {
    if([...routes.values()].some(r=>!Number.isInteger(r.options.dailyLimit)||r.options.dailyLimit<1||r.options.dailyLimit>50||r.options.notification&&(r.options.notification.expire<r.options.notification.retry||r.options.notification.retry<30||r.options.notification.expire>10800||!/^[A-Za-z0-9_-]{0,64}$/.test(r.options.notification.sound)))){setRouteError(t('请检查每日上限、间隔、到期时间和铃声标识。到期时间不能小于重复间隔。'));return;}
    const bad = ROUTABLE.map(quietOf).some(q => q && (!q.from || !q.to || q.from === q.to));
    if (bad) { setRouteError(t('免打扰的开始和结束时间不能相同。')); return; }
    if (await run(() => request('/api/notify/routes', 'PUT', { routes: [...routes.values()] }), t('推送路由已保存。'), setRouteError)) setDraft(null);
  }
  async function toggleChannel(c: Channel, enabled: boolean) {
    await run(() => request(`/api/notify/channels/${encodeURIComponent(c.id)}`, 'PATCH', { expectedGeneration: c.generation, enabled }), enabled ? t('已启用 {0}。', c.name) : t('已停用 {0}，它不会再收到推送。', c.name), text => notify(text));
  }
  function open(next: Modal) { setModal(next); setModalError(''); setForm({ type: next?.kind === 'edit' ? next.channel.type : 'pushover', name: next?.kind === 'edit' ? next.channel.name : '', userKey: '', appToken: '', webhookUrl: '' }); }
  async function submitModal(event?: FormEvent) {
    event?.preventDefault();
    if (!modal || busy) return;
    setModalError('');
    const name = form.name.trim();
    if (modal.kind === 'add' || modal.kind === 'edit') {
      if (!name || [...name].length > 40) { setModalError(t('名称需要 1 到 40 个字符。')); return; }
    }
    let ok = false;
    if (modal.kind === 'add' || modal.kind === 'edit') {
      let config:Record<string,unknown>|undefined;
      if(form.type==='discord' && (modal.kind==='add'||form.webhookUrl.trim())) config={webhookUrl:form.webhookUrl.trim()};
      if(form.type==='pushover' && (modal.kind==='add'||form.userKey.trim())) {
        if(!/^[A-Za-z0-9]{30}$/.test(form.userKey.trim())) {setModalError(t('Pushover 用户密钥应为 30 位字母或数字。'));return;}
        config={userKey:form.userKey.trim(),appToken:form.appToken.trim()||null};
      }
      if(modal.kind==='edit' && form.type==='pushover' && form.appToken.trim() && !form.userKey.trim()){setModalError(t('替换令牌时请同时输入用户密钥。'));return;}
      ok = await run(()=>modal.kind==='add' ? request('/api/notify/channels','POST',{type:form.type,name,config}) : request(`/api/notify/channels/${encodeURIComponent(modal.channel.id)}`,'PATCH',{expectedGeneration:modal.channel.generation,name,...(config?{config}:{})}),t('通知渠道已保存。未发送测试通知。'),setModalError);
    } else if (modal.kind === 'remove') {
      ok = await run(() => request(`/api/notify/channels/${encodeURIComponent(modal.channel.id)}`, 'DELETE'), t('渠道 {0} 已删除。', modal.channel.name), setModalError);
    } else {
      ok = await run(() => request(`/api/notify/channels/${encodeURIComponent(modal.channel.id)}/test`, 'POST', { confirm: true }), t('测试通知已发到 {0}，请查看接收端。', modal.channel.name), setModalError);
    }
    if (ok) { setModal(null); if (modal.kind === 'remove') setDraft(null); }
  }
  const full = !view.unlimited && view.channels.length >= 10;

  return <>
    <Panel className="settings-panel notify-panel notify-channels"><div className="notify-head"><div><span className="section-index">01 — CHANNELS</span><h2>{t('通知渠道')}</h2><p className="small muted">{t('添加接收端，再为每类消息选择渠道。保存渠道不会发送测试消息。')}</p></div>
      <Button disabled={busy || full} onClick={() => open({ kind: 'add' })}>{t('添加渠道')}</Button></div>
      {!view.channels.length && <p className="small muted">{t('添加一个渠道，再选择要接收的消息。')}</p>}
      <ul className="notify-channel-list" aria-label={t('通知渠道')}>{view.channels.map(c => <li key={c.id} className={`notify-channel ${c.enabled ? '' : 'is-off'}`}>
        <span className="notify-type" aria-hidden="true">{typeName(c.type).slice(0, 2).toUpperCase()}</span>
        <span className="notify-channel-main"><strong>{c.name}</strong>
          <small>{typeName(c.type)}{summaryText(c) && ` · ${summaryText(c)}`}</small>
          <small className={`notify-outcome is-${c.configured ? (c.lastOutcome ?? 'idle') : 'missing'}`}>{outcomeText(c)}</small></span>
        <span className="notify-channel-actions">
          <Button variant="ghost" disabled={busy || !c.enabled || !c.configured} onClick={() => open({ kind: 'test', channel: c })}>{t('测试')}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => open({ kind: 'edit', channel: c })}>{t('编辑')}</Button>
          {<Button variant="ghost" className="danger-text" disabled={busy} onClick={() => open({ kind: 'remove', channel: c })}>{t('删除')}</Button>}
          <Switch checked={c.enabled} disabled={busy} aria-label={t('启用 {0}', c.name)} onCheckedChange={value => void toggleChannel(c, value)}/>
        </span></li>)}</ul>
      {full && <p className="small muted">{t('最多 10 个渠道。')}</p>}
      <p className="small muted notify-planned">{t('即将支持')}：{PLANNED.map(typeName).join(' · ')}</p>
    </Panel>
    <Panel className="settings-panel notify-panel notify-routing"><div className="notify-head"><div><span className="section-index">02 — RULES</span><h2>{t('推送规则')}</h2><p className="small muted">{t('决定每类消息发到哪些渠道。停用的渠道即使勾选也不会收到。')} <DocsLink path="/notify/routes/"/></p>{view.unlimited && <p className="small muted">{t('管理员不受业务额度限制')}</p>}</div>
      {dirty && <Badge variant="outline" className="status-pill">{t('未保存')}</Badge>}</div>
      <div className="notify-sources">
        {ROUTABLE.map(source => { const quiet = quietOf(source); return <section key={source} className="notify-source" aria-label={sourceName(source)}>
          <header><strong>{sourceName(source)}</strong><small>{sourceHint(source)}</small></header>
          {source==='price_alert' && !view.unlimited && <p className="small muted notify-attempt-limit">{t('价格警报每日合计最多尝试 {0} 次，含失败重试。',view.priceAttemptLimit??20)}</p>}
          <ul>{view.channels.map(c => { const r = routes.get(key(source, c.id)); return <li key={c.id}><label className="notify-route"><span>{c.name}{!c.enabled && <small>{t('已停用')}</small>}</span>
            <Switch checked={!!r?.enabled} disabled={busy} aria-label={t('{0}发到 {1}', sourceName(source), c.name)} onCheckedChange={value => toggleRoute(source, c.id, value)}/></label></li>; })}</ul>
          <div className="notify-rule-options">
            <Label>{t('提醒级别')}<FieldSelect label={sourceName(source)+' '+t('提醒级别')} value={String(profile(source).priority)} disabled={busy} onValueChange={v=>setSource(source,{notification:{...profile(source),priority:Number(v)}})} options={[{value:'2',label:t('紧急提醒')},{value:'1',label:t('高优先级')},{value:'0',label:t('普通提醒')},{value:'-1',label:t('低优先级')},{value:'-2',label:t('静默提醒')}]}/></Label>
            <Label>{t('每日上限')}{view.unlimited ? <Input value={t('无限')} readOnly disabled aria-label={t('管理员不受业务额度限制')}/> : <Input type="number" min={1} max={50} value={sourceOptions(source).dailyLimit??10} disabled={busy} onChange={e=>setSource(source,{dailyLimit:Number(e.target.value)})}/>}</Label>
            <details><summary>{t('Pushover 声音与重复提醒')}</summary><Label>{t('铃声标识')}<Input value={profile(source).sound} maxLength={64} onChange={e=>setSource(source,{notification:{...profile(source),sound:e.target.value}})}/></Label>
              {profile(source).priority===2 && <><Label>{t('重复间隔 · 秒')}<Input type="number" min={30} max={3600} value={profile(source).retry} onChange={e=>setSource(source,{notification:{...profile(source),retry:Number(e.target.value)}})}/></Label><Label>{t('到期时间 · 秒')}<Input type="number" min={30} max={10800} value={profile(source).expire} onChange={e=>setSource(source,{notification:{...profile(source),expire:Number(e.target.value)}})}/></Label></>}
            </details><small className="muted">{t('每日上限按渠道计算，UTC 零点重置。Discord 的声音由客户端控制。')}</small>
          </div><div className="notify-quiet"><label className="notify-route"><span>{t('免打扰')}<small>{t('时段内不推送，按本机时区')}</small></span>
            <Switch checked={!!quiet} disabled={busy} aria-label={t('{0}免打扰', sourceName(source))} onCheckedChange={value => setQuiet(source, value ? { from: '23:00', to: '07:00', offsetMinutes: -new Date().getTimezoneOffset() } : null)}/></label>
            {quiet && <div className="notify-quiet-range"><Label>{t('开始')}<Input type="time" value={quiet.from} disabled={busy} onChange={event => setQuiet(source, { ...quiet, from: event.target.value })}/></Label>
              <Label>{t('结束')}<Input type="time" value={quiet.to} disabled={busy} onChange={event => setQuiet(source, { ...quiet, to: event.target.value })}/></Label></div>}</div>
        </section>; })}
      </div>
      <FormError message={routeError}/>
      <div className="notify-route-actions"><Button variant="default" className="primary" disabled={busy || !dirty} onClick={() => void saveRoutes()}>{busy && <Spinner/>}{busy ? t('正在保存…') : t('保存推送路由')}</Button>
        {dirty && <Button className="text-button" disabled={busy} onClick={() => { setDraft(null); setRouteError(''); }}>{t('撤销修改')}</Button>}</div>
    </Panel>
    <Panel className="settings-panel notify-panel notify-history"><div className="notify-head"><div><span className="section-index">03 — HISTORY</span><h2>{t('发送记录')}</h2><p className="small muted">{t('最近 100 条，保留 30 天。成功表示渠道已接收，不代表设备已读。')}</p></div><Button disabled={busy} onClick={()=>void load()}>{t('刷新记录')}</Button></div>
      {logError && <FormError message={logError}/>}
      {logs.length ? <ul className="notify-delivery-list">{logs.map(l=><li key={l.id}><time>{formatTime(l.at)}</time><div><strong>{l.title}</strong><small>{l.source==='test'?t('测试'):sourceName(l.source as NotifySource)} · {l.channelName}</small></div><span className={'notify-outcome is-'+l.outcome}>{l.outcome==='sent'?t('已发送'):l.outcome==='skipped'?t('已跳过'):l.outcome==='uncertain'?t('结果不确定'):t('发送失败')}<small>{l.code==='quiet_hours'?t('免打扰'):l.code==='daily_limit'?t('达到每日上限'):l.code}</small></span></li>)}</ul> : <p className="small muted">{t('暂无发送记录。添加渠道后可以发送一条测试消息。')}</p>}
    </Panel>
    <DialogPresence present={!!modal}>{modal && <Dialog onClose={() => setModal(null)} busy={busy}
      title={modal.kind === 'add' ? t('添加通知渠道') : modal.kind === 'edit' ? t('编辑通知渠道') : modal.kind === 'remove' ? t('删除渠道 {0}？', modal.channel.name) : t('向 {0} 发送测试？', modal.channel.name)}>
      {modal.kind === 'add' || modal.kind === 'edit' ? <form className="notify-form" onSubmit={event => void submitModal(event)}><fieldset disabled={busy}>
        {modal.kind === 'add' && <Label>{t('渠道类型')}<FieldSelect label={t('渠道类型')} value={form.type} disabled={busy} onValueChange={type => setForm({ ...form, type })}
          options={[...view.types.map(type => ({ value: type, label: typeName(type) })), ...PLANNED.map(type => ({ value: type, label: `${typeName(type)} · ${t('即将支持')}`, disabled: true }))]}/></Label>}
        <Label>{t('名称')}<Input value={form.name} maxLength={40} required autoFocus placeholder={t('例如：备用手机')} onChange={event => setForm({ ...form, name: event.target.value })}/></Label>
        {form.type==='discord' ? <><Label>{t('Discord Webhook URL')}<Input type="password" autoComplete="off" required={modal.kind==='add'} value={form.webhookUrl} placeholder={modal.kind==='edit'?t('留空保留已保存的密钥'):'https://discord.com/api/webhooks/…'} onChange={e=>setForm({...form,webhookUrl:e.target.value})}/></Label><p className="small muted">{t('在 Discord 频道的设置 → 整合 → Webhook 中创建，复制 URL。')}</p></> : <><Label>{t('Pushover 用户密钥')}<Input type="password" autoComplete="off" maxLength={30} required={modal.kind==='add'} value={form.userKey} placeholder={modal.kind==='edit'?t('留空保留已保存的密钥'):t('30 位 User Key')} onChange={e=>setForm({...form,userKey:e.target.value})}/></Label><Label>{t('个人应用令牌（可选）')}<Input type="password" autoComplete="off" maxLength={30} value={form.appToken} placeholder={t('留空使用部署共享令牌')} onChange={e=>setForm({...form,appToken:e.target.value})}/></Label></>}
        <FormError message={modalError}/>
        <div className="confirm-actions"><Button type="button" onClick={() => setModal(null)} disabled={busy}>{t('取消')}</Button><Button variant="default" className="primary" disabled={busy}>{busy ? t('正在保存…') : modal.kind === 'add' ? t('添加渠道') : t('保存渠道')}</Button></div>
      </fieldset></form> : <>
        <p>{modal.kind === 'remove' ? t('删除后该渠道的密钥和路由一起移除，无法恢复。') : t('将以普通优先级发送一条测试消息。同一渠道 30 秒内只能测试一次。')}</p>
        <FormError message={modalError}/>
        <div className="confirm-actions"><Button onClick={() => setModal(null)} disabled={busy}>{t('取消')}</Button><Button variant="default" className="primary" disabled={busy} onClick={() => void submitModal()}>{busy ? t('正在处理…') : modal.kind === 'remove' ? t('删除渠道') : t('确认发送测试')}</Button></div></>}
    </Dialog>}</DialogPresence>
  </>;
}
