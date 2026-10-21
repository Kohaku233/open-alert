import { useCompactLayout } from '../useCompactLayout.js';
import { Spinner } from '../components/ui/spinner.js';
import { usePageMotion, DialogPresence } from '../motion.js';
import { Panel, PageHeader, Notice, PageError } from '../components/Surface.js';
import { Badge } from '../components/ui/badge.js';
import { FieldSelect } from '../components/FieldSelect.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { t } from '../i18n.js';
import { useState, useRef } from 'react';
import type { FormEvent } from 'react';
import type { ChannelProfile, NotificationOptions } from '../../src/contracts/domain.js';
import type { WorkspaceModel } from '../model.js';
import { api, errorText, request } from '../api.js';
import { formatTime } from '../utils.js';
import { Dialog, FormError } from '../components/Dialog.js';
export function Notifications({ model, notify }: {
    model: WorkspaceModel;
    notify: (text: string) => void;
}) {
    const compact = useCompactLayout();
    const [editing, setEditing] = useState<'channel' | 'delivery' | null>(null);
    const pageRef = useRef<HTMLElement>(null);
    usePageMotion(pageRef, !!model.data, true, 'settings');
    const { data, busy, mutate } = model;
    const [userKey, setUserKey] = useState('');
    const [appToken, setAppToken] = useState('');
    const [tokenMode, setTokenMode] = useState<'retain' | 'private' | 'shared'>('retain');
    const [channelError, setChannelError] = useState('');
    const [settingsError, setSettingsError] = useState('');
    const [confirm, setConfirm] = useState<'test' | 'remove' | null>(null);
    const [confirmError, setConfirmError] = useState('');
    const [draft, setDraft] = useState<{
        options: NotificationOptions;
        dailyLimit: number;
        generation: number;
    } | null>(null);
    if (!data)
        return model.error ? <PageError title={t("手机通知")}/> : null;
    const channel = data.status.channel;
    const pending = data.alerts.some(alert => alert.pending);
    const options = draft?.options ?? data.status.settings.notification;
    const dailyLimit = draft?.dailyLimit ?? data.status.settings.dailyLimit;
    function updateOptions(patch: Partial<NotificationOptions>) {
        if (!data)
            return;
        setDraft({ options: { ...options, ...patch }, dailyLimit, generation: draft?.generation ?? data.status.settingsGeneration });
    }
    async function saveChannel(event: FormEvent) {
        event.preventDefault();
        if (busy || pending)
            return;
        setChannelError('');
        const nextKey = userKey.trim();
        const nextToken = appToken.trim();
        if ((!channel.userKeyPresent || nextKey) && !/^[A-Za-z0-9]{30}$/.test(nextKey)) {
            setChannelError(t("Pushover 用户密钥应为 30 位字母或数字。"));
            return;
        }
        if (tokenMode === 'private' && !/^[A-Za-z0-9]{30}$/.test(nextToken)) {
            setChannelError(t("个人应用令牌应为 30 位字母或数字。"));
            return;
        }
        // Required contract extension: omitted userKey preserves the stored encrypted key.
        const body: {
            provider: 'pushover';
            userKey?: string;
            appToken?: string | null;
        } = { provider: 'pushover' };
        if (nextKey)
            body.userKey = nextKey;
        if (tokenMode === 'private')
            body.appToken = nextToken;
        if (tokenMode === 'shared')
            body.appToken = null;
        try {
            await mutate(() => request<ChannelProfile>('/api/channels', 'PUT', body));
            setUserKey('');
            setAppToken('');
            setTokenMode('retain');
            notify(t("通知渠道已保存。未发送测试通知。"));
        }
        catch (cause) {
            setChannelError(errorText(cause));
        }
    }
    async function saveSettings(event: FormEvent) {
        event.preventDefault();
        if (!data || busy || pending)
            return;
        setSettingsError('');
        if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 20 || !Number.isInteger(options.retry) || options.retry < 30 || options.retry > 3600 || !Number.isInteger(options.expire) || options.expire < options.retry || options.expire > 10800 || !/^[A-Za-z0-9_-]{0,64}$/.test(options.sound)) {
            setSettingsError(t("请检查每日上限、间隔、到期时间和铃声标识。到期时间不能小于重复间隔。"));
            return;
        }
        if (draft && draft.generation !== data.status.settingsGeneration) {
            setSettingsError(t("通知设置已在其他页面更新，请重新读取后修改。"));
            return;
        }
        try {
            await mutate(() => api('PATCH /api/settings', { notification: options, dailyLimit, expectedGeneration: draft?.generation ?? data.status.settingsGeneration }));
            setDraft(null);
            notify(t("通知设置已保存。")); setEditing(null);
        }
        catch (cause) {
            setSettingsError(errorText(cause));
        }
    }
    async function confirmAction() {
        if (busy || !confirm)
            return;
        setConfirmError('');
        try {
            if (confirm === 'test') {
                await mutate(() => api('POST /api/test-notification', { confirm: true }));
                notify(t("测试通知已交给 Pushover，请查看手机。"));
            }
            else {
                await mutate(() => api('DELETE /api/channels'));
                setUserKey('');
                setAppToken('');
                notify(t("通知密钥已删除。"));
            }
            setConfirm(null);
        }
        catch (cause) {
            setConfirmError(errorText(cause));
        }
    }
    function openConfirm(kind: 'test' | 'remove') { setConfirm(kind); setConfirmError(''); }
    return <section ref={pageRef} className="settings-page notifications-page"><PageHeader className="page-heading"><div><span className="page-index">{compact ? 'PUSHOVER' : '02 — NOTIFICATIONS'}</span><h1>{t("手机通知")}</h1><p>{t("把价格警报发到自己的 Pushover 账户。")}</p></div><Badge variant="outline" className={`status-pill ${channel.configured ? 'success' : ''}`}>{channel.configured ? t("已配置") : t("未完成配置")}</Badge></PageHeader>
    {pending && <Notice as="p" className="warning">{t("通知正在排队或发送，暂时无法修改渠道与设置。可等待完成，或在仪表盘明确暂停监控。")}</Notice>}
    {compact && editing === null && <div className="mobile-notification-summaries"><Panel className="mobile-channel-summary"><h2>{t('Pushover 连接')}<small>01</small></h2><dl><div><dt>{t('用户密钥')}</dt><dd>{channel.userKeyPresent ? t('•••••••• 已保存') : t('尚未保存')}</dd></div><div><dt>{t('当前应用令牌')}</dt><dd>{channel.tokenSource === 'private' ? t('使用个人令牌') : channel.tokenSource === 'shared' ? t('使用部署共享令牌') : t('不可用')}</dd></div></dl><div className="mobile-channel-actions"><Button disabled={busy || !channel.configured || pending || !!model.error || data.status.daily.attempts >= data.status.daily.limit} onClick={() => openConfirm('test')}>{t('发送测试通知')}</Button><Button disabled={busy || pending || !!model.error} onClick={() => setEditing('channel')}>{t('替换密钥')}</Button></div></Panel>
      <Panel className="mobile-delivery-summary"><h2>{t('警报提醒方式')}<small>02</small></h2>{[[t('提醒级别'),options.priority === 2 ? t('紧急提醒') : options.priority === 1 ? t('高优先级') : options.priority === 0 ? t('普通提醒') : options.priority === -2 ? t('静默提醒') : t('低优先级')],[t('铃声标识'),options.sound],[t('重复 / 到期'),`${options.retry}s / ${options.expire}s`],[t('每日通知尝试上限'),String(dailyLimit)]].map(([label,value])=><Button variant="ghost" key={label} disabled={busy || pending || !!model.error} onClick={() => setEditing('delivery')}><span>{label}</span><strong>{value} <i>›</i></strong></Button>)}<div className="quota-segments" aria-hidden="true">{Array.from({length:10},(_,i)=><i key={i} className={i < Math.ceil(data.status.daily.attempts / data.status.daily.limit * 10) ? 'is-used' : ''}/>)}</div><p>{t('今日 ')}{data.status.daily.attempts} / {data.status.daily.limit} · UTC</p></Panel></div>}
      {compact && editing && <Button className="return-notification-summary" onClick={() => setEditing(null)}>← {t('返回通知概览')}</Button>}
    <div className="settings-grid notifications-grid">{(!compact || editing === 'channel') && <Panel className="settings-panel channel-panel"><span className="section-index">01 — CHANNEL</span><h2>{t("Pushover 连接")}</h2><p className="small muted">{t("先在手机安装 Pushover，再从账户页面取得 User Key。")}</p><dl className="key-state channel-state"><div><dt>{t("用户密钥")}</dt><dd>{channel.userKeyPresent ? t("•••••••• 已保存") : t("尚未保存")}</dd></div><div><dt>{t("个人应用令牌")}</dt><dd>{channel.privateTokenPresent ? t("•••••••• 已保存") : t("未设置")}</dd></div><div><dt>{t("当前应用令牌")}</dt><dd>{channel.tokenSource === 'private' ? t("使用个人令牌") : channel.tokenSource === 'shared' ? t("使用部署共享令牌") : t("不可用")}</dd></div><div><dt>{t("最近更新")}</dt><dd>{formatTime(channel.updatedAt)}</dd></div></dl>
      <form onSubmit={event => void saveChannel(event)}><fieldset disabled={busy || pending || !!model.error}><Label>{channel.userKeyPresent ? t("替换用户密钥（留空保留）") : t("Pushover 用户密钥")}<Input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={userKey} onChange={event => setUserKey(event.target.value)} required={!channel.userKeyPresent} maxLength={30} placeholder={channel.userKeyPresent ? t("已保存；留空保留") : t("30 位 User Key")}/></Label><Label>{t("应用令牌来源")}<FieldSelect label={t("应用令牌来源")} value={tokenMode} onValueChange={value => setTokenMode(value as typeof tokenMode)} disabled={busy || pending || !!model.error} options={[{value:'retain',label:t("保留当前设置")},{value:'shared',label:t("使用部署共享令牌")},{value:'private',label:t("设置个人应用令牌")}]} /></Label>
      {tokenMode === 'private' && <Label>{t("个人应用令牌")}<Input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={appToken} onChange={event => setAppToken(event.target.value)} required maxLength={30} placeholder={t("30 位 App Token")}/><span className="small muted">{t("从 Pushover 的应用管理页面创建，仅用于你的通知。")}</span></Label>}
      {tokenMode === 'shared' && <p className="small muted">{t("保存后移除个人令牌，改用管理员配置的共享令牌。若共享令牌未配置，渠道将不可用。")}</p>}
      {channel.tokenSource === 'missing' && tokenMode !== 'private' && <Notice as="p" className="warning">{t("没有可用应用令牌。请配置个人令牌，或请管理员在服务端配置共享令牌。")}</Notice>}
      <Button variant="default" className="primary wide">{busy && <Spinner/>}{busy ? t("正在保存…") : t("保存通知渠道")}</Button></fieldset><FormError message={channelError}/></form>
      <div className="channel-footer"><div className="channel-actions"><Button disabled={busy || !channel.configured || pending || !!model.error || data.status.daily.attempts >= data.status.daily.limit} onClick={() => openConfirm('test')}>{t("发送测试通知")}</Button><Button className="danger-text" disabled={busy || pending || (!channel.userKeyPresent && !channel.privateTokenPresent) || !!model.error} onClick={() => openConfirm('remove')}>{t("删除通知密钥")}</Button></div><p className="small muted channel-save-note">{t("保存渠道不会发送通知。测试仅使用普通优先级，也计入当日投递次数。")}</p><a className="external-link" href="https://pushover.net/" target="_blank" rel="noopener noreferrer">{t("打开 Pushover 账户")} ↗</a></div>
    </Panel>}{(!compact || editing === 'delivery') && <Panel className="settings-panel delivery-panel"><span className="section-index">02 — DELIVERY</span><h2>{t("警报提醒方式")}</h2><p className="small muted">{t("修改只影响之后触发的通知。手机的专注模式与 Pushover 权限也会影响提醒。")}</p>
      <form onSubmit={event => void saveSettings(event)}><fieldset disabled={busy || pending || !!model.error}><Label>{t("提醒级别")}<FieldSelect label={t("提醒级别")} value={String(options.priority)} onValueChange={value => updateOptions({priority:Number(value)})} disabled={busy || pending || !!model.error} options={[{value:'2',label:t("紧急提醒 · 重复直到确认或到期")},{value:'1',label:t("高优先级 · 单次提醒")},{value:'0',label:t("普通提醒 · 单次提醒")},{value:'-1',label:t("低优先级 · 单次提醒")},{value:'-2',label:t("静默提醒 · 单次提醒")}]} /></Label><div className="delivery-fields"><Label>{t("铃声标识")}<Input value={options.sound} maxLength={64} pattern={'[A-Za-z0-9_\\-]*'} onChange={event => updateOptions({ sound: event.target.value })} placeholder="siren"/><span className="small muted">{t("填写 Pushover 已支持的铃声名称，例如 siren 或 pushover。")}</span></Label><Label>{t("重复间隔 · 秒")}<Input type="number" min={30} max={3600} step={1} required value={options.retry} onChange={event => updateOptions({ retry: Number(event.target.value) })}/></Label><Label>{t("到期时间 · 秒")}<Input type="number" min={30} max={10800} step={1} required value={options.expire} onChange={event => updateOptions({ expire: Number(event.target.value) })}/></Label></div><p className="small muted">{t("重复间隔与到期时间仅在紧急提醒下生效。")}</p><Label>{t("每日通知尝试上限")}<Input type="number" min={1} max={20} step={1} required value={dailyLimit} onChange={event => setDraft({ options, dailyLimit: Number(event.target.value), generation: draft?.generation ?? data.status.settingsGeneration })}/><span className="small muted">{t("包含测试、失败与重试，按 UTC 零点重置。")}</span></Label><Button variant="default" className="primary wide">{busy && <Spinner/>}{busy ? t("正在保存…") : t("保存提醒设置")}</Button></fieldset><FormError message={settingsError}/>
      {draft && <Button type="button" className="text-button" disabled={busy} onClick={() => { setDraft(null); setSettingsError(''); }}>{t("重新读取当前设置")}</Button>}</form><div className="delivery-quota"><div className="quota-note"><span><strong>{t("今日 ")}{data.status.daily.attempts} / {data.status.daily.limit}</strong> · {data.status.daily.date}（UTC）</span><span>{t('剩余 {0}', Math.max(0, data.status.daily.limit - data.status.daily.attempts))}</span></div><div className="quota-segments" aria-hidden="true">{Array.from({length:10}, (_, i) => <i key={i} className={i < Math.ceil(data.status.daily.attempts / data.status.daily.limit * 10) ? 'is-used' : ''}/>)}</div></div>
    </Panel>}</div>
    <DialogPresence present={!!confirm}>{confirm && <Dialog title={confirm === 'test' ? t("发送一条测试通知？") : t("删除通知密钥？")} onClose={() => setConfirm(null)} busy={busy}><p>{confirm === 'test' ? t("将向当前保存的 Pushover 账户发送普通优先级测试，消耗一次当日通知尝试。请确认手机账户正确。") : t("将删除已保存的用户密钥和个人应用令牌。重新配置前无法发送通知。")}</p><FormError message={confirmError}/><div className="confirm-actions"><Button onClick={() => setConfirm(null)} disabled={busy}>{t("取消")}</Button><Button variant="default" className="primary" disabled={busy} onClick={() => void confirmAction()}>{busy ? t("正在处理…") : confirm === 'test' ? t("确认发送测试") : t("删除密钥")}</Button></div></Dialog>}</DialogPresence>
  </section>;
}
