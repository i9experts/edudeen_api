/**
 * Moves the old auto-generated SKUs (SKU-AB12CD-3456, SKU-AB12CD-3456-0, DEMO-001, PRM-1-2-ab12 ...) onto the new
 * per-seller format <STORE>-<id>-<YYMMDD>-<NNNN> (see src/products/sku.util.ts), e.g. MPU-4F-261019-0007.
 *  - numbering is per store, in the order the variants were created (1, 2, 3 ...); the date is the variant's creation day (Pakistan time)
 *  - a SKU the seller typed themselves is NEVER changed (only the old auto patterns above are rewritten)
 *  - Store.skuSeq is raised to the highest number used so new products continue the sequence
 *  - existing orders keep the SKU they were placed with (historical snapshot)
 * DRY-RUN by default; writes only productvariants.sku and stores.skuSeq.
 *
 *   node --env-file=.env --experimental-strip-types src/scripts/fix-variant-skus.ts           # plan only
 *   node --env-file=.env --experimental-strip-types src/scripts/fix-variant-skus.ts --apply   # writes
 */
import mongoose from 'mongoose';

// Same format as src/products/sku.util.ts (kept inline: scripts run with strip-types and cannot import .ts siblings under tsc).
function formatSku(store: { _id: unknown; name?: string | null }, seq: number, now: Date): string {
  const letters = String(store.name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3).padEnd(3, 'X');
  const pk = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  const d = `${String(pk.getUTCFullYear()).slice(-2)}${String(pk.getUTCMonth() + 1).padStart(2, '0')}${String(pk.getUTCDate()).padStart(2, '0')}`;
  return `${letters}-${String(store._id).slice(-2).toUpperCase()}-${d}-${String(seq).padStart(4, '0')}`;
}

// Old auto patterns + the new format itself (so a re-run, or numbers issued after deploy, are renumbered consistently by creation order).
const OLD_AUTO = [/^SKU-[0-9A-F]{6}(-[0-9A-Z]{1,4}){1,2}$/i, /^DEMO-\d+$/i, /^PRM-\d+-\d+-[0-9a-f]{4}$/i, /^[A-Z0-9]{3}-[0-9A-F]{2}-\d{6}-\d{4}$/];
const isOldAuto = (sku: unknown) => typeof sku === 'string' && OLD_AUTO.some(rx => rx.test(sku));

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const stores: any[] = await db.collection('stores').find({}, { projection: { name: 1, skuSeq: 1 } }).toArray();
  const variantsCol = db.collection('productvariants');
  let changed = 0, kept = 0, storesTouched = 0;

  for (const store of stores) {
    const products: any[] = await db.collection('products').find({ storeId: String(store._id) }, { projection: { _id: 1 } }).toArray();
    if (!products.length) continue;
    const variants: any[] = await variantsCol
      .find({ productId: { $in: products.map(p => String(p._id)) }, isDelete: { $ne: true } })
      .sort({ createdAt: 1, _id: 1 }).toArray();
    const todo = variants.filter(v => isOldAuto(v.sku) && v.sku !== undefined);
    kept += variants.length - todo.length;
    if (!todo.length) continue;
    storesTouched++;

    // One running number per variant of the store (kept custom SKUs also use up a number so nothing collides).
    let seq = 0;
    const plan: Array<{ id: unknown; from: string; to: string }> = [];
    for (const v of variants) {
      seq++;
      if (!isOldAuto(v.sku)) continue;
      plan.push({ id: v._id, from: v.sku, to: formatSku(store, seq, new Date(v.createdAt ?? Date.now())) });
    }
    console.log(`${store.name ?? store._id}: ${plan.length} of ${variants.length} variants`);
    for (const p of plan.slice(0, 5)) console.log(`   ${p.from}  ->  ${p.to}`);
    if (plan.length > 5) console.log(`   ... and ${plan.length - 5} more`);
    changed += plan.length;

    if (apply) {
      for (const p of plan) await variantsCol.updateOne({ _id: p.id as any }, { $set: { sku: p.to, updatedAt: new Date() } });
      await db.collection('stores').updateOne({ _id: store._id }, { $set: { skuSeq: Math.max(Number(store.skuSeq) || 0, seq) } });
    }
  }

  console.log(`\n${apply ? 'DONE' : 'DRY RUN - nothing written'}: ${changed} SKUs in ${storesTouched} stores moved to the new format; ${kept} left as they were (custom or already new).`);
  if (!apply) console.log('Re-run with --apply to write.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
