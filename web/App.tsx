import { useCallback, useEffect, useState } from 'react';
import { authClient } from './auth.js';
import { loginCallbackURL } from './api.js';
import { useWorkspace } from './model.js';
import { Login } from './pages/Login.js';
import { Dashboard } from './pages/Dashboard.js';
import { Notifications } from './pages/Notifications.js';
import { Account } from './pages/Account.js';
import { Admin } from './pages/Admin.js';
import { FormError } from './components/Dialog.js';

const routes = ['/dashboard', '/notifications', '/account', '/admin'];
function Brand({ navigate }: { navigate: (path: string) => void }) {
  return <a className="brand" href="/dashboard" onClick={event => { event.preventDefault(); navigate('/dashboard'); }}><span className="brand-mark" aria-hidden="true">⌁</span><span>价格哨站<small>Open Alert · OKX 永续</small></span></a>;
}
export function App() {
  const session = authClient.useSession();
  const [path, setPath] = useState(window.location.pathname);
  const [toast, setToast] = useState('');
  const navigate = useCallback((next: string) => { window.history.pushState({}, '', next); setPath(next); }, []);
  useEffect(() => { const pop = () => setPath(window.location.pathname); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 6500); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (session.isPending || session.error) return;
    if (session.data && (!routes.includes(path) || path === '/login')) { window.history.replaceState({}, '', '/dashboard'); setPath('/dashboard'); }
    else if (!session.data && path !== '/login') { window.history.replaceState({}, '', loginCallbackURL(window.location.search)); setPath('/login'); }
  }, [session.data, session.isPending, session.error, path]);
  const onSignedIn = () => { void session.refetch(); navigate('/dashboard'); };
  return <>
    {session.isPending ? <><header className="masthead"><Brand navigate={navigate} /></header><main className="page-loading"><p role="status">正在确认登录状态…</p></main></>
    : session.error ? <><header className="masthead"><Brand navigate={navigate} /></header><main className="page-loading"><h1>无法确认登录状态</h1><p>请检查网络和服务连接，再重试。</p><button onClick={() => void session.refetch()}>重试连接</button></main></>
    : session.data ? <Workspace key={session.data.user.id} path={path} navigate={navigate} notify={setToast} onUnauthorized={() => { void session.refetch(); }} />
    : <><header className="masthead"><Brand navigate={navigate} /><span className="login-header-note">个人价格警报与手机通知</span></header>{path === '/login' ? <Login onSignedIn={onSignedIn} /> : <main className="page-loading"><p role="status">正在打开登录页面…</p></main>}</>}
    {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
  </>;
}
function Workspace({ path, navigate, notify, onUnauthorized }: { path: string; navigate: (path: string) => void; notify: (text: string) => void; onUnauthorized: () => void }) {
  const model = useWorkspace(onUnauthorized);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  async function logout() {
    if (logoutBusy) return; setLogoutBusy(true); setLogoutError('');
    try {
      const result = await authClient.signOut();
      if (result.error) { setLogoutError('退出未完成，请检查网络后重试。'); return; }
      navigate('/login');
    } catch { setLogoutError('退出未完成，请检查网络后重试。'); }
    finally { setLogoutBusy(false); }
  }
  const canAdmin = model.data?.status.user.role === 'admin' && model.data.status.capabilities.canAdmin;
  const tabs = [['/dashboard', '行情与警报'], ['/notifications', '手机通知'], ['/account', '我的账户'], ...(canAdmin ? [['/admin', '管理']] : [])];
  return <>
    <header className="masthead"><Brand navigate={navigate} /><div className="header-actions"><span className="session-email">{model.data?.status.user.email ?? '已登录'}</span><button disabled={logoutBusy} onClick={() => void logout()}>{logoutBusy ? '正在退出…' : '退出登录'}</button></div></header>
    <nav className="app-nav" aria-label="主导航">{tabs.map(([href, label]) => <a key={href} href={href} aria-current={path === href ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(href!); }}>{label}</a>)}</nav>
    <main className="app-main"><FormError message={logoutError} />{model.error && <div className="connection-error" role="alert"><p>{model.error}</p><button disabled={model.busy} onClick={() => void model.refresh()}>重新读取状态</button></div>}
      {/* Keep the dashboard mounted across settings pages; polling never remounts the chart. */}
      <Dashboard model={model} active={path === '/dashboard' || !routes.includes(path)} notify={notify} navigate={navigate} />
      {path === '/notifications' && <Notifications model={model} notify={notify} />}
      {path === '/account' && <Account model={model} notify={notify} />}
      {path === '/admin' && <Admin model={model} notify={notify} />}
    </main><footer className="app-footer"><span>价格哨站 · Open Alert</span><span>后台判断价格，手机接收提醒。</span></footer>
  </>;
}
