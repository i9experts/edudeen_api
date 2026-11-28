import * as nodemailer from 'nodemailer';
import mongoose from 'mongoose';

/**
 * One outbound-mail path for the whole app (OTP + every transactional email).
 *
 * - `BREVO_API_KEY` set → sends over HTTPS through Brevo's transactional API.
 *   Use this on hosts that block outbound SMTP ports (587/465), where SMTP
 *   can never connect no matter how correct the credentials are.
 * - otherwise → SMTP with SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD.
 *
 * The sender is the admin's PlatformConfig.emailConfig (fromName/fromEmail/
 * replyToEmail, set via Admin > Platform Config > Email), falling back to
 * SMTP_FROM/SMTP_USER with APP_NAME as the display name for whichever of
 * those the admin hasn't set. With Brevo, fromEmail must still be a verified
 * sender in the Brevo account, or Brevo will reject/override it.
 */
export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

let smtpTransport: nodemailer.Transporter | null = null;
let warnedGmailRewrite = false;

/** The admin's configured sender identity. Read directly off the shared mongoose connection instead of
 *  through Nest's DI (AdminConfigModule imports AuthModule, which imports OtpModule — injecting
 *  AdminConfigService into OtpService/EmailService here would be circular), so this file has no module
 *  wiring to keep in sync. Never throws: a lookup failure just falls back to env vars below — outbound
 *  mail must never break because this soft read failed. */
async function configuredSender(): Promise<{
  name?: string;
  email?: string;
  replyTo?: string;
}> {
  try {
    // @nestjs/mongoose registers models on its own connection (mongoose.createConnection), not on the
    // global mongoose instance, so look on every open connection too.
    const PlatformConfig: mongoose.Model<any> | undefined =
      mongoose.models.PlatformConfig ??
      mongoose.connections.map((c) => c.models?.PlatformConfig).find(Boolean);
    if (!PlatformConfig) return {};
    const config: any = await PlatformConfig.findOne({})
      .select('emailConfig')
      .lean();
    const e = config?.emailConfig;
    return {
      name: e?.fromName || undefined,
      email: e?.fromEmail || undefined,
      replyTo: e?.replyToEmail || undefined,
    };
  } catch {
    return {};
  }
}

function sender(configured: { name?: string; email?: string }) {
  return {
    name: configured.name || process.env.APP_NAME || 'Edudeen',
    email:
      configured.email || process.env.SMTP_FROM || process.env.SMTP_USER || '',
  };
}

function getSmtpTransport() {
  if (!smtpTransport) {
    const port = parseInt(process.env.SMTP_PORT ?? '', 10) || 587;
    smtpTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
      // Fail fast instead of hanging a sign-up request for minutes when the
      // host blocks SMTP.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });
  }
  return smtpTransport;
}

/** Sends one email; throws with a descriptive message on failure. Returns the provider's message id. */
export async function sendMail(mail: OutgoingMail): Promise<string> {
  const configured = await configuredSender();
  const from = sender(configured);
  if (!from.email)
    throw new Error(
      'No sender address configured (set SMTP_FROM or SMTP_USER, or Admin > Platform Config > Email)',
    );

  const brevoKey = process.env.BREVO_API_KEY?.trim();
  if (brevoKey) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': brevoKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: from,
        to: [{ email: mail.to }],
        subject: mail.subject,
        htmlContent: mail.html,
        ...(mail.text ? { textContent: mail.text } : {}),
        ...(configured.replyTo
          ? { replyTo: { email: configured.replyTo } }
          : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Brevo send failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as { messageId?: string };
    return body.messageId ?? 'brevo';
  }

  const smtpUser = process.env.SMTP_USER || '';
  if (
    !warnedGmailRewrite &&
    /gmail\.com$/i.test(process.env.SMTP_HOST || 'smtp.gmail.com') &&
    smtpUser &&
    from.email.toLowerCase() !== smtpUser.toLowerCase()
  ) {
    warnedGmailRewrite = true;
    console.warn(
      `Mailer: sending through Gmail SMTP as ${smtpUser}; Gmail replaces the From address ${from.email} with it. Set BREVO_API_KEY to send from ${from.email}.`,
    );
  }
  const info = await getSmtpTransport().sendMail({
    from: `"${from.name}" <${from.email}>`,
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    ...(configured.replyTo ? { replyTo: configured.replyTo } : {}),
  });
  return info.messageId;
}
