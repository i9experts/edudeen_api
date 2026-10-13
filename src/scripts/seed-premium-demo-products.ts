/**
 * Adds 8 demo physical products (2 per store) to 4 EXISTING active stores, each store offering its OWN Edudeen
 * Premium member discount (store-wide percent + a different per-product override on one item), so the Premium
 * program can be seen working with different sellers giving different discounts.
 *
 * ADDITIVE and idempotent (products matched by slug, so re-running updates them in place). Only touches: new
 * product + variant documents, and `premiumDiscount` on the chosen stores. DRY-RUN by default.
 *
 *   node --env-file=.env --experimental-strip-types src/scripts/seed-premium-demo-products.ts                 # plan only
 *   node --env-file=.env --experimental-strip-types src/scripts/seed-premium-demo-products.ts --apply         # writes
 *   ... --stores slug-a,slug-b,slug-c,slug-d   # choose the 4 stores yourself (default: first 4 active, not 'edudeen-demo-store')
 *
 * Products are physical (with stock) on purpose: a digital product needs a real uploaded file, otherwise a paid
 * buyer could not download it. They have no photo - the storefront shows its themed category artwork.
 */
import mongoose from 'mongoose';

const CURRENCY = 'PKR';
const STORE_PERCENT = [10, 15, 20, 12]; // each seller's own store-wide Premium discount

