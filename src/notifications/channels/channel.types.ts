/** Out-of-app message channels (WhatsApp, SMS). Opt-in only, env-driven, disabled by default. */
export type ChannelId = 'whatsapp' | 'sms';
export type ChannelEvent = 'order_placed' | 'cod_confirmation' | 'order_shipped' | 'order_delivered';
export type MessageLang = 'en' | 'ur';

export interface OutboundMessage {
  /** E.164 phone number, e.g. +923001234567 */
  to: string;
  event: ChannelEvent;
  lang: MessageLang;
  /** Named values for the template, in the order the approved WhatsApp template expects them. */
  vars: Record<string, string>;
  /** Fully rendered plain text (used for SMS and as the WhatsApp fallback). */
  text: string;
}

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface NotificationChannel {
  readonly id: ChannelId;
  isConfigured(): boolean;
  send(msg: OutboundMessage): Promise<SendResult>;
}

export type EnvLike = Record<string, string | undefined>;

export type HttpPostJson = (
  url: string,
  init: { headers: Record<string, string>; body: string },
) => Promise<{ status: number; json: () => Promise<any> }>;

export const DEFAULT_HTTP_POST_JSON: HttpPostJson = async (url, init) => {
  const res = await fetch(url, { method: 'POST', headers: init.headers, body: init.body });
  return { status: res.status, json: () => res.json().catch(() => ({})) };
};
