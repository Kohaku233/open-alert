import { DialogPresence } from '../motion.js';
import { Panel, Notice, ListSkeleton } from './Surface.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { InvitationResult, InvitationSummary, Paginated } from '../../src/contracts/api.js';
import type { WorkspaceModel } from '../model.js';
import { api, AppError, errorText, request } from '../api.js';
import { t } from '../i18n.js';
import { formatTime } from '../utils.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';
import { Dialog, FormError } from './Dialog.js';

function deliveryText(invite: InvitationResult) {
    const delivery = invite.emailDelivery;
    if (delivery.status === 'accepted') return t('邮件服务已接受邀请邮件，请对方查收。');
    if (delivery.reason === 'existing_invitation') return t('本次未重复发送邮件。可将网站地址发给对方，使用受邀邮箱登录。');
    if (delivery.reason === 'resend_sandbox') return t('当前邮件为测试模式，无法向此邮箱发送邀请邮件。请配置并验证自有发件域名。');
    if (delivery.reason === 'delivery_cooldown') return t('邀请已保存。为避免重复邮件，请等待一分钟后再重发。');
    if (delivery.status === 'uncertain') return t('邀请已保存，邮件投递结果暂不确定。请让对方先检查收件箱，避免重复发送。');
    return t('邀请已保存，但邮件发送失败。可以稍后重发，或复制登录链接发给对方。');
}
function statusText(status: InvitationSummary['status']) {
    return status === 'pending' ? t('待加入') : status === 'accepted' ? t('已加入') : status === 'revoked' ? t('已撤销') : t('已过期');
}
export function Invitations({ model, notify }: { model: WorkspaceModel; notify: (text: string) => void }) {
    const [email, setEmail] = useState('');
    const [invite, setInvite] = useState<InvitationResult | null>(null);
    const [items, setItems] = useState<InvitationSummary[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [listError, setListError] = useState('');
    const [error, setError] = useState('');
    const [action, setAction] = useState('');
    const [target, setTarget] = useState<InvitationSummary | null>(null);
    const [targetError, setTargetError] = useState('');
    const [deadlines, setDeadlines] = useState<Record<string, number>>({});
    const [now, setNow] = useState(Date.now());
    const lock = useRef(false);
    const load = useCallback(async (nextCursor?: string, signal?: AbortSignal) => {
        setLoading(true); setListError('');
        try {
            const page = await request<Paginated<InvitationSummary>>(`/api/admin/invites?limit=50${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ''}`, 'GET', undefined, signal ? { signal } : {});
            setItems(previous => nextCursor ? [...previous, ...page.items.filter(item => !previous.some(old => old.id === item.id))] : page.items);
            setCursor(page.cursor);
        } catch (cause) { if (!signal?.aborted) setListError(errorText(cause)); }
        finally { if (!signal?.aborted) setLoading(false); }
    }, []);
    useEffect(() => { const controller = new AbortController(); void load(undefined, controller.signal); return () => controller.abort(); }, [load]);
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);
    async function create(event: FormEvent) {
        event.preventDefault();
        if (lock.current || model.busy) return;
        lock.current = true; setAction('create'); setError(''); setInvite(null);
        try {
            const result = await model.mutate(() => api('POST /api/admin/invites', { email: email.trim().toLowerCase() }));
            setInvite(result); setEmail('');
            if (result.emailDelivery.reason !== 'existing_invitation') setDeadlines(previous => ({ ...previous, [result.id]: Date.now() + 60_000 }));
            notify(result.reused ? t('该邮箱已有有效邀请，已恢复邀请信息。') : t('邮箱邀请已创建。'));
        } catch (cause) { setError(errorText(cause)); }
        finally { await load(); lock.current = false; setAction(''); }
    }
    async function resend(item: InvitationSummary) {
        if (lock.current || model.busy) return;
        lock.current = true; setAction(item.id); setError('');
        try {
            const result = await model.mutate(() => api('POST /api/admin/invites/:id/resend', { expectedExpiresAt: item.expiresAt, confirm: true }, item.id));
            setInvite(result);
            notify(result.emailDelivery.status === 'accepted' ? t('邀请邮件已交给邮件服务。') : t('邀请仍有效，请查看邮件发送结果。'));
            setDeadlines(previous => ({ ...previous, [item.id]: Date.now() + 60_000 }));
        } catch (cause) {
            setError(errorText(cause));
            if (cause instanceof AppError && cause.status === 429) setDeadlines(previous => ({ ...previous, [item.id]: cause.retryAt }));
            else setDeadlines(previous => ({ ...previous, [item.id]: Date.now() + 60_000 }));
        } finally { await load(); lock.current = false; setAction(''); }
    }
    async function revoke() {
        if (!target || lock.current || model.busy) return;
        lock.current = true; setAction('revoke'); setTargetError('');
        try {
            await model.mutate(() => api('DELETE /api/admin/invites/:id', { expectedExpiresAt: target.expiresAt }, target.id));
            if (invite?.id === target.id) setInvite(null);
            setTarget(null); notify(t('邀请已撤销。'));
        } catch (cause) { setTargetError(errorText(cause)); }
        finally { await load(); lock.current = false; setAction(''); }
    }
    async function copy(emailAddress: string) {
        const url = new URL('/login', window.location.origin); url.searchParams.set('email', emailAddress);
        try { await navigator.clipboard.writeText(url.href); notify(t('登录链接已复制，仅对应受邀邮箱可用。')); }
        catch { setError(t('复制失败。可直接把本站地址发给对方，并提醒使用受邀邮箱登录。')); }
    }
    const busy = !!action || model.busy;
    return <Panel className="settings-panel invitation-panel" aria-labelledby="invitations-heading">
      <div className="invitation-panel-heading"><h2 id="invitations-heading">{t('邀请邮箱')}</h2><details className="invitation-instructions"><summary>{t('邀请规则')}</summary><p className="small muted">{t('邀请有效期为 7 天，仅限指定邮箱。已注册用户可直接登录，无需再次邀请。')}</p></details></div>
      <form onSubmit={event => void create(event)}>
        <Label htmlFor="invite-email">{t('受邀邮箱')}</Label><Input id="invite-email" name="inviteEmail" type="email" maxLength={254} required autoComplete="off" autoCapitalize="none" spellCheck={false} value={email} onChange={event => setEmail(event.target.value)} disabled={busy} placeholder={t('受邀者的邮箱地址')}/>
        <Button variant="default" className="primary" disabled={busy || !!model.error}>{action === 'create' ? t('正在创建…') : t('创建邮箱邀请')}</Button>
      </form>
      <FormError message={error}/>
      {invite && <Notice className="invitation-result" role="status"><p>{invite.reused ? t('已有有效邀请：') : t('已创建 ')}<strong>{invite.email}</strong>{t(' 的邀请，有效至 ')}{formatTime(invite.expiresAt)}</p><p>{t('邀请已生效。')}{deliveryText(invite)}</p><Button onClick={() => void copy(invite.email)}>{t('复制登录链接')}</Button></Notice>}
      <div className="invitation-list-heading"><h3>{t('邀请记录')}</h3><Button variant="ghost" disabled={loading || busy} onClick={() => void load()}>{t('刷新邀请')}</Button></div>
      <FormError message={listError}/>
      {loading && !items.length ? <ListSkeleton label={t('正在读取邀请…')}/> : !items.length && !listError ? <p className="small muted">{t('还没有邀请。创建后可在这里查看、重发或撤销。')}</p> : <ul className="invitation-list">{items.map(item => {
          const status = item.status === 'pending' && item.expiresAt <= now ? 'expired' : item.status;
          const seconds = Math.min(60, Math.max(0, Math.ceil(((deadlines[item.id] ?? 0) - now) / 1000)));
          return <li key={item.id}><div className="invitation-row-info"><strong>{item.email}</strong><span className="invitation-state">{statusText(status)}</span><small>{status === 'revoked' ? t('此邀请已失效，重新创建可再次邀请。') : t('有效至 {0}', formatTime(item.expiresAt))}</small></div>
            {status === 'pending' && <div className="invitation-actions"><Button disabled={busy || seconds > 0} onClick={() => void resend(item)}>{action === item.id ? t('正在发送…') : seconds ? t('{0} 秒后重发', seconds) : t('重发邀请')}</Button><Button variant="ghost" disabled={busy} onClick={() => { setTarget(item); setTargetError(''); }}>{t('撤销邀请')}</Button></div>}
            {(status === 'expired' || status === 'revoked') && <Button disabled={busy} onClick={() => { setEmail(item.email); document.getElementById('invite-email')?.focus(); }}>{t('再次邀请')}</Button>}
          </li>;
      })}</ul>}
      {cursor && <Button disabled={loading || busy} onClick={() => void load(cursor)}>{t('加载更多邀请')}</Button>}
      <DialogPresence present={!!target}>{target && <Dialog title={t('撤销此邀请？')} onClose={() => setTarget(null)} busy={busy}><p className="invitation-address">{target.email}</p><p>{t('撤销后，此邮箱不能再凭该邀请注册。已经发出的邮件无法撤回。')}</p><FormError message={targetError}/><div className="confirm-actions"><Button disabled={busy} onClick={() => setTarget(null)}>{t('取消')}</Button><Button variant="destructive" disabled={busy} onClick={() => void revoke()}>{action === 'revoke' ? t('正在处理…') : t('确认撤销')}</Button></div></Dialog>}</DialogPresence>
    </Panel>;
}
