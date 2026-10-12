import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { UserIdentity, SystemStatus } from '../../src/contracts/domain.js';
import type { Paginated } from '../../src/contracts/api.js';
import type { WorkspaceModel } from '../model.js';
import { api, errorText, request } from '../api.js';
import { Dialog, FormError } from '../components/Dialog.js';
import { formatTime, healthLabels } from '../utils.js';

type AdminStatus = { activeUsers: number; activeAlerts: number; health: SystemStatus['health'] };
export function Admin({ model, notify }: { model: WorkspaceModel; notify: (text: string) => void }) {
  const [users, setUsers] = useState<UserIdentity[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [adminStatus, setAdminStatus] = useState<AdminStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [invite, setInvite] = useState<{ email: string; expiresAt: number } | null>(null);
  const [target, setTarget] = useState<UserIdentity | null>(null);
  const [targetError, setTargetError] = useState('');
  const canAdmin = model.data?.status.user.role === 'admin' && model.data.status.capabilities.canAdmin;
  async function load(nextCursor?: string) {
    if (!canAdmin) return;
    setLoading(true); setError('');
    try {
      const [result, status] = await Promise.all([
        request<Paginated<UserIdentity>>(`/api/admin/users?limit=50${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ''}`), api('GET /api/admin/status'),
      ]);
      setUsers(previous => nextCursor ? [...previous, ...result.items.filter(user => !previous.some(item => item.id === user.id))] : result.items);
      setCursor(result.cursor); setAdminStatus(status);
    } catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [canAdmin]);
  async function createInvite(event: FormEvent) {
    event.preventDefault(); if (model.busy || !canAdmin) return; setInviteError(''); setInvite(null);
    try {
      const result = await model.mutate(() => api('POST /api/admin/invites', { email: email.trim().toLowerCase() }));
      setInvite(result); setEmail(''); notify('邮箱邀请已创建。');
    } catch (cause) { setInviteError(errorText(cause)); }
  }
  async function toggleUser() {
    if (!target || model.busy) return; setTargetError('');
    try {
      await model.mutate(() => api('PATCH /api/admin/users/:id', { disabled: !target.disabled }, target.id));
      notify(target.disabled ? '账户已恢复使用。' : '账户已停用。'); setTarget(null); await load();
    } catch (cause) { setTargetError(errorText(cause)); }
  }
  if (!canAdmin) return <section className="page-loading"><h1>管理</h1><p>此页面仅供管理员使用。</p></section>;
  return <section className="settings-page"><div className="page-heading"><div><h1>管理</h1><p>邀请账户、控制访问与查看运行状态。</p></div><button onClick={() => void load()} disabled={loading || model.busy}>刷新管理信息</button></div>
    <FormError message={error} />
    <div className="admin-overview"><span>活跃账户 <strong>{adminStatus?.activeUsers ?? '—'}</strong></span><span>活跃警报 <strong>{adminStatus?.activeAlerts ?? '—'}</strong></span><span>运行状态 <strong>{adminStatus ? healthLabels[adminStatus.health.overall] : '读取中'}</strong></span></div>
    <div className="admin-grid"><section className="settings-panel"><h2>邀请邮箱</h2><p className="small muted">邀请码仅限对应邮箱，Google 与验证码登录都需满足服务端的邀请规则。</p><form onSubmit={event => void createInvite(event)}><label>受邀邮箱<input type="email" required autoComplete="off" autoCapitalize="none" value={email} onChange={event => setEmail(event.target.value)} disabled={model.busy} placeholder="受邀者的邮箱地址" /></label><button className="primary" disabled={model.busy || !!model.error}>{model.busy ? '正在创建…' : '创建邮箱邀请'}</button><FormError message={inviteError} /></form>{invite && <p className="banner active" role="status">已创建 {invite.email} 的邀请，有效至 {formatTime(invite.expiresAt)}。请让对方使用该邮箱登录。此操作不表示邀请邮件已发送。</p>}</section>
      <section className="settings-panel"><h2>部署配置</h2><p className="small muted">数据库、邮件、Google 和共享 Pushover 凭据由部署者在服务端配置，不通过此页面编辑。</p><details><summary>查看部署配置说明</summary><div className="setup-note"><p>Node 使用 SQLite 或 PostgreSQL；Cloudflare 使用 D1 和单个后台协调器。账户、警报与通知状态都保存在数据库。</p><p>Google 需要配对的 OAuth 客户端 ID 与密钥。邮件使用已验证发件地址与 SMTP（仅 Node）或 Resend。</p><p>共享 Pushover 应用令牌在服务端配置；用户各自保存 User Key。更换数据加密密钥需先迁移已有密钥。</p><p>密钥与云平台令牌不应放入前端或构建变量。</p></div></details>
      {adminStatus && <div className="admin-health">{(['database', 'scheduler', 'prices', 'notifications', 'email'] as const).map(key => <span key={key}>{({ database: '数据库', scheduler: '监控', prices: '行情', notifications: '通知', email: '邮件' })[key]}：{healthLabels[adminStatus.health[key].state]}</span>)}</div>}
      </section></div>
    <section className="users-section"><div className="history-heading"><h2>账户列表</h2><span>每页最多 50 个账户</span></div>{loading && !users.length ? <p className="muted">正在读取账户…</p> : users.length ? <div className="users-list">{users.map(user => <article className="user-row" key={user.id}><div><strong>{user.email}</strong><small>{user.name || '未设置名称'} · {user.role === 'admin' ? '管理员' : '普通用户'}</small></div><span className={user.disabled ? 'amber-text' : 'success-text'}>{user.disabled ? '已停用' : '可用'}</span><button disabled={model.busy || loading || !!model.error} onClick={() => { setTarget(user); setTargetError(''); }}>{user.disabled ? '恢复账户' : '停用账户'}</button></article>)}</div> : <p className="muted">没有可显示的账户。</p>}{cursor && <button disabled={loading || model.busy} onClick={() => void load(cursor)}>{loading ? '正在读取…' : '加载更多账户'}</button>}</section>
    {target && <Dialog title={target.disabled ? '恢复此账户？' : '停用此账户？'} onClose={() => setTarget(null)} busy={model.busy}><p>{target.email}</p><p className="small muted">{target.disabled ? '账户将恢复登录与使用。监控仍按其已保存设置运行。' : '停用后撤销登录会话并阻止新的通知投递。已经发送的请求无法撤回。'}</p>{target.id === model.data?.status.user.id && <p className="warning">这是当前登录的账户，停用后将无法继续管理本站。</p>}<FormError message={targetError} /><div className="confirm-actions"><button disabled={model.busy} onClick={() => setTarget(null)}>取消</button><button className="primary" disabled={model.busy} onClick={() => void toggleUser()}>{model.busy ? '正在处理…' : target.disabled ? '恢复账户' : '停用账户'}</button></div></Dialog>}
  </section>;
}
