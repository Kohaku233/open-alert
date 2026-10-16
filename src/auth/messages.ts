/** Transactional messages contain both supported languages and a plain-text alternative. */
function escape(value: string) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
function loginURL(appUrl: string, email: string) {
  const url = new URL('/login', appUrl);
  url.searchParams.set('email', email);
  return url.href;
}
function layout(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f4f4;color:#171717;font:15px/1.7 Arial,sans-serif"><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td style="padding:32px 20px"><table role="presentation" style="width:100%;max-width:520px;margin:auto;background:#fff;border:1px solid #ddd;border-collapse:collapse"><tr><td style="padding:32px"><p style="margin:0 0 28px;font:600 13px Arial,sans-serif;letter-spacing:1px">价格哨站 · OPEN ALERT</p><h1 style="font:600 24px/1.4 Arial,sans-serif;margin:0 0 20px">${title}</h1>${body}<hr style="border:0;border-top:1px solid #ddd;margin:28px 0"><p style="font-size:12px;color:#666;margin:0">如果并非你本人发起，请忽略此邮件。<br><span lang="en">If you did not expect this email, you can ignore it.</span></p></td></tr></table></td></tr></table></body></html>`;
}
export function otpMessage(appUrl: string, email: string, otp: string) {
  const url = loginURL(appUrl, email);
  return {
    subject: '价格哨站 · Open Alert 登录验证码 / Sign-in code',
    text: `你的价格哨站登录验证码：${otp}\n5 分钟内有效，仅限本人登录使用。请勿向任何人提供验证码。\n\nYour Open Alert sign-in code is ${otp}. It expires in 5 minutes. Never share this code.\n${url}\n\n如果并非你本人发起，请忽略此邮件。If you did not request it, ignore this message.`,
    html: layout('登录验证码 / Sign-in code', `<p>登录邮箱：${escape(email)}</p><p style="font:600 34px/1.5 Consolas,monospace;letter-spacing:7px;margin:24px 0">${escape(otp)}</p><p>5 分钟内有效。请在刚才的登录页面输入，勿与他人分享。</p><p lang="en">Enter this code on your sign-in page within 5 minutes. Never share it with anyone.</p><p><a href="${escape(url)}" style="color:#171717">打开价格哨站 / Open Alert</a></p>`),
  };
}
export function invitationMessage(appUrl: string, email: string, expiresAt: number | undefined, google: boolean) {
  const url = loginURL(appUrl, email);
  const expiry = expiresAt ? new Date(expiresAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace(/\.\d{3}Z$/, ' UTC') : '';
  const methods = google ? 'Google 或邮箱验证码' : '邮箱验证码';
  const englishMethods = google ? 'Google or an email code' : 'an email code';
  return {
    subject: '价格哨站 · 邀请你加入 Open Alert',
    text: `你已获邀使用价格哨站 Open Alert。\n请使用 ${email}，通过${methods}登录。\n${url}\n${expiry ? `邀请有效至 ${expiry}。\n` : ''}\nYou are invited to Open Alert. Sign in with ${email} using ${englishMethods}.\n${expiry ? `Invitation expires at ${expiry}.\n` : ''}The invitation does not grant access to a different email address.`,
    html: layout('你已获邀加入价格哨站', `<p>请使用 <strong>${escape(email)}</strong>，通过${methods}登录。</p><p lang="en">You are invited to Open Alert. Sign in with this email using ${englishMethods}.</p><p style="margin:28px 0"><a href="${escape(url)}" style="display:inline-block;background:#171717;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">登录价格哨站 / Sign in</a></p>${expiry ? `<p style="font-size:13px">邀请有效至 / Expires: ${escape(expiry)}</p>` : ''}<p style="font-size:13px">邀请仅限此邮箱使用。<br><span lang="en">Only this email address can use the invitation.</span></p>`),
  };
}
