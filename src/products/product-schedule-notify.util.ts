import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { escapeHtml, notificationEmailShell } from '../notifications/templates/notification-email.template';

type Notifier = { notify: (params: any) => Promise<void> } | undefined | null;

const webUrl = () => (process.env.WEB_APP_URL || 'https://www.edudeen.com').replace(/\/$/, '');

/** "29 Oct 2026, 3:00 pm" in Pakistan time (what the seller picked), with the zone named. */
export function pktLabel(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  return `${text} (Pakistan time)`;
}

function send(notifier: Notifier, product: any, type: string, title: string, body: string, cta?: string) {
  if (!notifier || !product?.sellerId) return;
  const link = product.storeId ? `/store/${product.storeId}/products` : undefined;
  void notifier.notify({
    recipientId: String(product.sellerId),
    recipientRole: 'seller',
    type,
    title,
    body,
    data: { productId: String(product._id), storeId: product.storeId, link },
    email: {
      subject: title,
      html: notificationEmailShell(escapeHtml(title), `<p>${escapeHtml(body)}</p>`, link ? { label: cta ?? 'Open my products', url: `${webUrl()}${link}` } : undefined),
    },
  });
}

/**
 * Tells the seller what really happened to their publish request. A first-time publish/schedule goes to admin
 * review, so "scheduled" can honestly mean "waiting for review" - the seller used to hear nothing at all.
 */
export function notifyPublishRequest(notifier: Notifier, product: any, requested: string | undefined, finalStatus: string) {
  if (requested !== 'scheduled' && requested !== 'active') return;
  const name = product?.name ?? 'Your product';
  if (finalStatus === 'pending_review') {
    const when = requested === 'scheduled' ? pktLabel(product?.scheduledAt) : '';
    send(notifier, product, NOTIFICATION_TYPES.LISTING_IN_REVIEW, `"${name}" is waiting for review`,
      requested === 'scheduled' && when
        ? `Your product was submitted for review. Once Edudeen approves it, it goes live on ${when}. If approval comes after that time it goes live right away.`
        : 'Your product was submitted for review. You will be notified as soon as it is approved.');
    return;
  }
  if (finalStatus === 'scheduled') {
    send(notifier, product, NOTIFICATION_TYPES.PRODUCT_SCHEDULED, `"${name}" is scheduled`,
      `It will go live on ${pktLabel(product?.scheduledAt)}. We will notify you when it is published.`);
  }
}

export function notifyProductPublished(notifier: Notifier, product: any) {
  const name = product?.name ?? 'Your product';
  send(notifier, product, NOTIFICATION_TYPES.PRODUCT_PUBLISHED, `"${name}" is now live`,
    'Your scheduled product has been published and buyers can see it on Edudeen.', 'View my products');
}
