import { DatabaseService } from 'src/database/databaseservice';

/**
 * Suspends a seller and cascades to every store they own. Shared by the Users page and the moderation queue so
 * both behave identically. Safe to repeat: the list of stores to restore later is MERGED (never overwritten),
 * so a second suspension (or a report action on an already-suspended seller) can no longer wipe it and leave
 * the stores suspended forever after unsuspend. The session is revoked (tokenVersion) only on the first change.
 * Returns false when the seller does not exist.
 */
export async function suspendSellerCascade(
  db: DatabaseService,
  sellerId: string,
): Promise<{ found: boolean; suspendedStores: number }> {
  const r = db.repositories;
  const seller = await r.sellerModel.findOneAndUpdate(
    { _id: sellerId, isDelete: false },
    [
      {
        $set: {
          tokenVersion: {
            $cond: [
              { $eq: ['$status', 'suspended'] },
              { $ifNull: ['$tokenVersion', 0] },
              { $add: [{ $ifNull: ['$tokenVersion', 0] }, 1] },
            ],
          },
          status: 'suspended',
        },
      },
    ],
    { updatePipeline: true, returnDocument: 'after' },
  );
  if (!seller) return { found: false, suspendedStores: 0 };

  const activeStores = await r.storeModel.find(
    { sellerId, isDelete: false, status: 'active' },
    { _id: 1 },
  );
  const ids = activeStores.map((s) => String(s._id));
  if (ids.length) {
    // Record first, suspend second: a crash in between leaves stores that unsuspend can still put right,
    // never suspended stores it has forgotten about.
    await r.sellerModel.updateOne(
      { _id: sellerId },
      { $addToSet: { cascadeSuspendedStoreIds: { $each: ids } } },
    );
    await r.storeModel.updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'suspended' } },
    );
  }
  return { found: true, suspendedStores: ids.length };
}
