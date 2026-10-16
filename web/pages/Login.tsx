import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { t } from '../i18n.js';
import { Icon } from '../components/Icon.js';
import { authClient } from '../auth.js';
import { authErrorText, errorText, oauthCallbackErrorText, oauthErrorText, request, retryDeadline } from '../api.js';
import type { AuthCapabilities } from '../api.js';
import { FormError } from '../components/Dialog.js';
function invitationEmail() {
    const value = new URLSearchParams(window.location.search).get('email')?.trim().toLowerCase() ?? '';
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : '';
}
export function Login({ onSignedIn }: { onSignedIn: () => void }) {
    const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);
    const [capError, setCapError] = useState('');
    const [email, setEmail] = useState(invitationEmail);
    const [sentEmail, setSentEmail] = useState('');
    const [otp, setOtp] = useState('');
    const [action, setAction] = useState<'send' | 'verify' | 'google' | null>(null);
    const [error, setError] = useState(() => oauthCallbackErrorText(window.location.search));
    const [deadline, setDeadline] = useState(0);
    const [now, setNow] = useState(Date.now());
    const [showHelp, setShowHelp] = useState(false);
    const lock = useRef(false);
    const cooldowns = useRef<Record<string, number>>({});
    const codeField = useRef<HTMLInputElement>(null);
    const busy = action !== null;
    const cooldown = Math.max(0, Math.ceil((deadline - now) / 1000));
    async function loadCapabilities() {
        setCapError('');
        try {
            const result = await request<AuthCapabilities>('/api/auth-capabilities');
            if (typeof result.google !== 'boolean' || typeof result.emailOtp !== 'boolean' || !['invite', 'open', 'closed'].includes(result.registration)) throw new Error('Invalid capabilities');
            setCapabilities(result);
        } catch (cause) { setCapError(errorText(cause)); }
    }
    useEffect(() => {
        // Read only the invitation email; discard callback credentials and arbitrary redirects.
        if (window.location.search || window.location.hash) window.history.replaceState({}, '', '/login');
        void loadCapabilities();
        const reset = () => { lock.current = false; setAction(null); setNow(Date.now()); };
        window.addEventListener('pageshow', reset);
        return () => window.removeEventListener('pageshow', reset);
    }, []);
    useEffect(() => {
        if (deadline <= Date.now()) return;
        const timer = window.setInterval(() => { const timestamp = Date.now(); setNow(timestamp); if (timestamp >= deadline) window.clearInterval(timer); }, 250);
        return () => window.clearInterval(timer);
    }, [deadline]);
    useEffect(() => { if (sentEmail) codeField.current?.focus(); }, [sentEmail]);
    function begin(next: NonNullable<typeof action>) {
        if (lock.current) return false;
        lock.current = true; setAction(next); setError(''); return true;
    }
    function finish() { lock.current = false; setAction(null); }
    async function sendOtp(event?: FormEvent) {
        event?.preventDefault();
        if (!capabilities?.emailOtp || Date.now() < deadline || !begin('send')) return;
        const normalized = (sentEmail || email).trim().toLowerCase();
        setNow(Date.now()); cooldowns.current[normalized] = Date.now() + 60_000; setDeadline(cooldowns.current[normalized]!);
        try {
            const result = await authClient.emailOtp.sendVerificationOtp({ email: normalized, type: 'sign-in' }, {
                onError: context => { if (context.response.status === 429) { cooldowns.current[normalized] = retryDeadline(context.response.headers.get('Retry-After')); setDeadline(cooldowns.current[normalized]!); } },
            });
            if (result.error) {
                setError(authErrorText(result.error));
                if (result.error.code?.toUpperCase() === 'EMAIL_UNCERTAIN') setSentEmail(normalized);
                return;
            }
            setSentEmail(normalized); setOtp('');
        } catch {
            // A disconnected send may have reached the provider. Allow code entry without replay.
            setSentEmail(normalized);
            setError(t('未能确认验证码是否发送。请先检查邮箱；收到后可直接输入，稍后再决定是否重发。'));
        } finally { finish(); }
    }
    async function signIn(event: FormEvent) {
        event.preventDefault();
        if (!sentEmail || !/^\d{6}$/.test(otp) || !capabilities?.emailOtp || !begin('verify')) return;
        try {
            const result = await authClient.signIn.emailOtp({ email: sentEmail, otp });
            if (result.error) { setError(authErrorText(result.error)); codeField.current?.select(); return; }
            setOtp(''); onSignedIn();
        } catch { setError(t('登录未完成，请检查网络后重试。')); }
        finally { finish(); }
    }
    async function google() {
        if (!capabilities?.google || !begin('google')) return;
        setOtp('');
        try {
            const result = await authClient.signIn.social({ provider: 'google', callbackURL: `${window.location.origin}/dashboard`, errorCallbackURL: `${window.location.origin}/login` });
            if (result.error) setError(oauthErrorText(result.error));
        } catch { setError(t('无法连接 Google 登录，请检查网络后重试，也可使用邮箱验证码登录。')); }
        finally { finish(); }
    }
    const registrationCopy = capabilities?.registration === 'open' ? t('首次登录会创建账户。') : capabilities?.registration === 'closed' ? t('仅已有账户可登录，新注册已关闭。') : t('新账户需要管理员邀请，请使用获邀邮箱。');
    return <main className="login-layout">
      <section className="login-intro"><div className="signal-mark" aria-hidden="true"><span/><span/><span/></div><h1>{t('盯住价格，')}<br/>{t('把提醒交给哨站。')}</h1><p>{t('Binance、OKX、MEXC 现货与 USDT 永续价格警报。每条警报触发一次，Pushover 把结果送到你的手机。')}</p><div className="intro-detail"><strong>{t('达到或高于 / 达到或低于')}</strong><p>{t('以后台最新成交价判断。触发后保持锁定，直到你明确重新武装。')}</p></div><p className="small muted">{t('后台运行时无需保持页面打开。')}</p></section>
      <section className="login-panel" aria-labelledby="login-heading" aria-busy={busy}>
        <h2 id="login-heading">{t('登录我的哨站')}</h2><p className="muted small">{capabilities ? registrationCopy : t('正在读取可用登录方式…')}</p>
        {capError && <><FormError message={capError}/><Button onClick={() => void loadCapabilities()}>{t('重试读取登录方式')}</Button></>}
        <Button className="google-button" disabled={!capabilities?.google || busy} onClick={() => void google()}><Icon name="google"/>{action === 'google' ? t('正在前往 Google…') : t('使用 Google 登录')}</Button>
        {capabilities?.google && <p className="auth-method-note">{t('选择与受邀邮箱一致的 Google 账号。两种登录方式共用同一账户。')}</p>}
        {capabilities && !capabilities.google && <p className="small muted">{t('此部署尚未配置 Google 登录。')}</p>}
        <div className="form-divider"><span>{t('邮箱验证码')}</span></div>
        {!sentEmail ? <form onSubmit={event => void sendOtp(event)}>
          <Label htmlFor="login-email">{t('邮箱地址')}</Label><Input id="login-email" name="email" type="email" maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} required value={email} disabled={busy || !capabilities?.emailOtp} onChange={event => { setEmail(event.target.value); setNow(Date.now()); setDeadline(cooldowns.current[event.target.value.trim().toLowerCase()] ?? 0); setError(''); }} placeholder={t('你的邮箱地址')} aria-describedby="login-error"/>
          <Button variant="default" className="primary wide" disabled={busy || !capabilities?.emailOtp || cooldown > 0}>{action === 'send' ? t('正在发送…') : cooldown > 0 ? t('{0} 秒后可重新发送', cooldown) : t('发送登录验证码')}</Button>
        </form> : <form onSubmit={event => void signIn(event)}>
          <p className="otp-notice" role="status">{t('如果此邮箱符合登录条件，验证码将发送至 ')}<strong>{sentEmail}</strong>{t('。请查收邮件与垃圾邮件。')}</p>
          <Label htmlFor="login-otp">{t('邮件中的验证码')}</Label><Input ref={codeField} id="login-otp" className="otp-input" name="otp" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={otp} onChange={event => { setOtp(event.target.value.replace(/\D/g, '')); setError(''); }} disabled={busy} aria-describedby="otp-hint login-error"/>
          <p id="otp-hint" className="small muted">{t('6 位数字，5 分钟内有效。重发后请使用最新验证码。')}</p>
          <Button variant="default" className="primary wide" disabled={busy || !capabilities?.emailOtp || otp.length !== 6}>{action === 'verify' ? t('正在验证…') : t('验证并登录')}</Button>
          <div className="inline-actions"><Button type="button" disabled={busy || cooldown > 0} onClick={() => void sendOtp()}>{action === 'send' ? t('正在发送…') : cooldown > 0 ? t('{0} 秒后重发', cooldown) : t('重新发送')}</Button><Button type="button" disabled={busy} onClick={() => { setSentEmail(''); setOtp(''); setError(''); }}>{t('更换邮箱')}</Button></div>
        </form>}
        <div id="login-error"><FormError message={error}/></div>
        {capabilities?.emailOtp && capabilities.emailSenderMode === 'resend_sandbox' && <p className="warning">{t('邮件服务目前为测试模式，仅支持预设的测试收件人。其他获邀邮箱可使用 Google 登录；邮箱验证码需管理员配置并验证发件域名。')}</p>}
        {capabilities && !capabilities.emailOtp && <p className="warning">{t('邮箱登录尚未启用。部署管理员需要配置可用的邮件服务，完成后才能发送验证码。')}</p>}
        <Button variant="ghost" className="text-button setup-link" aria-expanded={showHelp} aria-controls="login-help" onClick={() => setShowHelp(value => !value)}>{t('登录遇到问题？')}</Button>
        {showHelp && <div id="login-help" className="setup-note"><p>{t('收不到验证码时，先确认受邀邮箱并检查垃圾邮件。等待重发倒计时结束后再试。')}</p><p>{t('Google 选错账号时，重新点击 Google 登录并选择获邀邮箱。邀请过期或账户停用时，请联系管理员。')}</p></div>}
        <p className="small muted login-footnote">{t('会话由安全 Cookie 管理。此页面不会保存登录令牌。')}</p>
      </section>
    </main>;
}
