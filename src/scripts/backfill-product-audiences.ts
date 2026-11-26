/* eslint-disable prettier/prettier, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- one-off script over raw Mongo documents */
/**
 * Fills `audiences` (kids / teens / parents / teachers / schools / ...) on existing products that have none, from
 * data they already have: category names, age range, licence and the legacy education level (see inferAudiences in
 * src/common/edu-filters.const.ts). Conservative: a product with no clear signal is left empty for the seller.
 * Never overwrites a product that already has audiences. DRY-RUN by default.
 *
 *   node --env-file=.env --experimental-strip-types src/scripts/backfill-product-audiences.ts           # plan + sample
 *   node --env-file=.env --experimental-strip-types src/scripts/backfill-product-audiences.ts --apply   # writes
 */
import mongoose from 'mongoose';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  const { inferAudiences } = await import(pathToFileURL(path.join(process.cwd(), 'src/common/edu-filters.const.ts')).href);

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const products = db.collection('products');
  const variants = db.collection('productvariants');

  const catNames = new Map<string, string>(
    (await db.collection('categories').find({}, { projection: { name: 1 } }).toArray()).map((c: any) => [String(c._id), String(c.name)]),
  );

  const filter = { isDelete: { $ne: true }, $or: [{ audiences: { $exists: false } }, { audiences: { $size: 0 } }] };
  const total = await products.countDocuments(filter);
  const cursor = products.find(filter, { projection: { name: 1, categoryId: 1, subCategoryId: 1, ageMin: 1, ageMax: 1, educationLevel: 1, deliveryFormat: 1 } });

  let filled = 0, unknown = 0, ops: any[] = [];
  const counts: Record<string, number> = {};
  const samples: string[] = [];
  for await (const p of cursor) {
    // Licence lives on the default variant's "License" option (personal / single_classroom / school / commercial).
    const v: any = await variants.findOne({ productId: String(p._id), isDefault: true }, { projection: { options: 1 } });
    const label = (v?.options ?? []).find((o: any) => o?.name === 'License')?.value;
    const licenseType = label === 'One classroom' ? 'single_classroom' : label === 'Whole school' ? 'school' : null;
    const audiences = inferAudiences({
      rootCategoryName: catNames.get(String(p.categoryId)) ?? null,
      subCategoryName: p.subCategoryId ? catNames.get(String(p.subCategoryId)) ?? null : null,
      ageMin: p.ageMin ?? null, ageMax: p.ageMax ?? null, licenseType,
      educationLevel: p.educationLevel ?? null, deliveryFormat: p.deliveryFormat ?? null,
    });
    if (!audiences.length) { unknown++; continue; }
    filled++;
    for (const a of audiences) counts[a] = (counts[a] ?? 0) + 1;
    if (samples.length < 15) samples.push(`   ${String(p.name).slice(0, 60).padEnd(60)} -> ${audiences.join(', ')}`);
    ops.push({ updateOne: { filter: { _id: p._id, $or: filter.$or }, update: { $set: { audiences } } } });
    if (apply && ops.length >= 500) { await products.bulkWrite(ops, { ordered: false }); ops = []; }
  }
  if (apply && ops.length) await products.bulkWrite(ops, { ordered: false });

  console.log(`Products without an audience: ${total}`);
  console.log(`${apply ? 'Filled' : 'Would fill'}: ${filled}   No clear signal (left empty): ${unknown}`);
  console.log('By audience:', counts);
  if (samples.length) console.log(`Sample:\n${samples.join('\n')}`);
  if (!apply) console.log('\nDRY RUN - nothing written. Re-run with --apply to write.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
