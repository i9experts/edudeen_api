import { DISPATCH_HOURS } from 'src/messaging/response-stats.util';

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

/**
 * Orders (list rows) holding a PHYSICAL package of `storeId` that still has to be shipped:
 * - package status pending|processing (not shipped / delivered / cancelled / refunded)
 * - fulfillmentType physical or mixed (digital-only excluded)
 * - not handled by Edudeen (fulfillmentMode 'platform' excluded)
 * - paid (order or package) or cash on delivery
 * - not a free claim, not deleted
 * 'overdue' adds the dispatch rule (DISPATCH_HOURS from payment; COD / unpaid-time = order creation, as in response-stats).
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
    const cutoff = new Date(now.getTime() - DISPATCH_HOURS * 3_600_000);
    and.push({
      $or: [{ paidAt: { $lte: cutoff } }, { paidAt: null, createdAt: { $lte: cutoff } }],
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
