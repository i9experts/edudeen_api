import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { escapeHtml, notificationEmailShell } from '../notifications/templates/notification-email.template';

type Deps = {
  storeModel: any;
  activityLog: { log: (entry: any) => Promise<boolean> } | null | undefined;
  notifier?: { notify: (params: any) => Promise<void> } | null;
  realtime?: { emit: (...topics: string[]) => void } | null;
};

const webUrl = () => (process.env.WEB_APP_URL || 'https://www.edudeen.com').replace(/\/$/, '');

/**
 * Turns a store's holiday OFF once its return day has started (called every minute by the scheduler).
 * The gate itself never depends on this job (`holidayActive` already ignores an expired holiday), so a late
 * tick cannot let an order through or keep a store closed; the job only tidies the state, tells the seller,
 * writes the audit entry and refreshes open pages.
 *
 * Each store is switched off with a guarded update (same returnDate as read), so a seller who just extended the
 * holiday is never overridden. Returns how many stores were switched off.
 */
export async function endExpiredHolidays(deps: Deps, now: Date = new Date()): Promise<number> {
  const due: any[] = await deps.storeModel
    .find({ isDelete: false, 'holiday.enabled': true, 'holiday.returnDate': { $ne: null, $lte: now } })
    .select('_id sellerId name holiday')
    .limit(200)
    .lean();
  let ended = 0;
  for (const store of due) {
    const storeId = String(store._id);
    const res = await deps.storeModel.updateOne(
      { _id: store._id, 'holiday.enabled': true, 'holiday.returnDate': store.holiday.returnDate },
      { $set: { 'holiday.enabled': false, 'holiday.returnDate': null } },
    );
    if (!res?.modifiedCount) continue;
    ended++;
    await deps.activityLog?.log({
      storeId, category: 'settings', action: 'holiday_disabled',
      description: 'Holiday mode switched off automatically (return date reached)',
      actorId: null, actorRole: 'system', targetId: storeId, targetType: 'store',
      metadata: { automatic: true, returnDate: store.holiday.returnDate },
    });
    if (deps.notifier && store.sellerId) {
      const title = 'Your store is open again';
      const body = 'Your holiday has ended, so buyers can order from your store again.';
      const link = `/store/${storeId}/settings`;
      void deps.notifier.notify({
        recipientId: String(store.sellerId),
        recipientRole: 'seller',
        type: NOTIFICATION_TYPES.STORE_HOLIDAY_ENDED,
        title,
        body,
        data: { storeId, link },
        email: { subject: title, html: notificationEmailShell(escapeHtml(title), `<p>${escapeHtml(body)}</p>`, { label: 'Open store settings', url: `${webUrl()}${link}` }) },
      });
    }
  }
  // 'store' refreshes the seller's own pages; 'storefront' is the public topic so open buyer pages re-read.
  if (ended > 0) deps.realtime?.emit('store', 'storefront');
  return ended;
}
