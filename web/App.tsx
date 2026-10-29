import { AccountMenu } from './components/AccountMenu.js';
import { Appearance } from './components/Appearance.js';
import { Notice, EmptyState } from './components/Surface.js';
import { BootStageProvider, useBootClaim, useBootVisible } from './components/BootStage.js';
import { Toaster } from './components/ui/sonner.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { toast } from 'sonner';
import { Button } from './components/ui/button.js';
import { t } from './i18n.js';
import { Icon } from './components/Icon.js';
import { useLanguage, setLanguage } from './i18n.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authClient } from './auth.js';
import { clearEmailLoginFlow } from './email-login-flow.js';
import { loginCallbackURL } from './api.js';
import { useWorkspace } from './model.js';
import { Login } from './pages/Login.js';
import { Dashboard } from './pages/Dashboard.js';
import { Notifications } from './pages/Notifications.js';
import { Account } from './pages/Account.js';
import { Admin } from './pages/Admin.js';
import { Anomaly } from './pages/Anomaly.js';
import { FormError } from './components/Dialog.js';
import { useIndicatorMotion } from './motion.js';
import { Activity, BellRing, ShieldCheck, Settings2, List, Radar }  from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
const routes = ['/dashboard', '/alerts', '/anomaly', '/notifications', '/settings', '/account', '/admin'];
function LanguageSwitch() {
    const language = useLanguage();
    const root = useRef<HTMLDivElement>(null), indicator = useRef<HTMLSpanElement>(null);
    useIndicatorMotion(root, indicator, '[aria-pressed="true"]', language);
    return <div className="preferences"><Appearance/><div ref={root} className="languages" role="group" aria-label={t("界面语言")}><span ref={indicator} className="segment-indicator" aria-hidden="true"/><Button type="button" aria-pressed={language === "zh-CN"} onClick={() => setLanguage("zh-CN")}>{t("中文")}</Button><Button type="button" aria-pressed={language === "en"} onClick={() => setLanguage("en")}>EN</Button></div></div>;
}
function Brand({ navigate }: {
    navigate: (path: string) => void;
}) {
    return <a className="brand" href="/dashboard" aria-label={t("价格哨站")} onClick={event => { event.preventDefault(); navigate('/dashboard'); }}><Icon name="brand" className="brand-mark"/><span>{t("价格哨站")}<small>openalert</small></span></a>;
}
export function App() {
    return <BootStageProvider><AppRoutes/></BootStageProvider>;
}
function AppRoutes() {
    useLanguage();
    const session = authClient.useSession();
    const visible = useBootVisible();
    const [sessionKnown, setSessionKnown] = useState(false);
    useEffect(() => {
        if (!session.isPending && !session.error) setSessionKnown(true);
        if (session.data) clearEmailLoginFlow();
    }, [session.isPending, session.error, session.data]);
    const [path, setPath] = useState(window.location.pathname);
    // The entrance covers the session handshake and the sign-in redirect, so the
    // first paint is never a half-built layout.
    useBootClaim(t("正在确认登录状态…"), session.isPending && !sessionKnown, 'session');
    useBootClaim(t("正在打开登录页面…"), !session.isPending && sessionKnown && !session.data && path !== '/login');
    const navigate = useCallback((next: string) => { window.history.pushState({}, '', next); setPath(new URL(next, window.location.href).pathname); window.scrollTo({ top: 0, behavior: 'instant' }); }, []);
    useEffect(() => { const pop = () => setPath(window.location.pathname); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
    useEffect(() => {
        if (session.isPending || (session.error && !sessionKnown))
            return;
        if (session.data && path === '/account') {
            window.history.replaceState({}, '', '/settings' + window.location.search);
            setPath('/settings');
            return;
        }
        if (session.data && (!routes.includes(path) || path === '/login')) {
            window.history.replaceState({}, '', '/dashboard');
            setPath('/dashboard');
        }
        else if (!session.data && path !== '/login') {
            window.history.replaceState({}, '', loginCallbackURL(window.location.search));
            setPath('/login');
        }
    }, [session.data, session.isPending, session.error, sessionKnown, path]);
    const onSignedIn = () => { void session.refetch(); navigate('/dashboard'); };
    if (!visible) return null;
    return <TooltipProvider delayDuration={300}>
    <a className="skip-link" href="#main-content">{t("跳转到内容")}</a>
    {session.isPending && !sessionKnown ? <><header className="masthead public-masthead"><Brand navigate={navigate}/><LanguageSwitch /></header><main className="app-main" id="main-content"/></>
            : session.error && !sessionKnown ? <><header className="masthead public-masthead"><Brand navigate={navigate}/><LanguageSwitch /></header><main className="app-main" id="main-content"><EmptyState className="session-error"><h1>{t("无法确认登录状态")}</h1><p>{session.error.status === 429 ? t("请求过于频繁，请稍后重试。") : t("请检查网络和服务连接，再重试。")}</p><Button onClick={() => void session.refetch()}>{t("重试连接")}</Button></EmptyState></main></>
                : session.data ? <Workspace key={session.data.user.id} path={path} navigate={navigate} notify={message => toast(message)} onUnauthorized={() => { void session.refetch(); }}/>
                    : <div className="public-shell"><header className="masthead public-masthead"><Brand navigate={navigate}/><span className="login-header-note">{t("个人价格警报与手机通知")}</span><LanguageSwitch /></header>{path === '/login' ? <Login onSignedIn={onSignedIn}/> : <main className="app-main" id="main-content"/>}</div>}
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
    const bootLabel = path === '/settings' || path === '/account' ? t("正在读取账户信息…") : path === '/notifications' ? t("正在读取通知设置…") : path === '/anomaly' ? t("正在读取异动监测…") : t("正在读取你的警报与行情…");
    useBootClaim(bootLabel, !model.data && !model.error);
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
            clearEmailLoginFlow();
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
    const navRef = useRef<HTMLElement>(null), navIndicator = useRef<HTMLSpanElement>(null);
    const tabs: Array<[string, string, LucideIcon]> = [['/dashboard', t("行情与警报"), Activity], ['/anomaly', t("异动监测"), Radar], ['/notifications', t("通知中心"), BellRing], ['/settings', t("设置"), Settings2], ...(canAdmin ? [['/admin', t("管理"), ShieldCheck] as [string, string, LucideIcon]] : [])];
    useIndicatorMotion(navRef, navIndicator, '[aria-current="page"]', path + tabs.map(tab => tab[1]).join());
    const monitoring = model.data?.status.settings.enabled;
    return <div className="workspace-shell" data-route={path}>
    <header className="masthead app-rail">
      <Brand navigate={navigate}/>

      <nav ref={navRef} className="app-nav" aria-label={t("主导航")}><span ref={navIndicator} className="nav-indicator" aria-hidden="true"/>{tabs.map(([href, label, NavIcon]) => <a key={href} href={href} aria-current={(path === href || path === '/alerts' && href === '/dashboard') ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(href!); }}><NavIcon className="nav-icon" aria-hidden="true"/><span>{label}</span></a>)}</nav>
      <div className="rail-footer">
        <div className="rail-status"><span className={`rail-status-dot ${monitoring ? 'is-live' : ''}`} aria-hidden="true"/><span>{model.wakePending ? t("后台同步待确认") : monitoring ? t("监控已启用") : t("监控已暂停")}</span></div>
        <AccountMenu name={model.data?.status.user.name || model.data?.status.user.email.split('@')[0] || t('已登录')} email={model.data?.status.user.email || ''} navigate={navigate} logout={() => void logout()} busy={logoutBusy}/>

      </div>
    </header>
    <main className="app-main" id="main-content"><FormError message={logoutError}/>{model.wakePending && <Notice className="warning scheduler-wake-warning" role="status"><p>{t("修改已保存，但后台同步尚未确认。系统会自动补偿检查；可重新读取状态确认，请勿重复提交。")}</p></Notice>}{model.error && <Notice className="connection-error" role="alert"><p>{model.error}</p><Button disabled={model.busy} onClick={() => void model.refresh()}>{t("重新读取状态")}</Button></Notice>}
      {/* Keep the dashboard mounted across settings pages; polling never remounts the chart. */}
      <Dashboard model={model} active={path === '/dashboard' || path === '/alerts' || !routes.includes(path)} alertsOnly={path === '/alerts'} notify={notify} navigate={navigate}/>
      {path === '/anomaly' && <Anomaly model={model} notify={notify} navigate={navigate}/>}
      {path === '/notifications' && <Notifications model={model} notify={notify} navigate={navigate}/>}
      {path === '/settings' && <Account model={model} notify={notify} navigate={navigate} logout={() => void logout()} logoutBusy={logoutBusy}/>}
      {path === '/admin' && <Admin model={model} notify={notify}/>}
    </main><nav className="mobile-dock" aria-label={t('移动导航')}>
      {([['/dashboard', '行情', Activity], ['/alerts', '警报', List], ['/anomaly', '异动', Radar], ['/notifications', '通知', BellRing], ['/settings', '设置', Settings2]] as const).map(([href, label, Glyph]) => <a key={href} href={href} aria-current={path === href ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(href); }}><Glyph aria-hidden="true"/><span>{t(label)}</span></a>)}
    </nav><footer className="app-footer"><span>{t("价格哨站 · Open Alert")}</span><span>{t("后台判断价格，手机接收提醒。")}</span><span className="footer-signal" aria-hidden="true">{t("SIGNAL / 24H")}</span></footer>
  </div>;
}
