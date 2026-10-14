/**
 * Makes existing products follow the Premium rules (owner request):
 *  1. a product with an effective Premium offer is removed from every platform (mega) sale - `campaignIds` cleared;
 *  2. the seller's OWN normal sale stays, but is capped at (Premium % - minimum gap, default 5 points): if a variant's
 *     sale (compare-at vs price) is bigger, its price is raised so the sale equals the allowed percent (rounded up to a
 *     whole price so the sale never exceeds it); if nothing is allowed the sale is removed (price = compare-at).
 * Effective Premium % = product.premiumDiscountPercent, else the store's enabled premiumDiscount percent, 0 when the
 * product opted out (premiumOptOut). DRY-RUN by default; touches only products.campaignIds and productvariants.price/compareAtPrice.
 *
 *   node --env-file=.env --experimental-strip-types src/scripts/fix-premium-offer-conflicts.ts           # plan only
 *   node --env-file=.env --experimental-strip-types src/scripts/fix-premium-offer-conflicts.ts --apply   # writes
 */
import mongoose from 'mongoose';

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  // Minimum gap from the admin's Premium settings (default 5).
  let gap = 5;
  const colls = (await db.listCollections().toArray()).map(c => c.name);
  const settingsName = colls.find(n => /^premium.*settings?$/i.test(n));
  if (settingsName) {
    const row: any = await db.collection(settingsName).findOne({ key: 'default' });
    if (row && Number.isFinite(Number(row.minGapPercent))) gap = Number(row.minGapPercent);
  }
  console.log(`minimum gap between a normal sale and Premium: ${gap} points\n`);

  const stores = await db.collection('stores').find({}, { projection: { name: 1, premiumDiscount: 1 } }).toArray();
  const storeById = new Map(stores.map((s: any) => [String(s._id), s]));
  const products = await db.collection('products').find({ isDelete: { $ne: true } }).toArray();
  const variantsCol = db.collection('productvariants');

  let campaignFixes = 0, priceFixes = 0, checked = 0;
  for (const p of products as any[]) {
    const store: any = storeById.get(String(p.storeId));
    const storePct = store?.premiumDiscount?.enabled ? Number(store.premiumDiscount.percent) : 0;
    const premium = p.premiumOptOut ? 0 : (p.premiumDiscountPercent != null ? Number(p.premiumDiscountPercent) : storePct);
    if (!(premium > 0)) continue;
    checked++;
    const lines: string[] = [];

    if (Array.isArray(p.campaignIds) && p.campaignIds.length > 0) {
      lines.push(`  - leaves ${p.campaignIds.length} platform sale(s)`);
      campaignFixes++;
      if (apply) await db.collection('products').updateOne({ _id: p._id }, { $set: { campaignIds: [] } });
    }

    const allowed = Math.max(0, premium - gap);
    const variants = await variantsCol.find({ productId: String(p._id), isDelete: { $ne: true } }).toArray();
    for (const v of variants as any[]) {
      const price = Number(v.price), compare = Number(v.compareAtPrice);
      if (!(compare > price) || !(price >= 0)) continue;
      const sale = (1 - price / compare) * 100;
      if (sale <= allowed + 1e-9) continue;
      const set: Record<string, unknown> = allowed <= 0
        ? { price: compare, compareAtPrice: null }
        : { price: Math.ceil(compare * (1 - allowed / 100)) };
      lines.push(`  - variant ${v.sku ?? v._id}: sale ${sale.toFixed(1)}% > allowed ${allowed}% -> price ${price} => ${set.price}${allowed <= 0 ? ' (sale removed)' : ''}`);
      priceFixes++;
      if (apply) await variantsCol.updateOne({ _id: v._id }, { $set: { ...set, updatedAt: new Date() } });
    }
    if (lines.length) console.log(`${store?.name ?? p.storeId} / ${p.name}  (Premium ${premium}%)\n${lines.join('\n')}`);
  }

  console.log(`\n${apply ? 'DONE' : 'DRY RUN - nothing written'}: ${checked} products have a Premium offer; ${campaignFixes} removed from platform sales, ${priceFixes} variant prices adjusted.`);
  if (!apply) console.log('Re-run with --apply to write.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
