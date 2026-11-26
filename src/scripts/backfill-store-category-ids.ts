/* eslint-disable prettier/prettier -- one-off script over raw Mongo documents */
/**
 * Backfills `Store.categoryIds` (the new up-to-3 array field) from the legacy scalar `Store.categoryId`
 * for every store that predates the array field — every store write path (createStore/updateStore and
 * the category-deletion reassignment) already keeps both in sync going forward, so this only matters
 * for a row nothing has re-saved since the array field shipped.
 *
 * DRY-RUN by default: prints the count and a few examples, writes nothing.
 *
 *   node --env-file=.env --experimental-strip-types src/scripts/backfill-store-category-ids.ts            # plan
 *   node --env-file=.env --experimental-strip-types src/scripts/backfill-store-category-ids.ts --apply    # write
 *
 * Idempotent: a second run finds nothing left to do.
 */
import mongoose from 'mongoose';

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const stores = db.collection('stores');

  const filter = {
    isDelete: { $ne: true },
    categoryId: { $ne: null },
    $or: [{ categoryIds: { $exists: false } }, { categoryIds: { $size: 0 } }],
  };
  const toFix = await stores.find(filter).project({ name: 1, categoryId: 1 }).toArray();

  console.log(`${toFix.length} store(s) have a categoryId but no categoryIds yet.`);
  for (const s of toFix.slice(0, 10)) console.log(`   - ${s.name} (${s._id}): categoryId ${s.categoryId}`);
  if (toFix.length > 10) console.log(`   ... and ${toFix.length - 10} more`);

  if (apply && toFix.length) {
    const res = await stores.updateMany(filter, [{ $set: { categoryIds: ['$categoryId'] } }]);
    console.log(`Updated ${res.modifiedCount} store(s).`);
  } else if (!apply) {
    console.log('Dry run — pass --apply to write.');
  }

  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
