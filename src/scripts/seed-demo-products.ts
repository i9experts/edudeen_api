/**
 * Seeds one demo seller + active store + 10 marketplace products (5 physical,
 * 5 digital), each with a single default variant carrying its price — the
 * minimum the public listing (ProductsService.getProductsByCategoryId) needs:
 * product status 'active', store status 'active', one active variant.
 *
 * Idempotent: seller is matched by email, store by slug, products by slug, so
 * re-running updates in place instead of duplicating.
 *
 * Digital products carry a placeholder Cloudinary public_id in
 * `digital.files[].url` — they list and render fine, but a real purchase's
 * download link will fail until a real file is uploaded from the dashboard.
 *
 * Env overrides: SEED_DEMO_SELLER_EMAIL / SEED_DEMO_SELLER_PASSWORD
 *
 * Usage: node --env-file=.env src/scripts/seed-demo-products.ts
 */
import mongoose from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as crypto from 'node:crypto';

const SELLER_EMAIL = (process.env.SEED_DEMO_SELLER_EMAIL ?? 'demo.seller@edudeen.com').toLowerCase().trim();
const STORE_SLUG = 'edudeen-demo-store';
const CURRENCY = 'PKR';

const img = (id: string) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=900&q=80`;

type DemoProduct = {
  name: string;
  description: string;
  kind: 'physical' | 'digital';
  price: number;
  compareAtPrice?: number;
  stock?: number;
  image: string;
  tags: string[];
  fileName?: string;
};

const PRODUCTS: DemoProduct[] = [
  // ── Physical ──
  {
    name: 'Noorani Qaida — Colour Coded Hardcover',
    description: 'Colour-coded Noorani Qaida for children beginning Quran reading. Durable hardcover, large clear Arabic script and tajweed colour guide on every page.',
    kind: 'physical', price: 850, compareAtPrice: 1100, stock: 60,
    image: img('photo-1609599006353-e629aaabfeae'), tags: ['quran', 'kids', 'qaida'],
  },
  {
    name: 'Kids Padded Prayer Mat',
    description: 'Soft, padded prayer mat sized for children (60 × 100 cm) with a non-slip back. Machine washable, gentle colours.',
    kind: 'physical', price: 1450, stock: 40,
    image: img('photo-1584551246679-0daf3d275d0f'), tags: ['salah', 'kids', 'prayer mat'],
  },
  {
    name: 'Wooden Arabic Alphabet Puzzle',
    description: 'All 28 Arabic letters as chunky wooden puzzle pieces. Helps little learners recognise letter shapes through play. Ages 3+.',
    kind: 'physical', price: 1950, compareAtPrice: 2400, stock: 35,
    image: img('photo-1596464716127-f2a82984de30'), tags: ['arabic', 'montessori', 'puzzle'],
  },
  {
    name: 'Stories of the Prophets — 10 Book Set',
    description: 'Ten beautifully illustrated storybooks retelling the lives of the Prophets in simple, age-appropriate English. Perfect for bedtime reading.',
    kind: 'physical', price: 3200, stock: 25,
    image: img('photo-1512820790803-83ca734da794'), tags: ['stories', 'books', 'seerah'],
  },
  {
    name: 'Digital Tasbih Counter Ring',
    description: 'Lightweight finger-ring tasbih counter with LED display and memory. Count dhikr anywhere, quietly and accurately.',
    kind: 'physical', price: 650, stock: 100,
    image: img('photo-1590076215667-875d4ef2d7de'), tags: ['dhikr', 'tasbih'],
  },
  // ── Digital ──
  {
    name: 'Arabic Alphabet Tracing Worksheets (PDF)',
    description: '56 printable tracing worksheets covering every Arabic letter in its isolated and joined forms. Instant PDF download, print as many times as you like.',
    kind: 'digital', price: 450,
    image: img('photo-1503676260728-1c00da094a0b'), tags: ['worksheets', 'arabic', 'printable'],
    fileName: 'arabic-alphabet-tracing.pdf',
  },
  {
    name: 'Ramadan Activity Pack for Kids',
    description: '30-day Ramadan journal, good-deeds tracker, colouring pages and a family iftar planner. Printable PDF bundle.',
    kind: 'digital', price: 600, compareAtPrice: 900,
    image: img('photo-1532375810709-75b1da00537c'), tags: ['ramadan', 'activities', 'printable'],
    fileName: 'ramadan-activity-pack.pdf',
  },
  {
    name: 'Juz Amma Memorisation Tracker',
    description: 'A printable chart for tracking memorisation of every surah in Juz Amma, with revision checkboxes and reward stickers.',
    kind: 'digital', price: 300,
    image: img('photo-1606326608606-aa0b62935f2b'), tags: ['hifz', 'quran', 'tracker'],
    fileName: 'juz-amma-tracker.pdf',
  },
  {
    name: 'Step-by-Step Salah Guide Posters',
    description: 'Set of 8 illustrated posters showing each position of salah with the Arabic, transliteration and meaning. A4 and A3 print-ready PDF.',
    kind: 'digital', price: 500,
    image: img('photo-1497633762265-9d179a990aa6'), tags: ['salah', 'posters', 'classroom'],
    fileName: 'salah-guide-posters.pdf',
  },
  {
    name: 'Daily Duas Flashcards (Printable)',
    description: '40 flashcards with everyday duas — waking up, eating, travelling and more — in Arabic, transliteration and English.',
    kind: 'digital', price: 350,
    image: img('photo-1456513080510-7bf3a84b82f8'), tags: ['duas', 'flashcards', 'printable'],
    fileName: 'daily-duas-flashcards.pdf',
  },
];

// Mirrors src/common/slug.util.ts's base rule (no -N suffix — slugs here are
// fixed so re-runs match the same documents).
const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const now = new Date();

  // ── Category: products always take the store's root category. On an empty
  // database (no admin has created one yet) a single root category is made. ──
  const categories = db.collection('categories');
  let roots = await categories.find({ parentId: null, status: 'active', isDelete: false }).toArray();
  if (!roots.length) {
    await categories.updateOne(
      { slug: 'islamic-educational-resources' },
      {
        $set: { status: 'active', isDelete: false, updatedAt: now },
        $setOnInsert: {
          name: 'Islamic & Educational Resources',
          slug: 'islamic-educational-resources',
          parentId: null,
          image: null,
          description: 'Books, learning aids and printable resources for homes and classrooms.',
          sortOrder: 0,
          createdBy: null,
          createdByRole: 'admin',
          seo: {},
          createdAt: now,
        },
      },
      { upsert: true },
    );
    roots = await categories.find({ parentId: null, status: 'active', isDelete: false }).toArray();
  }
  const category = roots.find(c => /educat|islam|book|learn/i.test(String(c.name))) ?? roots[0];
  const categoryId = category._id.toString();
  console.log(`category: ${category.name} (${categoryId})`);

  // ── Seller ──
  const sellers = db.collection('sellers');
  let seller = await sellers.findOne({ email: SELLER_EMAIL });
  let password: string | null = null;
  if (!seller) {
    password = process.env.SEED_DEMO_SELLER_PASSWORD
      ?? crypto.randomBytes(9).toString('base64url') + '@7';
    const res = await sellers.insertOne({
      name: 'Edudeen Demo Store',
      email: SELLER_EMAIL,
      password: await bcrypt.hash(password, 10),
      role: 'seller',
      isVerified: true,
      status: 'active',
      isDelete: false,
      isOnboarded: true,
      storeId: null,
      profileImage: null,
      stripeCustomerId: null,
      hasPlatformPaymentMethod: false,
      stripeConnectedAccountId: null,
      stripeConnectStatus: 'not_connected',
      stripeConnectChargesEnabled: false,
      stripeConnectPayoutsEnabled: false,
      tokenVersion: 0,
      cascadeSuspendedStoreIds: [],
      onboardingDraft: null,
      createdAt: now,
      updatedAt: now,
    });
    seller = await sellers.findOne({ _id: res.insertedId });
  }
  const sellerId = seller!._id.toString();

  // ── Store ──
  const stores = db.collection('stores');
  await stores.updateOne(
    { slug: STORE_SLUG },
    {
      $set: { status: 'active', isDelete: false, updatedAt: now },
      $setOnInsert: {
        sellerId,
        name: 'Edudeen Demo Store',
        slug: STORE_SLUG,
        description: 'Islamic and educational resources for homes and classrooms.',
        baseCurrency: CURRENCY,
        categoryId,
        productTypes: ['physical_products', 'digital_downloads'],
        enabledTools: ['inventory_manager', 'shipping_manager', 'digital_delivery', 'ai_studio', 'marketplace_listing'],
        sellerType: 'educator',
        plan: 'starter',
        aiCredits: 100,
        country: 'PK',
        verificationStatus: 'not_started',
        reviewedAt: now,
        logo: null,
        coverImage: null,
        registers: [],
        shifts: [],
        builderConfig: null,
        customDomain: null,
        customDomainStatus: 'unverified',
        whiteLabelEnabled: false,
        followersCount: 0,
        averageRating: 0,
        reviewCount: 0,
        badges: [],
        codEnabled: true,
        seo: {},
        pinnedProductIds: [],
        announcementBar: {},
        verification: {},
        createdAt: now,
      },
    },
    { upsert: true },
  );
  const store = await stores.findOne({ slug: STORE_SLUG });
  const storeId = store!._id.toString();
  if (store!.sellerId !== sellerId) {
    throw new Error(`Store "${STORE_SLUG}" already exists under a different seller — pick another STORE_SLUG`);
  }
  await db.collection('storethemes').updateOne(
    { storeId },
    { $setOnInsert: { storeId, createdAt: now, updatedAt: now } },
    { upsert: true },
  );

  // ── Products + default variant ──
  const products = db.collection('products');
  const variants = db.collection('productvariants');
  for (const [i, p] of PRODUCTS.entries()) {
    const slug = slugify(p.name);
    const isDigital = p.kind === 'digital';
    await products.updateOne(
      { slug },
      {
        $set: {
          sellerId,
          storeId,
          name: p.name,
          description: p.description,
          productType: p.kind,
          type: p.kind,
          categoryId,
          images: [p.image],
          tags: p.tags,
          digital: isDigital
            ? {
                files: [{ url: `demo/${slug}`, name: p.fileName, size: null, mimeType: 'application/pdf' }],
                downloadLimit: 'unlimited',
                linkExpiryDays: null,
                pdfStampingEnabled: false,
                licenseType: 'personal',
                buyerDeliveryMessage: null,
                preview: { enabled: false, sourceFileIndex: null, previewSourcePublicId: null, previewSourceResourceType: null },
              }
            : null,
          status: 'active',
          isDelete: false,
          isListedOnEdudeen: true,
          updatedAt: now,
        },
        $setOnInsert: {
          slug,
          subCategoryId: null,
          educationLevel: null,
          customLevel: null,
          normalizedCustomLevel: null,
          viewCount: 0,
          wishlistCount: 0,
          purchaseCount: 0,
          averageRating: 0,
          ratingSum: 0,
          totalRatings: 0,
          lastViewedAt: null,
          lastPurchasedAt: null,
          lastWishlistedAt: null,
          scheduledAt: null,
          earlyAccessUntil: null,
          isFeatured: false,
          seo: {},
          // Staggered so the listing's createdAt:-1 sort keeps this file's order
          createdAt: new Date(now.getTime() - i * 1000),
        },
      },
      { upsert: true },
    );
    const product = await products.findOne({ slug });
    const productId = product!._id.toString();

    await variants.updateOne(
      { productId, isDefault: true },
      {
        $set: {
          price: p.price,
          compareAtPrice: p.compareAtPrice ?? null,
          currency: CURRENCY,
          stock: isDigital ? 0 : (p.stock ?? 0),
          status: 'active',
          isDelete: false,
          updatedAt: now,
        },
        $setOnInsert: {
          productId,
          sku: `DEMO-${String(i + 1).padStart(3, '0')}`,
          barcode: null,
          options: [],
          unlimitedStock: false,
          shippingWeight: null,
          images: [],
          isDefault: true,
          createdAt: now,
        },
      },
      { upsert: true },
    );
    console.log(`${p.kind.padEnd(8)} ${CURRENCY} ${String(p.price).padStart(5)}  ${p.name}`);
  }

  console.log(`\nstore: /${STORE_SLUG} (${storeId})`);
  console.log(password
    ? `seller login: ${SELLER_EMAIL} / ${password}`
    : `seller login: ${SELLER_EMAIL} (already existed — password unchanged)`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
