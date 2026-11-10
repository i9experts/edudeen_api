import { buildTimeline, reasonDisplayLabel, requiredPreviousFollowUp } from 'src/refund-request/return-trail.util';
import { isOverdue, normalizeStatus, respondBy } from './seller-returns-all.util';

/**
 * Read-only detail of ONE return (item on an order) or ONE refund request, for the
 * seller's drawer. "refunded" is derived from the items' stored refundedAmount;
 * nothing here writes or moves money.
 */
export function buildReturnDetail(args: {
  source: 'return' | 'refund';
  requestId: string;
  order: any;
  sellerOrder: any;
  /** return: the one item; refund: every item the request covers. */
  items: any[];
  /** refund-request document (source 'refund'). */
  refund?: any;
  buyer: string;
  now?: Date;
}) {
  const { source, order, sellerOrder, items, refund } = args;
  const now = args.now ?? new Date();
  const first = items[0] ?? {};

  const rawStatus = source === 'refund' ? (refund.status === 'pending' ? 'requested' : refund.status) : first.returnStatus;
  const status = normalizeStatus(rawStatus);
  const requestedAt: Date | null = source === 'refund'
    ? (refund.createdAt ? new Date(refund.createdAt) : null)
    : (first.returnRequestedAt ? new Date(first.returnRequestedAt) : null);

  const reasonCode: string | null = (source === 'refund' ? refund.reasonCode : first.returnReasonCode) ?? null;
  const reasonText: string = (source === 'refund' ? refund.reason : first.returnReason) ?? '';
  const note: string | null = (source === 'refund' ? refund.note : first.returnNote) ?? null;
  const evidenceImages: string[] = (source === 'refund' ? refund.evidenceImages : first.returnEvidence) ?? [];
  const history = source === 'refund' ? refund.history : first.returnHistory;
  const followUp: string | null = (source === 'refund' ? refund.followUp : first.returnFollowUp) ?? null;
  const followUpNote: string | null = (source === 'refund' ? refund.followUpNote : first.returnFollowUpNote) ?? null;
  const rejectReason: string | null = source === 'refund' ? (refund.resolutionNotes ?? null) : (first.returnRejectReason ?? null);

  const refundedAmount = items.reduce((s, i) => s + (Number(i.refundedAmount) || 0), 0);
  const amount = source === 'refund' && status === 'approved' && refund.buyerRefundAmount != null
    ? refund.buyerRefundAmount
    : items.reduce((s, i) => s + (Number(i.totalPrice) || 0), 0);
  const isPhysical = items.some((i) => i.type !== 'digital');
  const deadline = respondBy(requestedAt, status);

  const canStep = (step: string) => {
    if (status !== 'approved') return false;
    try { return (requiredPreviousFollowUp(step, isPhysical) ?? null) === (followUp ?? null); } catch { return false; }
  };

  return {
    source,
    requestId: args.requestId,
    orderId: String(order._id),
    orderNumber: order.orderNumber ?? '',
    storeId: sellerOrder.storeId,
    type: source === 'return' ? 'Return' : 'Refund only',
    status,
    followUp,
    followUpNote,
    buyer: args.buyer,
    currency: order.currency || 'USD',
    items: items.map((i) => ({
      id: String(i._id),
      name: i.name,
      type: i.type === 'digital' ? 'digital' : 'physical',
      quantity: i.quantity ?? 1,
      totalPrice: Number(i.totalPrice) || 0,
      refundedAmount: Number(i.refundedAmount) || 0,
      // Digital only: whether the buyer ever downloaded the file (existing counter).
      downloadCount: i.type === 'digital' ? (i.downloadCount ?? 0) : null,
    })),
    reasonCode,
    reasonLabel: reasonDisplayLabel(reasonCode, reasonText),
    reason: reasonText,
    note,
    evidenceImages,
    rejectReason,
    amount,
    refundedAmount,
    refunded: refundedAmount > 0,
    requestedAt,
    respondBy: deadline,
    isOverdue: isOverdue(deadline, now),
    timeline: buildTimeline({
      history, requestedAt, requestedByRole: source === 'refund' ? refund.requestedByRole : 'user',
      status, reviewedAt: source === 'refund' ? refund.reviewedAt : null,
    }),
    actions: {
      canReview: status === 'open',
      canMarkReceived: canStep('item_received'),
      canMarkReplacementSent: canStep('replacement_sent'),
    },
  };
}
