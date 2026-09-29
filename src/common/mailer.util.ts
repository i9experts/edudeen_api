import * as nodemailer from 'nodemailer';

/**
 * One outbound-mail path for the whole app (OTP + every transactional email).
 *
 * - `BREVO_API_KEY` set → sends over HTTPS through Brevo's transactional API.
 *   Use this on hosts that block outbound SMTP ports (587/465), where SMTP
 *   can never connect no matter how correct the credentials are.
 * - otherwise → SMTP with SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD.
 *
 * The sender is SMTP_FROM (or SMTP_USER) with APP_NAME as the display name;
 * with Brevo that address must be a verified sender in the Brevo account.
 */
export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

let smtpTransport: nodemailer.Transporter | null = null;

function sender() {
  return {
    name: process.env.APP_NAME || 'Edudeen',
    email: process.env.SMTP_FROM || process.env.SMTP_USER || '',
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
  const from = sender();
  if (!from.email) throw new Error('No sender address configured (set SMTP_FROM or SMTP_USER)');

  const brevoKey = process.env.BREVO_API_KEY?.trim();
  if (brevoKey) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: from,
        to: [{ email: mail.to }],
        subject: mail.subject,
        htmlContent: mail.html,
        ...(mail.text ? { textContent: mail.text } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Brevo send failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json().catch(() => ({}))) as { messageId?: string };
    return body.messageId ?? 'brevo';
  }

  const info = await getSmtpTransport().sendMail({
    from: `"${from.name}" <${from.email}>`,
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  return info.messageId;
}
