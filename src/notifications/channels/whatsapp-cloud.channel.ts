import { DEFAULT_HTTP_POST_JSON, type EnvLike, type HttpPostJson, type NotificationChannel, type OutboundMessage, type SendResult } from './channel.types';
import { ORDER_VAR_ORDER } from './message-templates';

/**
 * WhatsApp Cloud API adapter (Meta). Env: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
 * WHATSAPP_API_VERSION (default v20.0), WHATSAPP_ENABLED=false to switch off.
 * Business-initiated messages must use an APPROVED template: set WHATSAPP_TEMPLATE_<EVENT>
 * (e.g. WHATSAPP_TEMPLATE_ORDER_SHIPPED=edudeen_order_shipped) and the adapter sends it with the
 * body variables in the order defined by ORDER_VAR_ORDER, in the buyer's language (en / ur).
 * With no template configured for an event it sends plain text, which Meta only delivers
 * inside the 24h customer-service window.
 * TODO(owner): create + approve the 4 templates (en + ur) in Meta Business Manager.
 */
export class WhatsAppCloudChannel implements NotificationChannel {
  readonly id = 'whatsapp' as const;

  constructor(private readonly env: EnvLike, private readonly httpPost: HttpPostJson = DEFAULT_HTTP_POST_JSON) {}

  private g(k: string) { return (this.env[k] ?? '').trim(); }

  isConfigured(): boolean {
    if (this.g('WHATSAPP_ENABLED').toLowerCase() === 'false') return false;
    return !!(this.g('WHATSAPP_ACCESS_TOKEN') && this.g('WHATSAPP_PHONE_NUMBER_ID'));
  }

  buildPayload(msg: OutboundMessage): Record<string, any> {
    const to = msg.to.replace(/^\+/, '');
    const template = this.g(`WHATSAPP_TEMPLATE_${msg.event.toUpperCase()}`);
    if (!template) {
      return { messaging_product: 'whatsapp', to, type: 'text', text: { body: msg.text, preview_url: false } };
    }
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: template,
        language: { code: msg.lang === 'ur' ? 'ur' : 'en' },
        components: [
          {
            type: 'body',
            parameters: ORDER_VAR_ORDER[msg.event].map((k) => ({ type: 'text', text: (msg.vars[k] ?? '-').slice(0, 200) })),
          },
        ],
      },
    };
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.isConfigured()) return { ok: false, error: 'whatsapp_not_configured' };
    const version = this.g('WHATSAPP_API_VERSION') || 'v20.0';
    try {
      const res = await this.httpPost(`https://graph.facebook.com/${version}/${this.g('WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.g('WHATSAPP_ACCESS_TOKEN')}` },
        body: JSON.stringify(this.buildPayload(msg)),
      });
      const j = await res.json();
      if (res.status >= 200 && res.status < 300) return { ok: true, id: j?.messages?.[0]?.id };
      return { ok: false, error: `whatsapp_http_${res.status}:${j?.error?.message ?? ''}`.slice(0, 200) };
    } catch (e: any) {
      return { ok: false, error: `whatsapp_failed:${e?.message ?? 'error'}` };
    }
  }
}
