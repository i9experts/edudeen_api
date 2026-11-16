/**
 * READ-ONLY report (dry-run only, there is no --apply): which EXISTING products the new 'needs_review' quality rules
 * would flag the next time their seller saves them. It writes nothing - only find / aggregate on `products`.
 *
 * The rules are the real ones (products/product-quality.util), loaded from the build, so run a build first:
 *
 *   npm run build
 *   npm run report:needs-review
 *
 * Rules: title vs class range mismatch, vague title, title says "course" on a Physical product, exactly 1 image.
 * A product is only flagged when its seller saves it (live products stay live; only Product.flags changes).
 */
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

const SAMPLE = 40;

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }

  // Loaded from the compiled output so the report can never drift from the rules the API runs.
  const req = createRequire(`${process.cwd()}/package.json`);
  let rules: { listingReviewReasons: (i: { title: string; type?: string | null; imageCount?: number | null; classFrom?: string | null; classTo?: string | null }) => string[]; reasonsSignature: (r: string[]) => string };
  try {
    rules = req('./dist/products/product-quality.util.js');
  } catch {
    console.error('dist/products/product-quality.util.js not found - run "npm run build" first.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const products = db.collection('products');

  const match = { isDelete: { $ne: true }, isTest: { $ne: true } };
  const total = await products.countDocuments(match);
  console.log(`Products checked: ${total} (not deleted, not test). Nothing is written.\n`);

  const cursor = products.aggregate([
    { $match: match },
    { $project: { name: 1, type: 1, status: 1, classFrom: 1, classTo: 1, flags: 1, qualityApprovedSig: 1, imageCount: { $size: { $ifNull: ['$images', []] } } } },
  ]);

  const byStatus: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const sample: string[] = [];
  let wouldFlag = 0;
  let alreadyFlagged = 0;
  let live = 0;

  for await (const p of cursor as any) {
    if (Array.isArray(p.flags) && p.flags.includes('needs_review')) alreadyFlagged++;
    const reasons = rules.listingReviewReasons({ title: String(p.name ?? ''), type: p.type, imageCount: p.imageCount, classFrom: p.classFrom ?? null, classTo: p.classTo ?? null });
    if (!reasons.length) continue;
    // An admin-approved set of the same reasons would not be flagged again.
    if (p.qualityApprovedSig && p.qualityApprovedSig === rules.reasonsSignature(reasons)) continue;
    wouldFlag++;
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    if (p.status === 'active' || p.status === 'scheduled') live++;
    for (const r of reasons) {
      const key = r.startsWith('Title says') ? 'title vs class range' : r.includes('vague') ? 'vague title' : r.includes('"course"') ? 'course title on a Physical product' : r.startsWith('Only 1 image') ? 'only 1 image' : 'other';
      byReason[key] = (byReason[key] ?? 0) + 1;
    }
    if (sample.length < SAMPLE) sample.push(`  - ${p._id} [${p.status}] ${p.name}  ->  ${reasons.map((r) => r.slice(0, 60)).join(' | ')}`);
  }

  console.log(`Would be flagged on their next seller save: ${wouldFlag} of ${total}  (already flagged now: ${alreadyFlagged})`);
  console.log(`  of those LIVE (active/scheduled): ${live} - they stay live, only the flag is set.`);
  console.log('\nBy status:');
  for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log('\nBy reason (a product can have several):');
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log(`\nFirst ${sample.length}:`);
  for (const s of sample) console.log(s);

  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
