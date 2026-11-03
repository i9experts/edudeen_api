/* eslint-disable prettier/prettier */
import { Model } from 'mongoose';
import { round } from './number.util';

/**
 * Shared "what does the platform itself earn" calculation — commission recognized
 * at sale time (`Transaction` type=sale, `metadata.platformFee` — see
 * `finance.service.ts#recordSale`). `subscriptionRevenue` is kept at 0 so the
 * response shape stays stable now that store memberships are gone. Used by both
 * `AdminAnalyticsService` (platform-wide analytics) and `AdminFinanceService`
 * (platform revenue/commission reporting) so this aggregation exists exactly once.
 */
export interface PlatformEarningsByCurrency {
  currency: string;
  commission: number;
  processingFees: number;
  subscriptionRevenue: number;
  total: number;
}

export interface PlatformEarnings {
  /** @deprecated blends every settlement currency into one meaningless
   *  number — kept only so existing non-currency-aware callers (e.g.
   *  AdminAnalyticsService) don't break. New callers should use
   *  `byCurrency` instead, never these blended totals. */
  commission: number;
  processingFees: number;
  subscriptionRevenue: number;
  total: number;
  byCurrency: PlatformEarningsByCurrency[];
}

export async function getPlatformEarnings(
  transactionModel: Model<any>,
  from: Date,
  to: Date,
  scope?: { storeId?: string; sellerId?: string },
): Promise<PlatformEarnings> {
  const txMatch: Record<string, any> = { type: 'sale', status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } };
  if (scope?.storeId) txMatch.storeId = scope.storeId;
  if (scope?.sellerId) txMatch.sellerId = scope.sellerId;

  const [commissionRows, commissionByCurrencyRows] = await Promise.all([
    transactionModel.aggregate([
      { $match: txMatch },
      { $group: { _id: null, commission: { $sum: '$metadata.platformFee' }, processingFees: { $sum: '$metadata.processingFee' } } },
    ]),
    // `Transaction.currency` is the seller's own settlement currency (see
    // FinanceService.recordSale) — grouping by it too is what makes
    // `byCurrency` below actually meaningful instead of blending a PKR
    // seller's commission and a USD seller's commission into one number.
    transactionModel.aggregate([
      { $match: txMatch },
      { $group: { _id: '$currency', commission: { $sum: '$metadata.platformFee' }, processingFees: { $sum: '$metadata.processingFee' } } },
    ]),
  ]);

  const commission = round(commissionRows[0]?.commission ?? 0);
  const processingFees = round(commissionRows[0]?.processingFees ?? 0);
  const subscriptionRevenue = 0;

  const byCurrency: PlatformEarningsByCurrency[] = commissionByCurrencyRows.map((row: any) => ({
    currency: row._id ?? 'USD',
    commission: round(row.commission ?? 0),
    processingFees: round(row.processingFees ?? 0),
    subscriptionRevenue: 0,
    total: round(row.commission ?? 0),
  }));
  return {
    commission, processingFees, subscriptionRevenue,
    total: round(commission + subscriptionRevenue),
    byCurrency,
  };
}
