/* eslint-disable prettier/prettier */
import type { Model } from 'mongoose';

/**
 * A store whose platform plan is `expired` (free trial ended, no paid plan chosen) has its live
 * listings hidden from buyers; the moment it has a usable plan again the SAME listings go back live.
 *
 * Mechanism: status flip + marker. Every public query already shows only `status:'active'`, so no
 * query needs to change. Only products WE paused carry `pausedFromStatus`, so a seller's own
 * inactive/draft products are never touched and are never switched on by a plan purchase.
 */
export const PAUSABLE_STATUSES = ['active', 'scheduled'] as const;

export interface PlanSyncResult { paused: number; restored: number }

/** Subscription statuses that count as "no usable plan" (listings hidden):
 *  expired (trial ended, cancellation / admin grant / failed payments lapsed to free) and past_due (payment failing). */
export const NO_PLAN_STATUSES = ['expired', 'past_due', 'canceled'] as const;
export function isPlanExpired(subStatus: string | null | undefined): boolean {
  return !!subStatus && (NO_PLAN_STATUSES as readonly string[]).includes(subStatus);
}

/** Pause (expired) or restore (anything else) the store's listings. Idempotent. */
export async function syncStoreListings(
  productModel: Model<any>,
  storeId: string,
  subStatus: string | null | undefined,
  now: Date = new Date(),
): Promise<PlanSyncResult> {
  const result: PlanSyncResult = { paused: 0, restored: 0 };
  if (!storeId) return result;

  if (isPlanExpired(subStatus)) {
    for (const from of PAUSABLE_STATUSES) {
      const res: any = await productModel.updateMany(
        { storeId, status: from, isDelete: { $ne: true }, pausedFromStatus: null },
        { $set: { status: 'inactive', pausedFromStatus: from, pausedByPlanAt: now } },
      );
      result.paused += res?.modifiedCount ?? 0;
    }
    return result;
  }

  const paused: any[] = await productModel
    .find({ storeId, pausedFromStatus: { $in: PAUSABLE_STATUSES as unknown as string[] }, isDelete: { $ne: true } })
    .select('_id pausedFromStatus scheduledAt')
    .lean();
  if (!paused.length) return result;

  const toActive: unknown[] = [];
  const toScheduled: unknown[] = [];
  for (const p of paused) {
    const future = p.pausedFromStatus === 'scheduled' && p.scheduledAt && new Date(p.scheduledAt).getTime() > now.getTime();
    (future ? toScheduled : toActive).push(p._id);
  }
  const clear = { pausedFromStatus: null, pausedByPlanAt: null };
  if (toActive.length) {
    const res: any = await productModel.updateMany(
      { _id: { $in: toActive }, status: 'inactive', pausedFromStatus: { $ne: null } },
      { $set: { status: 'active', ...clear } },
    );
    result.restored += res?.modifiedCount ?? 0;
  }
  if (toScheduled.length) {
    const res: any = await productModel.updateMany(
      { _id: { $in: toScheduled }, status: 'inactive', pausedFromStatus: { $ne: null } },
      { $set: { status: 'scheduled', ...clear } },
    );
    result.restored += res?.modifiedCount ?? 0;
  }
  // A seller who manually changed a paused product meanwhile (status no longer inactive): just drop the marker.
  await productModel.updateMany(
    { storeId, pausedFromStatus: { $ne: null }, status: { $ne: 'inactive' } },
    { $set: clear },
  );
  return result;
}
