import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.js';
import { createEmailTransport, EmailDeliveryError, normalizeEmail } from './email.js';
import type { EmailTransport } from './email.js';

/** Node-only module: the Worker build must externalize this unreachable dynamic import. */
export function createSmtpTransport(config: AppConfig): EmailTransport {
  if (!config.email.smtpUrl || !config.email.from) throw new EmailDeliveryError('email_configuration');
  let url: URL;
  try { url = new URL(config.email.smtpUrl); } catch { throw new EmailDeliveryError('email_configuration'); }
  // Construct documented v10 SMTP options explicitly; URL query cannot weaken TLS or timeouts.
  const secure = url.protocol === 'smtps:';
  const transport = nodemailer.createTransport({
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    requireTLS: config.environment === 'production' && !secure,
    ...(url.username ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } } : {}),
    tls: { rejectUnauthorized: true },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 8_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async verify() {
      try {
        if (!await transport.verify()) throw new Error('not ready');
      } catch { throw new EmailDeliveryError('email_unavailable'); }
    },
    async send(message) {
      const to = normalizeEmail(message.to);
      try {
        const result = await transport.sendMail({ from: config.email.from!, to, subject: message.subject, text: message.text, html: message.html });
        const accepted = result.accepted.some((entry) => entry.toLowerCase() === to);
        if (!accepted || result.rejected.length > 0 || !/^250(?:\s|$)/.test(result.response)) throw new EmailDeliveryError('email_rejected');
      } catch (error) {
        if (error instanceof EmailDeliveryError) throw error;
        // A disconnect after DATA may have delivered. Never automatically resend it.
        throw new EmailDeliveryError('email_uncertain');
      }
    },
    close() { transport.close(); },
  };
}

export async function createNodeEmailTransport(config: AppConfig): Promise<EmailTransport> {
  return config.email.provider === 'smtp' ? createSmtpTransport(config) : createEmailTransport(config);
}
