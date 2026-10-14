import { Toaster } from './components/ui/sonner.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { toast } from 'sonner';
import { Button } from './components/ui/button.js';
import { t } from './i18n.js';
import { Icon } from './components/Icon.js';
import { useLanguage, setLanguage } from './i18n.js';
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
function LanguageSwitch() {
    const language = useLanguage();
    return <div className="languages" aria-label={t("界面语言")}><Button type="button" aria-pressed={language === "zh-CN"} onClick={() => setLanguage("zh-CN")}>{t("中文")}</Button><Button type="button" aria-pressed={language === "en"} onClick={() => setLanguage("en")}>EN</Button></div>;
}
function Brand({ navigate }: {
    navigate: (path: string) => void;
}) {
    return <a className="brand" href="/dashboard" onClick={event => { event.preventDefault(); navigate('/dashboard'); }}><Icon name="brand" className="brand-mark"/><span>{t("价格哨站")}<small>OPEN ALERT</small></span></a>;
}
export function App() {
    useLanguage();
    const session = authClient.useSession();
    const [path, setPath] = useState(window.location.pathname);
    const navigate = useCallback((next: string) => { window.history.pushState({}, '', next); setPath(next); }, []);
    useEffect(() => { const pop = () => setPath(window.location.pathname); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
    useEffect(() => {
        if (session.isPending || session.error)
            return;
        if (session.data && (!routes.includes(path) || path === '/login')) {
            window.history.replaceState({}, '', '/dashboard');
            setPath('/dashboard');
        }
        else if (!session.data && path !== '/login') {
            window.history.replaceState({}, '', loginCallbackURL(window.location.search));
            setPath('/login');
        }
    }, [session.data, session.isPending, session.error, path]);
    const onSignedIn = () => { void session.refetch(); navigate('/dashboard'); };
    return <TooltipProvider delayDuration={300}>
    <a className="skip-link" href="#main-content">{t("跳转到内容")}</a>
    {session.isPending ? <><header className="masthead"><Brand navigate={navigate}/><LanguageSwitch /></header><main className="page-loading"><p role="status">{t("正在确认登录状态…")}</p></main></>
            : session.error ? <><header className="masthead"><Brand navigate={navigate}/><LanguageSwitch /></header><main className="page-loading"><h1>{t("无法确认登录状态")}</h1><p>{t("请检查网络和服务连接，再重试。")}</p><Button onClick={() => void session.refetch()}>{t("重试连接")}</Button></main></>
                : session.data ? <Workspace key={session.data.user.id} path={path} navigate={navigate} notify={message => toast(message)} onUnauthorized={() => { void session.refetch(); }}/>
                    : <><header className="masthead"><Brand navigate={navigate}/><LanguageSwitch /><span className="login-header-note">{t("个人价格警报与手机通知")}</span></header>{path === '/login' ? <Login onSignedIn={onSignedIn}/> : <main className="page-loading"><p role="status">{t("正在打开登录页面…")}</p></main>}</>}
    <Toaster customAriaLabel={t("通知")} position="bottom-center" duration={6500} offset={24} mobileOffset={16} toastOptions={{ className: 'ui-toast' }} />
  </TooltipProvider>;
}
function Workspace({ path, navigate, notify, onUnauthorized }: {
    path: string;
    navigate: (path: string) => void;
    notify: (text: string) => void;
    onUnauthorized: () => void;
}) {
    const model = useWorkspace(onUnauthorized);
    const [logoutBusy, setLogoutBusy] = useState(false);
    const [logoutError, setLogoutError] = useState('');
    async function logout() {
        if (logoutBusy)
            return;
        setLogoutBusy(true);
        setLogoutError('');
        try {
            const result = await authClient.signOut();
            if (result.error) {
                setLogoutError(t("退出未完成，请检查网络后重试。"));
                return;
            }
            navigate('/login');
        }
        catch {
            setLogoutError(t("退出未完成，请检查网络后重试。"));
        }
        finally {
            setLogoutBusy(false);
        }
    }
    const canAdmin = model.data?.status.user.role === 'admin' && model.data.status.capabilities.canAdmin;
    const tabs = [['/dashboard', t("行情与警报")], ['/notifications', t("手机通知")], ['/account', t("我的账户")], ...(canAdmin ? [['/admin', t("管理")]] : [])];
    return <>
    <header className="masthead"><Brand navigate={navigate}/><nav className="app-nav" aria-label={t("主导航")}>{tabs.map(([href, label]) => <a key={href} href={href} aria-current={path === href ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(href!); }}>{label}</a>)}</nav><div className="header-actions"><LanguageSwitch /><span className="session-email">{model.data?.status.user.email ?? t("已登录")}</span><Button disabled={logoutBusy} onClick={() => void logout()}>{logoutBusy ? t("正在退出…") : t("退出登录")}</Button></div></header>
    <main className="app-main" id="main-content"><FormError message={logoutError}/>{model.error && <div className="connection-error" role="alert"><p>{model.error}</p><Button disabled={model.busy} onClick={() => void model.refresh()}>{t("重新读取状态")}</Button></div>}
      {/* Keep the dashboard mounted across settings pages; polling never remounts the chart. */}
      <Dashboard model={model} active={path === '/dashboard' || !routes.includes(path)} notify={notify} navigate={navigate}/>
      {path === '/notifications' && <Notifications model={model} notify={notify}/>}
      {path === '/account' && <Account model={model} notify={notify}/>}
      {path === '/admin' && <Admin model={model} notify={notify}/>}
    </main><footer className="app-footer"><span>{t("价格哨站 · Open Alert")}</span><span>{t("后台判断价格，手机接收提醒。")}</span></footer>
  </>;
}
