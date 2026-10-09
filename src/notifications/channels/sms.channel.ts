import { DEFAULT_HTTP_POST_JSON, type EnvLike, type HttpPostJson, type NotificationChannel, type OutboundMessage, type SendResult } from './channel.types';

/**
 * Generic SMS adapter (stub): posts {to, message, sender?} as JSON to an HTTP gateway you choose.
 * Disabled unless SMS_GATEWAY_URL and SMS_GATEWAY_TOKEN are set. Env: SMS_GATEWAY_URL,
 * SMS_GATEWAY_TOKEN (sent as Bearer), SMS_SENDER_ID (optional).
 * TODO(owner): pick a Pakistani SMS provider (Jazz/Telenor bulk SMS, Eocean, etc.) and adapt the
 * request shape here; nothing is sent until the env vars are set.
 */
export class HttpSmsChannel implements NotificationChannel {
  readonly id = 'sms' as const;

  constructor(private readonly env: EnvLike, private readonly httpPost: HttpPostJson = DEFAULT_HTTP_POST_JSON) {}

  private g(k: string) { return (this.env[k] ?? '').trim(); }

  isConfigured(): boolean {
    if (this.g('SMS_ENABLED').toLowerCase() === 'false') return false;
    return !!(this.g('SMS_GATEWAY_URL') && this.g('SMS_GATEWAY_TOKEN'));
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.isConfigured()) return { ok: false, error: 'sms_not_configured' };
    try {
      const res = await this.httpPost(this.g('SMS_GATEWAY_URL'), {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.g('SMS_GATEWAY_TOKEN')}` },
        body: JSON.stringify({ to: msg.to, message: msg.text, sender: this.g('SMS_SENDER_ID') || undefined }),
      });
      const j = await res.json();
      return res.status >= 200 && res.status < 300 ? { ok: true, id: j?.id ?? j?.messageId } : { ok: false, error: `sms_http_${res.status}` };
    } catch (e: any) {
      return { ok: false, error: `sms_failed:${e?.message ?? 'error'}` };
    }
  }
}
