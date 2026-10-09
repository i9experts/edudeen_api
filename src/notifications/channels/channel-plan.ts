import type { ChannelEvent, ChannelId, EnvLike, HttpPostJson, MessageLang, NotificationChannel } from './channel.types';
import { HttpSmsChannel } from './sms.channel';
import { WhatsAppCloudChannel } from './whatsapp-cloud.channel';
import { normalizePkPhone, renderMessage } from './message-templates';

export interface ChannelPrefs {
  /** category gate from the existing preferences: orders === false mutes order messages everywhere */
  ordersCategoryEnabled: boolean;
  whatsappEnabled: boolean;
  smsEnabled: boolean;
  language: MessageLang;
}

export function buildChannels(env: EnvLike = process.env, httpPost?: HttpPostJson): NotificationChannel[] {
  return [new WhatsAppCloudChannel(env, httpPost), new HttpSmsChannel(env, httpPost)];
}

/**
 * Pure decision: which channels get this message, and with what text. Opt-in only:
 * a channel is used only when the buyer enabled it, it is configured, and we have a valid number.
 * WhatsApp wins; SMS is used only when WhatsApp is not an option (no duplicate messages).
 */
export function planDelivery(args: {
  event: ChannelEvent;
  vars: Record<string, string>;
  prefs: ChannelPrefs;
  rawPhone: string | null | undefined;
  channels: NotificationChannel[];
}): { channel: ChannelId; to: string; text: string; lang: MessageLang } | null {
  const { event, vars, prefs, rawPhone, channels } = args;
  if (!prefs.ordersCategoryEnabled) return null;
  const to = normalizePkPhone(rawPhone);
  if (!to) return null;
  const configured = (id: ChannelId) => channels.some((c) => c.id === id && c.isConfigured());
  const channel: ChannelId | null =
    prefs.whatsappEnabled && configured('whatsapp') ? 'whatsapp' : prefs.smsEnabled && configured('sms') ? 'sms' : null;
  if (!channel) return null;
  return { channel, to, lang: prefs.language, text: renderMessage(event, prefs.language, vars) };
}
