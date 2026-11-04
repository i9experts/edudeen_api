/**
 * READ-ONLY report: near-duplicate collection names per store (same name after lowercasing and dropping spaces /
 * punctuation, e.g. "Hurry Up !" vs "hurry-up"). Writes nothing, merges nothing. Also lists stores over the 20 cap.
 *
 *   npm run report:collection-duplicates
 *
 * Run it BEFORE adding the unique index { storeId, normalizedName } - the index build fails if duplicates exist.
 */
import mongoose from 'mongoose';

// Same rule as src/collections/collection-name.util.ts (kept inline: this script runs without the TS build).
const normalize = (s: unknown) =>
  (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const rows = await db.collection('collections')
    .find({ isDelete: { $ne: true } }, { projection: { storeId: 1, name: 1, slug: 1, status: 1, type: 1, productIds: 1, createdAt: 1 } })
    .toArray();

  const byStore = new Map<string, any[]>();
  for (const r of rows) {
    const list = byStore.get(String(r.storeId)) ?? [];
    list.push(r);
    byStore.set(String(r.storeId), list);
  }

  let dupGroups = 0, emptyKeys = 0, overCap = 0, tooLong = 0;
  for (const [storeId, list] of byStore) {
    const store = await db.collection('stores').findOne({ _id: new mongoose.Types.ObjectId(storeId) }, { projection: { name: 1 } }).catch(() => null);
    const label = `${store?.name ?? '(unknown store)'} (${storeId})`;
    const groups = new Map<string, any[]>();
    for (const c of list) {
      const key = normalize(c.name);
      if (!key) { emptyKeys++; console.log(`\n[${label}] name has no letters/digits: "${c.name}" (${c._id})`); continue; }
      if (String(c.name).trim().length > 40 || String(c.name).trim().length < 2) tooLong++;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    if (list.length > 20) { overCap++; console.log(`\n[${label}] has ${list.length} collections (cap is 20)`); }
    for (const [key, g] of groups) {
      if (g.length < 2) continue;
      dupGroups++;
      console.log(`\n[${label}] duplicate group "${key}" (${g.length}):`);
      for (const c of g) {
        const n = c.type === 'manual' ? `${(c.productIds ?? []).length} products` : 'automatic';
        console.log(`  - ${c._id}  "${c.name}"  /${c.slug}  ${c.status}  ${n}  created ${c.createdAt?.toISOString?.() ?? '?'}`);
      }
    }
  }

  console.log(`\nStores with collections: ${byStore.size}; collections: ${rows.length}`);
  console.log(`Duplicate groups: ${dupGroups}; names with no letters: ${emptyKeys}; stores over 20: ${overCap}; names outside 2-40 chars: ${tooLong}`);
  console.log('Nothing was changed.');
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
