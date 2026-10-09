import type { ChannelEvent, MessageLang } from './channel.types';

export const ORDER_VAR_ORDER: Record<ChannelEvent, string[]> = {
  order_placed: ['orderNumber', 'total'],
  cod_confirmation: ['orderNumber', 'total'],
  order_shipped: ['orderNumber', 'carrier', 'trackingNumber'],
  order_delivered: ['orderNumber'],
};

const T: Record<ChannelEvent, Record<MessageLang, string>> = {
  order_placed: {
    en: 'Edudeen: your order #{orderNumber} ({total}) has been placed. Thank you!',
    ur: 'ایجوڈین: آپ کا آرڈر #{orderNumber} ({total}) کامیابی سے لگ گیا ہے۔ شکریہ!',
  },
  cod_confirmation: {
    en: 'Edudeen: please confirm your Cash on Delivery order #{orderNumber} ({total}). Keep the amount ready and your phone reachable for the courier.',
    ur: 'ایجوڈین: براہ کرم اپنے کیش آن ڈیلیوری آرڈر #{orderNumber} ({total}) کی تصدیق کریں۔ رقم تیار رکھیں اور فون کھلا رکھیں۔',
  },
  order_shipped: {
    en: 'Edudeen: your order #{orderNumber} has shipped via {carrier}. Tracking number: {trackingNumber}.',
    ur: 'ایجوڈین: آپ کا آرڈر #{orderNumber} {carrier} کے ذریعے روانہ ہو گیا ہے۔ ٹریکنگ نمبر: {trackingNumber}۔',
  },
  order_delivered: {
    en: 'Edudeen: your order #{orderNumber} has been delivered. We hope you enjoy it!',
    ur: 'ایجوڈین: آپ کا آرڈر #{orderNumber} پہنچا دیا گیا ہے۔ امید ہے آپ کو پسند آئے گا!',
  },
};

/** Fills {placeholders}; unknown/empty values become a dash so a message never shows "{x}". Control chars stripped. */
export function renderMessage(event: ChannelEvent, lang: MessageLang, vars: Record<string, string>): string {
  const tpl = T[event]?.[lang] ?? T[event]?.en ?? '';
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = String(vars?.[k] ?? '').replace(/[\u0000-\u001f]/g, ' ').trim();
    return v || '-';
  });
}

/**
 * Normalises a Pakistani mobile number to E.164 (+92XXXXXXXXXX). Accepts 03001234567,
 * 3001234567, 923001234567, +92 300 1234567, 0092... Returns null when it does not look like a valid number.
 */
export function normalizePkPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  return /^3\d{9}$/.test(d) ? `+92${d}` : null;
}
