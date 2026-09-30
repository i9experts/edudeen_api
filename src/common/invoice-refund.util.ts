import type { Model } from 'mongoose';

/**
 * Atomic refund reservation for an invoice document that carries
 * `amountUSD`, `refundedAmountUSD` and `status` ('paid' | 'partially_refunded' | 'refunded').
 *
 * The old flow read the invoice, called the payment provider, then saved a recomputed total — two
 * concurrent refunds both saw the same "remaining" and could refund more than was paid. Here the
 * guard (`already refunded + this refund <= amount paid`) and the increment are ONE update, so only
 * requests that genuinely fit succeed. Returns the invoice as it was BEFORE the reservation
 * (null when the refund does not fit, or the invoice is not refundable).
 */
export async function reserveInvoiceRefund(
  model: Model<any>,
  invoiceId: string,
  refundAmount: number,
): Promise<{ refundedAmountUSD?: number } | null> {
  const newTotal = {
    $round: [
      { $add: [{ $ifNull: ['$refundedAmountUSD', 0] }, refundAmount] },
      2,
    ],
  };
  return await model.findOneAndUpdate(
    {
      _id: invoiceId,
      isDelete: false,
      status: { $in: ['paid', 'partially_refunded'] },
      $expr: { $lte: [newTotal, { $add: ['$amountUSD', 0.001] }] },
    },
    [
      {
        $set: {
          refundedAmountUSD: newTotal,
          status: {
            $cond: [
              { $gte: [newTotal, { $subtract: ['$amountUSD', 0.001] }] },
              'refunded',
              'partially_refunded',
            ],
          },
          refundedAt: '$$NOW',
        },
      },
    ],
    { returnDocument: 'before', updatePipeline: true },
  );
}

/** Undo a reservation when the payment provider declined the refund. */
export async function releaseInvoiceRefund(
  model: Model<any>,
  invoiceId: string,
  refundAmount: number,
) {
  const restored = {
    $max: [
      0,
      {
        $round: [
          { $subtract: [{ $ifNull: ['$refundedAmountUSD', 0] }, refundAmount] },
          2,
        ],
      },
    ],
  };
  await model.updateOne(
    { _id: invoiceId },
    [
      {
        $set: {
          refundedAmountUSD: restored,
          status: {
            $cond: [{ $lte: [restored, 0.001] }, 'paid', 'partially_refunded'],
          },
        },
      },
    ],
    { updatePipeline: true },
  );
}

/** Idempotency key for one specific refund: the same request retried maps to the same key,
 *  while a later partial refund of the SAME amount gets a different one (it starts from a
 *  different already-refunded total) — the old `refund_<charge>_<amount>` key collapsed those. */
export function invoiceRefundKey(
  invoiceId: string,
  refundedBeforeUSD: number,
  refundAmount: number,
): string {
  return `refund_${invoiceId}_${Math.round(refundedBeforeUSD * 100)}_${Math.round(refundAmount * 100)}`;
}
