import { dispatchDueAt, dispatchDueExpr, DISPATCH_DAYS_MIN, LEGACY_DISPATCH_HOURS } from 'src/common/dispatch.util';

/**
 * Seller dashboard "Action required" counts. READ-ONLY. Every count uses the same filter the target page
 * uses, so the number on the card equals the rows on the page:
 *  - ordersToShip / ordersOverdue -> Orders list `?action=toship|overdue` (getSellerOrders uses `sellerOrdersActionFilter`)
 *  - returnsPending               -> Returns page status 'requested' (item level)
 *  - unreadMessages               -> inbox conversations with sellerUnread > 0 (sidebar badge rule)
 *  - unansweredQuestions          -> Questions tab 'unanswered'
 *  - pendingReview / rejected     -> product status pending_review / rejected
 *  - payoutMissing                -> 1 when no payout method and no direct bank details (same rule as the setup checklist)
 */
export interface ActionItems {
  ordersToShip: number;
  ordersOverdue: number;
  returnsPending: number;
  unreadMessages: number;
  unansweredQuestions: number;
  pendingReview: number;
  rejected: number;
  payoutMissing: number;
}

export type OrderActionKind = 'toship' | 'overdue';

export function parseOrderAction(v: unknown): OrderActionKind | null {
  return v === 'toship' || v === 'overdue' ? v : null;
}

/** Seller Orders page tabs (package status of the seller's own store). */
export const ORDER_TABS = ['needs_action', 'shipped', 'delivered', 'completed', 'cancelled', 'all'] as const;
export type OrderTab = (typeof ORDER_TABS)[number];

/** undefined/'' -> null (no tab); a known tab -> itself; anything else -> 'invalid' (caller answers 400). */
export function parseOrderTab(v: unknown): OrderTab | null | 'invalid' {
  if (v === undefined || v === null || v === '') return null;
  return typeof v === 'string' && (ORDER_TABS as readonly string[]).includes(v) ? (v as OrderTab) : 'invalid';
}

export function packageStatusesForTab(tab: OrderTab): string[] | null {
  switch (tab) {
    case 'needs_action': return ['pending', 'processing'];
    case 'all': return null;
    default: return [tab];
  }
}

/**
 * Ship-by time of a package = payment time (COD / unpaid-time: order creation) + the package's dispatch days
 * (working days, Sundays not counted; legacy packages without the snapshot: + 48 h).
 * Only for packages the dashboard counts as "to ship" (same conditions as `sellerOrdersActionFilter`), else null.
 */
export function sellerShipBy(order: any, so: any): Date | null {
  if (!so || !['physical', 'mixed'].includes(so.fulfillmentType)) return null;
  if (!['pending', 'processing'].includes(so.status)) return null;
  if (so.fulfillmentMode === 'platform') return null;
  if (!(order?.isPaid === true || order?.paymentType === 'cash_on_delivery' || so.isPaid === true)) return null;
  const base = order?.paidAt ?? order?.createdAt;
  if (!base) return null;
  return dispatchDueAt(base, so.dispatchDays);
}

/** Mongo pipeline stages that put the most urgent ship-by first (packages with no ship-by last, newest first). */
export function shipByUrgencySort(storeIds: string[]): any[] {
  return [
    { $addFields: { _pkg: { $arrayElemAt: [{ $filter: { input: '$sellerOrders', cond: { $in: ['$$this.storeId', storeIds] } } }, 0] } } },
    {
      $addFields: {
        _shipKey: {
          $cond: [
            {
              $and: [
                { $in: ['$_pkg.fulfillmentType', ['physical', 'mixed']] },
                { $in: ['$_pkg.status', ['pending', 'processing']] },
                { $ne: ['$_pkg.fulfillmentMode', 'platform'] },
                { $or: [{ $eq: ['$isPaid', true] }, { $eq: ['$paymentType', 'cash_on_delivery'] }, { $eq: ['$_pkg.isPaid', true] }] },
              ],
            },
            dispatchDueExpr('$_pkg', { $ifNull: ['$paidAt', '$createdAt'] }),
            new Date('9999-01-01T00:00:00Z'),
          ],
        },
      },
    },
    { $sort: { _shipKey: 1, createdAt: -1, _id: 1 } },
  ];
}

