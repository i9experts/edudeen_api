/* eslint-disable prettier/prettier */
/**
 * Adds Edudeen Academy starter courses as DRAFTS (an admin reviews and publishes them in Admin -> Edudeen Academy).
 * Idempotent: a course whose slug already exists is left untouched. DRY-RUN by default.
 *
 *   node --env-file=.env --experimental-strip-types src/scripts/seed-academy-courses.ts            # plan only
 *   node --env-file=.env --experimental-strip-types src/scripts/seed-academy-courses.ts --apply    # writes
 *
 * (npm run seed:academy / seed:academy:apply). Run it only against the database you mean to change.
 */
import mongoose from 'mongoose';

type Lesson = { title: string; type: 'text'; body: string; durationMinutes: number };
type Course = { slug: string; title: string; summary: string; category: string; isRecommended: boolean; order: number; lessons: Lesson[] };

const COURSES: Course[] = [
  {
    slug: 'getting-started-selling-on-edudeen',
    title: 'Getting started selling on Edudeen',
    summary: 'Set up your store, understand your dashboard and get your first product live.',
    category: 'getting_started', isRecommended: true, order: 1,
    lessons: [
      { title: 'How Edudeen works', type: 'text', durationMinutes: 4, body:
`Edudeen is a marketplace for educational products: books, learning toys, digital downloads and courses.

## What you do
- Open a store and list your products
- Pack and ship orders on time (or deliver digital files automatically)
- Answer buyer questions and reviews

## What Edudeen does
- Brings buyers to the marketplace
- Takes payment from buyers
- Pays your earnings to your verified payout account` },
      { title: 'Set up your store', type: 'text', durationMinutes: 6, body:
`Go to Store Settings and complete every section.

## Checklist
- Store name, logo and a wide banner (4:1)
- Up to 3 categories that match what you sell
- Product types: physical products, digital downloads, or both
- Return policy and shipping times
- Contact phone and business address

A complete store looks more trustworthy and ranks better in search.` },
      { title: 'Your dashboard', type: 'text', durationMinutes: 4, body:
`The Dashboard shows what needs your attention today.

- Action required: orders to ship, returns and unread messages
- Store Health: what to fix to sell more
- Analytics: visits, sales and best-selling products

Check it at least once a day.` },
    ],
  },
  {
    slug: 'product-photos-and-listings',
    title: 'Product photos & listings that sell',
    summary: 'Write clear titles, take good photos and choose the right category.',
    category: 'products_listings', isRecommended: true, order: 2,
    lessons: [
      { title: 'Titles and descriptions', type: 'text', durationMinutes: 5, body:
`Buyers search with simple words. Put them in your title.

## A good title
- Product name, then the key detail: age, grade, subject or size
- Example: "Urdu Qaida for Kids, Ages 4-6, Full Colour"

## A good description
- What it is and who it is for
- What is included (pages, pieces, file format)
- Size, material or edition

Never copy another seller's text or photos.` },
      { title: 'Photos', type: 'text', durationMinutes: 5, body:
`## Do
- Use daylight or a bright lamp and a plain background
- Show the front cover first, then inside pages and details
- Add at least 3 photos

## Photo display
In the Photos step choose how photos show in tiles:
- Fill the tile: best for portrait covers
- Show whole photo: best for landscape or square photos such as open page spreads` },
      { title: 'Categories and prices', type: 'text', durationMinutes: 4, body:
`Pick the most specific category so buyers find you when they browse.

- Check similar products before setting your price
- Keep stock up to date so buyers never order something you don't have
- Use sales and coupons from Marketing instead of changing the base price often` },
    ],
  },
  {
    slug: 'orders-shipping-and-returns',
    title: 'Orders, shipping & returns',
    summary: 'Handle orders on time, ship safely and deal with returns fairly.',
    category: 'shipping', isRecommended: false, order: 3,
    lessons: [
      { title: 'Processing an order', type: 'text', durationMinutes: 5, body:
`When an order arrives:

1. Confirm it from Orders
2. Pack it well: books in a stiff envelope or box, fragile items with padding
3. Add the courier and tracking number
4. Mark it shipped

Late shipping and cancellations lower your store rating.` },
      { title: 'Returns and refunds', type: 'text', durationMinutes: 4, body:
`Buyers can request a return within your return policy window.

- Reply to every return request quickly
- Approve returns for damaged, wrong or missing items
- Refunds are deducted from your balance

Clear photos and accurate descriptions prevent most returns.` },
      { title: 'Reviews and questions', type: 'text', durationMinutes: 3, body:
`Answer product questions quickly, buyers often wait for a reply before ordering.

Reply politely to every review, especially negative ones. Explain what you will do better. Never ask buyers to change a review in exchange for anything.` },
    ],
  },
  {
    slug: 'getting-paid-and-kyc',
    title: 'Getting paid & identity verification (KYC)',
    summary: 'Verify your identity, add a payout account and understand when you get paid.',
    category: 'payments_finance', isRecommended: true, order: 4,
    lessons: [
      { title: 'Why we verify sellers', type: 'text', durationMinutes: 3, body:
`To protect buyers and honest sellers from fraud, Edudeen verifies every seller's identity (KYC) before paying out money.

You can open your store and start selling right away. Withdrawals are released only after your identity verification is approved.` },
      { title: 'Submitting your KYC', type: 'text', durationMinutes: 5, body:
`## You will need
- A government ID (CNIC, national ID or passport), front and back
- Your ID number and national tax number (if you have one)
- Your business address

## Tips
- Upload clear, uncropped photos, all four corners visible
- The name must match your ID exactly
- If something is rejected you'll see the reason and can resubmit.` },
      { title: 'Payout accounts and schedule', type: 'text', durationMinutes: 4, body:
`Add a bank account or mobile wallet in Earnings.

- The account title must match the name on your ID
- Earnings become available after the order is delivered and the return window has passed
- See every sale, fee and payout in Earnings` },
    ],
  },
];

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const col = db.collection('academy_courses');

  for (const c of COURSES) {
    if (await col.findOne({ slug: c.slug })) { console.log(`skip   ${c.slug} (exists)`); continue; }
    console.log(`${apply ? 'add   ' : 'would add'} ${c.slug} (${c.lessons.length} lessons, draft)`);
    if (!apply) continue;
    const now = new Date();
    await col.insertOne({
      ...c,
      coverImage: null, countries: [], language: 'en', status: 'draft', viewCount: 0, publishedAt: null, createdBy: null,
      lessons: c.lessons.map(l => ({ _id: new mongoose.Types.ObjectId(), videoUrl: null, fileUrl: null, ...l })),
      createdAt: now, updatedAt: now,
    });
  }
  if (!apply) console.log('\nDry run. Re-run with --apply to write.');
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
