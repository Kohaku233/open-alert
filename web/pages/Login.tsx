import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { authClient } from '../auth.js';
import { authErrorText, errorText, oauthCallbackErrorText, oauthErrorText, request } from '../api.js';
import type { AuthCapabilities } from '../api.js';
import { FormError } from '../components/Dialog.js';

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);
  const [capError, setCapError] = useState('');
  const [email, setEmail] = useState('');
  const [sentEmail, setSentEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => oauthCallbackErrorText(window.location.search));
  const [cooldown, setCooldown] = useState(0);
  const [showSetup, setShowSetup] = useState(false);
  async function loadCapabilities() {
    setCapError('');
    try {
      const result = await request<AuthCapabilities>('/api/auth-capabilities');
      if (typeof result.google !== 'boolean' || typeof result.emailOtp !== 'boolean' || !['invite', 'open', 'closed'].includes(result.registration)) throw new Error('Invalid capabilities');
      setCapabilities(result);
    } catch (cause) { setCapError(errorText(cause)); }
  }
  useEffect(() => {
    // Capture the safe message in state, then discard every callback query and hash.
    if (window.location.search || window.location.hash) window.history.replaceState({}, '', '/login');
    void loadCapabilities();
  }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  async function sendOtp(event?: FormEvent) {
    event?.preventDefault(); if (busy || !capabilities?.emailOtp || cooldown > 0) return;
    setBusy(true); setError('');
    try {
      const normalized = email.trim().toLowerCase();
      const result = await authClient.emailOtp.sendVerificationOtp({ email: normalized, type: 'sign-in' });
      if (result.error) { setError(authErrorText(result.error)); return; }
      setSentEmail(normalized); setOtp(''); setCooldown(60);
    } catch { setError('验证码发送未完成，请检查网络或联系管理员。'); }
    finally { setBusy(false); }
  }
  async function signIn(event: FormEvent) {
    event.preventDefault(); if (busy || !capabilities?.emailOtp) return;
    setBusy(true); setError('');
    try {
      const result = await authClient.signIn.emailOtp({ email: sentEmail, otp: otp.trim() });
      if (result.error) { setError(authErrorText(result.error)); return; }
      setOtp(''); onSignedIn();
    } catch { setError('登录未完成，请检查网络后重试。'); }
    finally { setBusy(false); }
  }
  async function google() {
    if (busy || !capabilities?.google) return;
    setBusy(true); setError('');
    try {
      const result = await authClient.signIn.social({ provider: 'google', callbackURL: `${window.location.origin}/dashboard`, errorCallbackURL: `${window.location.origin}/login` });
      if (result.error) setError(oauthErrorText(result.error));
    } catch { setError('无法连接 Google 登录，请检查网络后重试，也可使用邮箱验证码登录。'); }
    finally { setBusy(false); }
  }
  const registrationCopy = capabilities?.registration === 'open' ? '首次登录会创建账户。' : capabilities?.registration === 'closed' ? '仅已有账户可登录，新注册已关闭。' : '新账户需要管理员邀请，请使用获邀邮箱。';
  return <main className="login-layout">
    <section className="login-intro"><div className="signal-mark" aria-hidden="true"><span /><span /><span /></div><h1>盯住价格，<br />把提醒交给哨站。</h1><p>Binance、OKX、MEXC 现货与 USDT 永续价格警报。每条警报触发一次，Pushover 把结果送到你的手机。</p><div className="intro-detail"><strong>达到或高于 / 达到或低于</strong><p>以后台最新成交价判断。触发后保持锁定，直到你明确重新武装。</p></div><p className="small muted">后台运行时无需保持页面打开。</p></section>
    <section className="login-panel" aria-labelledby="login-heading"><h2 id="login-heading">登录我的哨站</h2><p className="muted small">{capabilities ? registrationCopy : '正在读取可用登录方式…'}</p>
      {capError && <><FormError message={capError} /><button onClick={() => void loadCapabilities()}>重试读取登录方式</button></>}
      <button className="google-button" disabled={!capabilities?.google || busy} onClick={() => void google()}><span className="google-letter" aria-hidden="true">G</span>使用 Google 登录</button>
      {capabilities && !capabilities.google && <p className="small muted">此部署尚未配置 Google 登录。</p>}
      <div className="form-divider"><span>邮箱验证码</span></div>
      {!sentEmail ? <form onSubmit={event => void sendOtp(event)}><label>邮箱地址<input type="email" autoComplete="email" autoCapitalize="none" required value={email} disabled={busy || !capabilities?.emailOtp} onChange={event => setEmail(event.target.value)} placeholder="你的邮箱地址" /></label><button className="primary wide" disabled={busy || !capabilities?.emailOtp || cooldown > 0}>{busy ? '正在发送…' : cooldown > 0 ? `${cooldown} 秒后可重新发送` : '发送登录验证码'}</button></form>
      : <form onSubmit={event => void signIn(event)}><p className="otp-notice" role="status">如果此邮箱符合登录条件，验证码将发送至 <strong>{sentEmail}</strong>。请查收邮件与垃圾邮件。</p><label>邮件中的验证码<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoFocus value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, ''))} disabled={busy} /></label><button className="primary wide" disabled={busy || !capabilities?.emailOtp}>{busy ? '正在验证…' : '验证并登录'}</button><div className="inline-actions"><button type="button" disabled={busy || cooldown > 0} onClick={() => void sendOtp()}>{cooldown > 0 ? `${cooldown} 秒后重发` : '重新发送'}</button><button type="button" disabled={busy} onClick={() => { setSentEmail(''); setOtp(''); setError(''); }}>更换邮箱</button></div></form>}
      <FormError message={error} />
      {capabilities && !capabilities.emailOtp && <p className="warning">邮箱登录尚未启用。部署管理员需要配置可用的邮件服务，完成后才能发送验证码。</p>}
      <button className="text-button setup-link" onClick={() => setShowSetup(value => !value)}>部署登录方式说明</button>
      {showSetup && <div className="setup-note"><p>Google：管理员在服务端配置 OAuth 客户端，回调地址为当前站点的 <code>/api/auth/callback/google</code>。</p><p>邮箱：管理员配置 SMTP（Node）或 Resend 与已验证的发件地址。密钥只配置在服务端。</p><p>登录方式不可用时请联系部署管理员。</p></div>}
      <p className="small muted login-footnote">会话由安全 Cookie 管理。此页面不会保存登录令牌。</p>
    </section>
  </main>;
}
