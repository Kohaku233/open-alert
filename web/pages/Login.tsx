import { Panel, Notice, LoadingStatus } from '../components/Surface.js';
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
import { clearEmailLoginFlow, emailAddress, OTP_LIFETIME_MS, readEmailLoginFlow, saveEmailLoginFlow, withAttempt } from '../email-login-flow.js';
import type { EmailLoginFlow } from '../email-login-flow.js';

function initialFlow(): EmailLoginFlow {
    const saved = readEmailLoginFlow();
    const invited = emailAddress(new URLSearchParams(window.location.search).get('email') ?? '');
    return invited && invited !== emailAddress(saved.email) ? { ...saved, email: invited, step: 'email' } : saved;
}
export function Login({ onSignedIn }: { onSignedIn: () => void }) {
    const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);
    const [capError, setCapError] = useState('');
    const [flow, setFlow] = useState(initialFlow);
    const flowRef = useRef(flow);
    const [otp, setOtp] = useState('');
    const [action, setAction] = useState<'send' | 'verify' | 'google' | null>(null);
    const [error, setError] = useState(() => oauthCallbackErrorText(window.location.search));
    const [now, setNow] = useState(Date.now());
    const [showHelp, setShowHelp] = useState(false);
    const lock = useRef(false);
    const googleInFlight = useRef(false);
    const codeField = useRef<HTMLInputElement>(null);
    const emailField = useRef<HTMLInputElement>(null);
    const mounted = useRef(false);
    const busy = action !== null;
    const normalized = emailAddress(flow.email);
    const attempt = flow.attempts.find(item => item.email === normalized);
    const codeStep = flow.step === 'code' && Boolean(attempt);
    const cooldown = Math.max(0, Math.ceil(((attempt?.retryAt ?? 0) - now) / 1000));
    const expired = codeStep && (attempt?.expiresAt ?? 0) <= now;
    const uncertain = codeStep && (attempt?.delivery === 'uncertain' || attempt?.delivery === 'pending');

    function updateFlow(next: EmailLoginFlow) {
        flowRef.current = next;
        saveEmailLoginFlow(next);
        if (mounted.current) setFlow(next);
    }
    async function loadCapabilities() {
        setCapError('');
        try {
            const result = await request<AuthCapabilities>('/api/auth-capabilities');
            if (typeof result.google !== 'boolean' || typeof result.emailOtp !== 'boolean' || !['invite', 'open', 'closed'].includes(result.registration)) throw new Error('Invalid capabilities');
            if (mounted.current) setCapabilities(result);
        } catch (cause) { if (mounted.current) setCapError(errorText(cause)); }
    }
    useEffect(() => {
        mounted.current = true;
        // Invitation links only prefill the email; discard credentials and arbitrary redirects.
        if (window.location.search || window.location.hash) window.history.replaceState({}, '', '/login');
        saveEmailLoginFlow(flowRef.current);
        void loadCapabilities();
        const resume = () => {
            if (document.visibilityState === 'hidden') return;
            setNow(Date.now());
            // A restored Google page must be usable; email/verification requests keep their lock.
            if (lock.current && googleInFlight.current) { lock.current = false; googleInFlight.current = false; setAction(null); }
        };
        window.addEventListener('pageshow', resume);
        document.addEventListener('visibilitychange', resume);
        return () => {
            mounted.current = false;
            window.removeEventListener('pageshow', resume);
            document.removeEventListener('visibilitychange', resume);
        };
    }, []);
    useEffect(() => {
        if (!attempt || (attempt.retryAt <= Date.now() && (!codeStep || attempt.expiresAt <= Date.now()))) return;
        const timer = window.setInterval(() => {
            const timestamp = Date.now(); setNow(timestamp);
            if (timestamp >= Math.max(attempt.retryAt, codeStep ? attempt.expiresAt : 0)) window.clearInterval(timer);
        }, 1000);
        return () => window.clearInterval(timer);
    }, [attempt?.retryAt, attempt?.expiresAt, codeStep]);
    useEffect(() => { if (codeStep && !busy && capabilities?.emailOtp) codeField.current?.focus(); }, [codeStep, busy, capabilities?.emailOtp]);
    function begin(next: NonNullable<typeof action>) {
        if (lock.current) return false;
        lock.current = true; setAction(next); setError(''); return true;
    }
    function finish() { lock.current = false; googleInFlight.current = false; if (mounted.current) setAction(null); }
    async function sendOtp(event?: FormEvent) {
        event?.preventDefault();
        const current = flowRef.current, email = emailAddress(current.email);
        const previous = current.attempts.find(item => item.email === email);
        if (!email || !capabilities?.emailOtp || Date.now() < (previous?.retryAt ?? 0) || !begin('send')) return;
        const requestedAt = Date.now();
        const sending = { email, requestedAt, expiresAt: requestedAt + OTP_LIFETIME_MS, retryAt: requestedAt + 60_000, delivery: 'pending' as const };
        // Save before sending so even a reload during the request can resume without replaying it.
        updateFlow(withAttempt({ ...current, email, step: 'code' }, sending));
        setNow(requestedAt); setOtp('');
        let retryAt = sending.retryAt;
        try {
            const result = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' }, {
                onError: context => { if (context.response.status === 429) retryAt = retryDeadline(context.response.headers.get('Retry-After')); },
            });
            if (!mounted.current) return;
            if (result.error) {
                const ambiguous = result.error.code?.toUpperCase() === 'EMAIL_UNCERTAIN';
                // Keep an earlier code step usable on a failed resend; never invent success.
                const keepCode = ambiguous || (current.step === 'code' && previous && previous.delivery !== 'failed');
                updateFlow(withAttempt({ ...flowRef.current, step: keepCode ? 'code' : 'email' }, ambiguous
                    ? { ...sending, retryAt, delivery: 'uncertain' }
                    : { ...(keepCode ? previous! : sending), retryAt, delivery: keepCode ? previous!.delivery : 'failed' }));
                if (mounted.current) setError(authErrorText(result.error));
                return;
            }
            updateFlow(withAttempt(flowRef.current, { ...sending, retryAt, delivery: 'accepted' }));
        } catch {
            if (mounted.current) updateFlow(withAttempt(flowRef.current, { ...sending, retryAt, delivery: 'uncertain' }));
        } finally { finish(); }
    }
    async function signIn(event: FormEvent) {
        event.preventDefault();
        if (!codeStep || expired || !/^\d{6}$/.test(otp) || !capabilities?.emailOtp || !begin('verify')) return;
        try {
            const result = await authClient.signIn.emailOtp({ email: normalized, otp });
            if (!mounted.current) return;
            if (result.error) { setError(authErrorText(result.error)); codeField.current?.select(); return; }
            clearEmailLoginFlow(); setOtp(''); onSignedIn();
        } catch { if (mounted.current) setError(t('登录未完成，请检查网络后重试。')); }
        finally { finish(); }
    }
    async function google() {
        if (!capabilities?.google || !begin('google')) return;
        googleInFlight.current = true;
        try {
            const result = await authClient.signIn.social({ provider: 'google', callbackURL: window.location.origin + '/dashboard', errorCallbackURL: window.location.origin + '/login' });
            if (mounted.current && result.error) setError(oauthErrorText(result.error));
        } catch { if (mounted.current) setError(t('无法连接 Google 登录，请检查网络后重试，也可使用邮箱验证码登录。')); }
        finally { finish(); }
    }
    function changeEmail() {
        updateFlow({ ...flowRef.current, step: 'email' });
        setOtp(''); setError(''); setNow(Date.now());
        window.setTimeout(() => emailField.current?.focus(), 0);
    }
    const registrationCopy = capabilities?.registration === 'open'
        ? t('已有账号将直接登录；新邮箱验证后自动创建账户。无需设置密码。')
        : capabilities?.registration === 'closed'
            ? t('仅已有账户可登录，新注册已关闭。')
            : t('已有账号可直接登录；新用户须先获邀，验证邮箱后创建账户。无需设置密码。');
    return <main className="login-layout" id="main-content">
      <section className="login-intro"><div className="signal-mark" aria-hidden="true"><span/><span/><span/></div><h1>{t('盯住价格，')}<br/>{t('把提醒交给哨站。')}</h1><p>{t('Binance、OKX、MEXC 现货与 USDT 永续价格警报。每条警报触发一次，Pushover 把结果送到你的手机。')}</p><div className="intro-detail"><strong>{t('达到或高于 / 达到或低于')}</strong><p>{t('以后台最新成交价判断。触发后保持锁定，直到你明确重新武装。')}</p></div><p className="small muted">{t('后台运行时无需保持页面打开。')}</p></section>
      <Panel className="login-panel" aria-labelledby="login-heading" aria-busy={busy}>
        <h2 id="login-heading">{codeStep ? t('验证邮箱') : t('登录或注册')}</h2>
        {!capabilities && !codeStep && !capError ? <LoadingStatus>{t('正在读取可用登录方式…')}</LoadingStatus> : <p className="auth-description">{codeStep ? t('输入邮件中的 6 位验证码，完成身份验证。') : registrationCopy}</p>}
        {capError && <><FormError message={capError}/><Button onClick={() => void loadCapabilities()}>{t('重试读取登录方式')}</Button></>}
        {!codeStep ? <>
          <form onSubmit={event => void sendOtp(event)}>
            <Label htmlFor="login-email">{t('邮箱地址')}</Label><Input ref={emailField} id="login-email" name="email" type="email" maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} required value={flow.email} disabled={busy || !capabilities?.emailOtp} onChange={event => { updateFlow({ ...flowRef.current, email: event.target.value }); setNow(Date.now()); setError(''); }} placeholder={t('你的邮箱地址')} aria-describedby="login-error"/>
            <Button variant="default" type="submit" className="primary wide" disabled={busy || !capabilities?.emailOtp || cooldown > 0}>{action === 'send' ? t('正在发送…') : cooldown > 0 ? t('{0} 秒后可重新发送', cooldown) : t('发送验证码')}</Button>
            {attempt && attempt.delivery !== 'failed' && <Button variant="ghost" type="button" disabled={busy} onClick={() => { updateFlow({ ...flowRef.current, email: normalized, step: 'code' }); setError(''); }}>{t('已有验证码？继续验证')}</Button>}
          </form>
          {capabilities?.google && <><div className="form-divider"><span>{t('或')}</span></div><Button type="button" className="google-button" disabled={busy} onClick={() => void google()}><Icon name="google"/>{action === 'google' ? t('正在前往 Google…') : t('使用 Google 登录')}</Button><p className="auth-method-note">{t('使用与账户或邀请一致的 Google 邮箱。')}</p></>}
        </> : <form onSubmit={event => void signIn(event)}>
          <div className="auth-email-summary"><span>{normalized}</span><Button variant="ghost" type="button" disabled={busy} onClick={changeEmail}>{t('更换邮箱')}</Button></div>
          {action === 'send' ? <p className="auth-delivery-note" role="status">{t('正在发送验证码，请稍候…')}</p> : uncertain ? <p className="auth-delivery-note warning" role="status">{t('尚未确认邮件是否送达。请先检查邮箱；收到验证码后可直接输入，无需再次发送。')}</p> : <p className="auth-delivery-note" role="status">{t('验证码邮件已发送，请检查收件箱或垃圾邮件。')}</p>}
          <Label htmlFor="login-otp">{t('邮件中的验证码')}</Label><Input ref={codeField} id="login-otp" className="otp-input" name="otp" type="text" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={otp} onChange={event => { setOtp(event.target.value.replace(/\D/g, '')); setError(''); }} disabled={busy || expired || !capabilities?.emailOtp} aria-describedby="otp-hint login-error"/>
          <p id="otp-hint" className={expired ? 'auth-code-hint expired' : 'auth-code-hint'}>{expired ? t('验证码已过期，请重新发送。') : t('验证码 5 分钟内有效，重发后请使用最新一封邮件中的验证码。')}</p>
          <Button variant="default" type="submit" className="primary wide" disabled={busy || expired || !capabilities?.emailOtp || otp.length !== 6}>{action === 'verify' ? t('正在验证…') : t('验证并继续')}</Button>
          <div className="auth-resend"><span>{t('没有收到邮件？')}</span><Button variant="ghost" type="button" disabled={busy || !capabilities?.emailOtp || cooldown > 0} onClick={() => void sendOtp()}>{action === 'send' ? t('正在发送…') : cooldown > 0 ? t('{0} 秒后重发', cooldown) : t('重新发送')}</Button></div>
        </form>}
        <div id="login-error"><FormError message={error}/></div>
        {capabilities?.emailOtp && capabilities.emailSenderMode === 'resend_sandbox' && <Notice as="p" className="warning">{t('邮件服务目前为测试模式，仅支持预设的测试收件人。其他获邀邮箱可使用 Google 登录；邮箱验证码需管理员配置并验证发件域名。')}</Notice>}
        {capabilities && !capabilities.emailOtp && <Notice as="p" className="warning">{t('邮箱登录尚未启用。部署管理员需要配置可用的邮件服务，完成后才能发送验证码。')}</Notice>}
        <Button variant="ghost" className="text-button setup-link" aria-expanded={showHelp} aria-controls="login-help" onClick={() => setShowHelp(value => !value)}>{t('登录遇到问题？')}</Button>
        {showHelp && <div id="login-help" className="setup-note"><p>{t('收不到验证码时，先确认受邀邮箱并检查垃圾邮件。等待重发倒计时结束后再试。')}</p><p>{t('Google 选错账号时，重新点击 Google 登录并选择获邀邮箱。邀请过期或账户停用时，请联系管理员。')}</p></div>}
        <p className="small muted login-footnote">{codeStep ? t('可以切换到邮箱查看邮件；返回或刷新页面后会保留验证进度。') : t('会话由安全 Cookie 管理。此页面不会保存登录令牌。')}</p>
      </Panel>
    </main>;
}
