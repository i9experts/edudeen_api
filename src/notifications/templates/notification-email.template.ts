const APP_NAME = process.env.APP_NAME || 'Edudeen';
const BRAND_COLOR = '#174771';
const WEB_APP_URL = (process.env.WEB_APP_URL || 'https://www.edudeen.com').replace(/\/$/, '');

/** Every user-supplied string (product names, addresses…) goes through this before landing in email HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(amount: number, currency: string) {
  const n = Number(amount ?? 0);
  return `${escapeHtml(currency)} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Buyer's order confirmation / receipt. */
export function orderPlacedEmail(order: {
  orderNumber: string;
  currency: string;
  subtotal: number;
  shippingFee: number;
  totalAmount: number;
  paymentType: string;
  isPaid: boolean;
  sellerOrders: { items: { name: string; quantity: number; totalPrice: number; type: string }[] }[];
}): { subject: string; html: string } {
  const items = order.sellerOrders.flatMap((so) => so.items);
  const rows = items
    .map(
      (i) => `<div class="row"><span class="label">${escapeHtml(i.name)} × ${Number(i.quantity)}</span><span class="value">${money(i.totalPrice, order.currency)}</span></div>`,
    )
    .join('');
  const hasDigital = items.some((i) => i.type === 'digital');
  const paymentNote = order.isPaid
    ? 'Your payment has been received.'
    : order.paymentType === 'cash_on_delivery'
      ? 'Please keep the amount ready — you pay on delivery.'
      : 'We will confirm your payment shortly.';
  const body = `
    <p>Thank you for your order! Order <strong>#${escapeHtml(order.orderNumber)}</strong> has been placed. ${paymentNote}</p>
    <div class="box">
      ${rows}
      ${order.shippingFee ? `<div class="row"><span class="label">Shipping</span><span class="value">${money(order.shippingFee, order.currency)}</span></div>` : ''}
      <div class="row"><span class="label"><strong>Total</strong></span><span class="value">${money(order.totalAmount, order.currency)}</span></div>
    </div>
    ${hasDigital && order.isPaid ? '<p>Your digital downloads are ready in My Orders.</p>' : ''}`;
  return {
    subject: `Order confirmed — #${order.orderNumber}`,
    html: notificationEmailShell('Order confirmed', body, { label: 'View my orders', url: `${WEB_APP_URL}/account/orders` }),
  };
}

/** Buyer update when a seller ships / delivers their part of an order. */
export function orderStatusEmail(
  orderNumber: string,
  status: 'shipped' | 'delivered',
  tracking?: { carrier?: string; trackingNumber?: string; trackingUrl?: string } | null,
): { subject: string; html: string } {
  const title = status === 'shipped' ? 'Your order is on its way' : 'Your order was delivered';
  const trackingHtml =
    status === 'shipped' && tracking?.trackingNumber
      ? `<div class="box"><div class="row"><span class="label">${escapeHtml(tracking.carrier || 'Courier')}</span><span class="value">${escapeHtml(tracking.trackingNumber)}</span></div></div>`
      : '';
  const trackUrl = tracking?.trackingUrl && /^https?:\/\//i.test(tracking.trackingUrl) ? tracking.trackingUrl : null;
  const body = `<p>Order <strong>#${escapeHtml(orderNumber)}</strong> ${status === 'shipped' ? 'has shipped.' : 'has been delivered. We hope you enjoy it!'}</p>${trackingHtml}`;
  return {
    subject: `${title} — #${orderNumber}`,
    html: notificationEmailShell(
      title,
      body,
      trackUrl ? { label: 'Track package', url: escapeHtml(trackUrl) } : { label: 'View my orders', url: `${WEB_APP_URL}/account/orders` },
    ),
  };
}

/**
 * Modern shared shell for every Notifications-module email — a text wordmark
 * (no external logo asset dependency) in the app's brand color, a rounded
 * card body, and an optional pill CTA button. Kept separate from the older
 * `shell()` helper in subscription-notifications.service.ts /
 * platform-plan-notifications.service.ts, which is out of scope here.
 */
export function notificationEmailShell(
  title: string,
  bodyHtml: string,
  cta?: { label: string; url: string },
): string {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #2b2b2b;
    background: #f5f2ef;
    max-width: 600px;
    margin: 0 auto;
    padding: 24px 16px;
  }
  .wordmark {
    text-align: center;
    padding: 8px 0 24px;
  }
  .wordmark span {
    font-weight: 800;
    font-size: 28px;
    letter-spacing: -0.5px;
    color: ${BRAND_COLOR};
  }
  .card {
    background: #ffffff;
    border-radius: 16px;
    padding: 36px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.06);
  }
  .card h1 {
    margin: 0 0 16px;
    font-size: 21px;
    color: #1f1f1f;
  }
  .box {
    background: #f8f6f4;
    border-radius: 12px;
    padding: 18px 20px;
    margin: 20px 0;
  }
  .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
  .label { color: #767676; }
  .value { font-weight: 600; color: #222; }
  .cta {
    display: inline-block;
    margin: 24px 0 8px;
    padding: 12px 28px;
    background: ${BRAND_COLOR};
    color: #ffffff !important;
    text-decoration: none;
    border-radius: 999px;
    font-weight: 600;
    font-size: 14px;
  }
  .footer {
    text-align: center;
    margin-top: 28px;
    color: #9a9a9a;
    font-size: 12px;
  }
</style>
</head>
<body>
  <div class="wordmark"><span>${APP_NAME}</span></div>
  <div class="card">
    <h1>${title}</h1>
    ${bodyHtml}
    ${cta ? `<div style="text-align:center"><a class="cta" href="${cta.url}">${cta.label}</a></div>` : ''}
  </div>
  <div class="footer">
    <p>&copy; ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
    <p>You're receiving this because of activity on your ${APP_NAME} account. Manage preferences in the app under Notifications.</p>
  </div>
</body>
</html>`;
}