interface Item { name: string; description: string; price: number; compareAt?: number; stock: number; cat: string; sub: string; classFrom: string; classTo: string; tags: string[]; override?: number }
// Index = store position (0..3); two items per store.
const ITEMS: Item[][] = [
  [
    { name: 'Noorani Qaida Colour-Coded Set', description: 'Colour-coded Noorani Qaida with tajweed guide and a practice sheet pad. Ideal for a child starting Quran reading.', price: 950, compareAt: 1200, stock: 40, cat: 'Quran & Tajweed', sub: 'Noorani Qaida', classFrom: 'class-1', classTo: 'class-2', tags: ['quran', 'qaida', 'kids'] },
    { name: 'Tajweed Rules Wall Chart (Laminated)', description: 'Large laminated wall chart summarising the key tajweed rules with colour codes, for classrooms and home study corners.', price: 1200, stock: 30, cat: 'Quran & Tajweed', sub: 'Tajweed Rules', classFrom: 'class-3', classTo: 'class-8', tags: ['tajweed', 'chart', 'classroom'], override: 20 },
  ],
  [
    { name: 'Urdu Qaida Practice Workbook', description: 'Step-by-step Urdu qaida with tracing pages, picture words and revision exercises for early readers.', price: 700, stock: 60, cat: 'Urdu Language', sub: 'Urdu Qaida & Alphabet', classFrom: 'prep', classTo: 'class-2', tags: ['urdu', 'qaida', 'workbook'] },
    { name: 'Phonics Flash Cards - 120 Cards', description: 'Sturdy flash cards covering letter sounds, blends and sight words, with a parent guide for games.', price: 1400, compareAt: 1800, stock: 45, cat: 'English Language', sub: 'Phonics & Early Reading', classFrom: 'kg', classTo: 'class-2', tags: ['phonics', 'flashcards', 'english'], override: 25 },
  ],
  [
    { name: 'Class 5 Mathematics Practice Book', description: 'Chapter-wise practice questions with worked examples and a monthly test section for Class 4-5 learners.', price: 1100, stock: 50, cat: 'Mathematics', sub: 'Arithmetic', classFrom: 'class-4', classTo: 'class-5', tags: ['maths', 'practice', 'book'] },
    { name: 'STEM Science Experiment Kit', description: '20 safe, guided experiments with all the small parts included and an illustrated manual. Ages 8+.', price: 2600, compareAt: 3100, stock: 25, cat: 'Science', sub: 'Science Experiments & Kits', classFrom: 'class-4', classTo: 'class-8', tags: ['science', 'stem', 'kit'], override: 30 },
  ],
  [
    { name: 'Islamic Studies Worksheets Bundle (Printed)', description: 'Printed worksheet bundle on salah, wudu, manners and the stories of the Prophets, with answer keys.', price: 800, stock: 55, cat: 'Islamic Studies', sub: 'Islamic Studies Worksheets', classFrom: 'class-1', classTo: 'class-5', tags: ['islamic studies', 'worksheets', 'printed'] },
    { name: 'Wooden Arabic Alphabet Puzzle', description: 'All 28 Arabic letters as chunky wooden pieces that teach letter shapes through play. Ages 3+.', price: 1900, stock: 35, cat: 'Educational Toys & Games', sub: 'Islamic Educational Toys', classFrom: 'nursery', classTo: 'class-1', tags: ['arabic', 'puzzle', 'montessori'], override: 18 },
  ],
];

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  const storesArgI = process.argv.indexOf('--stores');
  const wanted = storesArgI > -1 ? String(process.argv[storesArgI + 1]).split(',').map(s => s.trim()).filter(Boolean) : null;

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const storesCol = db.collection('stores');
  const cats = db.collection('categories');
  const products = db.collection('products');
  const variants = db.collection('productvariants');
  const now = new Date();

  const all = await storesCol.find({ status: 'active', isDelete: { $ne: true } }).sort({ createdAt: 1 }).toArray();
  console.log('Active stores found:');
  all.forEach(s => console.log(`  - ${s.name} (${s.slug}) seller=${s.sellerId}`));
  const chosen = (wanted ? wanted.map(sl => all.find(s => s.slug === sl)).filter(Boolean) : all.filter(s => s.slug !== 'edudeen-demo-store').slice(0, 4)) as any[];
  if (chosen.length < 4) { console.error(`Need 4 stores, found ${chosen.length}. Pass --stores slug1,slug2,slug3,slug4`); await mongoose.disconnect(); process.exit(1); }

  let made = 0;
  for (const [si, store] of chosen.entries()) {
    const percent = STORE_PERCENT[si];
    console.log(`\n${store.name}: store-wide Premium discount ${percent}%`);
    if (apply) await storesCol.updateOne({ _id: store._id }, { $set: { premiumDiscount: { enabled: true, percent }, updatedAt: now } });
    for (const [ii, it] of ITEMS[si].entries()) {
      const root = await cats.findOne({ name: it.cat, parentId: null, status: 'active', isDelete: { $ne: true } });
      if (!root) { console.log(`  ! category "${it.cat}" not found - skipped ${it.name}`); continue; }
      const sub = await cats.findOne({ name: it.sub, parentId: String(root._id), status: 'active', isDelete: { $ne: true } });
      const slug = `${slugify(it.name)}-${String(store.slug).slice(0, 8)}`;
      const eff = it.override ?? percent;
      console.log(`  + ${it.name}  Rs ${it.price}  [${it.cat} > ${sub ? it.sub : '(no sub)'}]  Premium ${eff}%${it.override ? ' (product override)' : ''}`);
      if (!apply) { made++; continue; }
      await products.updateOne({ slug }, {
        $set: {
          sellerId: store.sellerId, storeId: String(store._id), name: it.name, description: it.description,
          productType: 'physical', type: 'physical', categoryId: String(root._id), subCategoryId: sub ? String(sub._id) : null,
          images: [], tags: it.tags, digital: null, status: 'active', isDelete: false, isListedOnEdudeen: true,
          classFrom: it.classFrom, classTo: it.classTo,
          premiumDiscountPercent: it.override ?? null, updatedAt: now,
        },
        $setOnInsert: {
          slug, educationLevel: null, customLevel: null, normalizedCustomLevel: null, viewCount: 0, wishlistCount: 0, purchaseCount: 0,
          averageRating: 0, ratingSum: 0, totalRatings: 0, lastViewedAt: null, lastPurchasedAt: null, lastWishlistedAt: null,
          scheduledAt: null, earlyAccessUntil: null, isFeatured: false, seo: {}, createdAt: new Date(now.getTime() - (si * 2 + ii) * 1000),
        },
      }, { upsert: true });
      const product = await products.findOne({ slug });
      const productId = String(product!._id);
      await variants.updateOne({ productId, isDefault: true }, {
        $set: { price: it.price, compareAtPrice: it.compareAt ?? null, currency: CURRENCY, stock: it.stock, status: 'active', isDelete: false, updatedAt: now },
        $setOnInsert: { productId, sku: `PRM-${si + 1}-${ii + 1}-${String(productId).slice(-4)}`, barcode: null, options: [], unlimitedStock: false, shippingWeight: null, images: [], isDefault: true, createdAt: now },
      }, { upsert: true });
      made++;
    }
  }
  console.log(`\n${apply ? 'DONE' : 'DRY RUN - nothing written'}: ${made} products ${apply ? 'created/updated' : 'planned'} across ${chosen.length} stores.`);
  if (!apply) console.log('Re-run with --apply to write them.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