/**
 * Orders (list rows) holding a PHYSICAL package of `storeId` that still has to be shipped:
 * - package status pending|processing (not shipped / delivered / cancelled / refunded)
 * - fulfillmentType physical or mixed (digital-only excluded)
 * - not handled by Edudeen (fulfillmentMode 'platform' excluded)
 * - paid (order or package) or cash on delivery
 * - not a free claim, not deleted
 * 'overdue' adds the dispatch rule: due moment (payment + dispatch days; legacy +48 h; COD = order creation) has passed.
 * Same due expression as the list sort and the JS ship-by, so card count == list rows.
 */
export function sellerOrdersActionFilter(storeIds: string[], kind: OrderActionKind, now: Date = new Date()): Record<string, any> {
  const scope = { $in: storeIds };
  const and: any[] = [
    {
      sellerOrders: {
        $elemMatch: {
          storeId: scope,
          fulfillmentType: { $in: ['physical', 'mixed'] },
          status: { $in: ['pending', 'processing'] },
          fulfillmentMode: { $ne: 'platform' },
        },
      },
    },
    {
      $or: [
        { isPaid: true },
        { paymentType: 'cash_on_delivery' },
        { sellerOrders: { $elemMatch: { storeId: scope, isPaid: true } } },
      ],
    },
  ];
  if (kind === 'overdue') {
    // Cheap bound first (index-friendly): nothing is due before the shortest possible window (1 working day >= 24 h, legacy 48 h).
    const earliest = new Date(now.getTime() - Math.min(DISPATCH_DAYS_MIN * 24, LEGACY_DISPATCH_HOURS) * 3_600_000);
    and.push({ $or: [{ paidAt: { $lte: earliest } }, { paidAt: null, createdAt: { $lte: earliest } }] });
    // Exact rule per package of the scoped stores (same due expression as the list sort and the JS ship-by).
    and.push({
      $expr: {
        $anyElementTrue: [{
          $map: {
            input: '$sellerOrders', as: 'p',
            in: {
              $and: [
                { $in: ['$$p.storeId', storeIds] },
                { $in: ['$$p.fulfillmentType', ['physical', 'mixed']] },
                { $in: ['$$p.status', ['pending', 'processing']] },
                { $ne: ['$$p.fulfillmentMode', 'platform'] },
                { $lte: [dispatchDueExpr('$$p', { $ifNull: ['$paidAt', '$createdAt'] }), now] },
              ],
            },
          },
        }],
      },
    });
  }
  return { isDelete: false, isFreeClaim: { $ne: true }, $and: and };
}

export async function computeActionItems(
  deps: {
    orderModel: any;
    conversationModel: any;
    questionModel: any;
    productModel: any;
  },
  storeId: string,
  sellerId: string,
  payoutMissing: boolean,
  now: Date = new Date(),
): Promise<ActionItems> {
  const { orderModel, conversationModel, questionModel, productModel } = deps;
  const base = { 'sellerOrders.storeId': storeId };
  const productFilter = { storeId, sellerId, isDelete: false };

  const [ordersToShip, ordersOverdue, returnsAgg, unreadMessages, unansweredQuestions, pendingReview, rejected] = await Promise.all([
    orderModel.countDocuments({ ...base, ...sellerOrdersActionFilter([storeId], 'toship', now) }),
    orderModel.countDocuments({ ...base, ...sellerOrdersActionFilter([storeId], 'overdue', now) }),
    // Item-level, like the Returns page: this store's items whose returnStatus is 'requested'.
    orderModel.aggregate([
      { $match: { ...base, isDelete: false, 'sellerOrders.items.returnStatus': 'requested' } },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': storeId } },
      { $unwind: '$sellerOrders.items' },
      { $match: { 'sellerOrders.items.returnStatus': 'requested' } },
      { $count: 'n' },
    ]),
    conversationModel.countDocuments({ storeId, deletedBySeller: false, sellerUnread: { $gt: 0 } }),
    questionModel.countDocuments({ storeId, answeredAt: null, hidden: false }),
    productModel.countDocuments({ ...productFilter, status: 'pending_review' }),
    productModel.countDocuments({ ...productFilter, status: 'rejected' }),
  ]);

  return {
    ordersToShip,
    ordersOverdue,
    returnsPending: returnsAgg?.[0]?.n ?? 0,
    unreadMessages,
    unansweredQuestions,
    pendingReview,
    rejected,
    payoutMissing: payoutMissing ? 1 : 0,
  };
}
