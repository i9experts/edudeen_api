export const QUICK_REPLY_MAX = 50;

/** Replaces {buyer_name} / {store_name}; any other {variable} stays exactly as typed. */
export function applyQuickReplyVars(body: string, vars: { buyer_name?: string; store_name?: string }): string {
  return String(body ?? '').replace(/\{(buyer_name|store_name)\}/g, (m, k: 'buyer_name' | 'store_name') => {
    const v = vars[k];
    return typeof v === 'string' && v.trim() ? v.trim() : m;
  });
}

// Seeded once per store. No promise on refunds: it states the real rule and points to the Returns policy.
export const DEFAULT_QUICK_REPLIES: Array<{ title: string; body: string; category: string }> = [
  {
    title: 'Download help',
    category: 'download_help',
    body: 'Hi {buyer_name}, thanks for buying from {store_name}. Your files are in Account > My Library, where you can download them again. If a file does not open, tell me which one and your device and I will help.',
  },
  {
    title: 'Order status',
    category: 'order_status',
    body: 'Hi {buyer_name}, thank you for your order from {store_name}. I am checking it now and will update you shortly. You can also follow it under Account > My Orders.',
  },
  {
    title: 'Refund policy',
    category: 'refund_policy',
    body: 'Hi {buyer_name}, digital files are refundable only if they have not been downloaded, and physical items only after delivery. Please see the Returns policy on Edudeen for the full rules, and you can send the request from your order page.',
  },
];
