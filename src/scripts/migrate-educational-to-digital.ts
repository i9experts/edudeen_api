/**
 * Retires the 'educational' product type: every educational product becomes 'digital'. DRY-RUN by default.
 *
 *   npm run migrate:educational              report only
 *   npm run migrate:educational:apply        products.productType educational -> digital, stores.productTypes educational -> digital (deduped)
 *
 * Nothing else changes (status, price, files, class range, educationLevel stay as they are). Orders / checkouts keep
 * their historical item type 'educational'. Safe to re-run.
 */
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const products = db.collection('products');
  const stores = db.collection('stores');

  const prodFilter = { productType: 'educational' };
  const total = await products.countDocuments(prodFilter);
  console.log(`Educational products: ${total}`);
  const byState = await products.aggregate([{ $match: prodFilter }, { $group: { _id: { s: '$status', d: '$isDelete', f: '$deliveryFormat' }, n: { $sum: 1 } } }]).toArray();
  for (const r of byState) console.log(`  status=${r._id.s}${r._id.d ? ' (deleted)' : ''} format=${r._id.f ?? 'download'}: ${r.n}`);
  const noClass = await products.countDocuments({ ...prodFilter, isDelete: { $ne: true }, status: { $in: ['active', 'scheduled', 'pending_review'] }, $or: [{ classFrom: { $in: [null, ''] } }, { classFrom: { $exists: false } }] });
  console.log(`  live/pending ones with NO class range (will have none as digital either; seller can add): ${noClass}`);

  const storeFilter = { productTypes: 'educational' };
  const storeCount = await stores.countDocuments(storeFilter);
  console.log(`Stores listing 'educational' in productTypes: ${storeCount}`);

  if (!APPLY) { console.log('\nDRY RUN - nothing was written. Re-run with :apply.'); await mongoose.disconnect(); return; }

  const p = await products.updateMany(prodFilter, { $set: { productType: 'digital' } });
  // Replace 'educational' with 'digital' and drop duplicates in one pipeline update.
  const s = await stores.updateMany(storeFilter, [
    { $set: { productTypes: { $setUnion: [{ $map: { input: '$productTypes', as: 't', in: { $cond: [{ $eq: ['$$t', 'educational'] }, 'digital', '$$t'] } } }, []] } } },
  ]);
  console.log(`\nAPPLIED: products ${p.modifiedCount}, stores ${s.modifiedCount}`);
  console.log(`Left: products ${await products.countDocuments(prodFilter)}, stores ${await stores.countDocuments(storeFilter)}`);
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
