/**
 * Regenerates TRUNCATED product slugs (e.g. "noorani-qaida-colour-coded-set-jami-sto" for a longer title) from the full
 * product name and remembers the old slug in `previousSlugs`, so old links keep working (the product API and the bot
 * renderer redirect them to the new URL). Only products whose current slug is a strict PREFIX of the slug their title
 * produces are touched; everything else is left alone. IDEMPOTENT (a fixed product is skipped on the next run).
 * DRY-RUN by default.
 *
 *   npm run fix:slugs            # plan only, prints what would change
 *   npm run fix:slugs:apply      # writes - run it only against the database you mean to change
 */
import mongoose from 'mongoose';

const MAX = 100;
function slugifyTitle(title: string): string {
  const base = String(title ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (base.length <= MAX) return base || 'product';
  const cut = base.slice(0, MAX + 1);
  const at = cut.lastIndexOf('-');
  return ((at > 0 ? cut.slice(0, at) : base.slice(0, MAX)).replace(/-+$/g, '')) || 'product';
}
const CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const suffix = () => Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const col = db.collection('products');

  const all = await col.find({}, { projection: { name: 1, slug: 1, previousSlugs: 1 } }).toArray();
  const used = new Set<string>();
  for (const p of all) { if (p.slug) used.add(p.slug); for (const s of p.previousSlugs ?? []) used.add(s); }

  let fixed = 0, skipped = 0;
  for (const p of all) {
    const current: string = p.slug ?? '';
    const expected = slugifyTitle(p.name);
    // Truncated = what is stored is a strict prefix of what the full title produces.
    if (!current || expected === current || !expected.startsWith(current)) { skipped++; continue; }
    let next = expected;
    if (used.has(next)) { do { next = `${expected.slice(0, MAX - 5).replace(/-+$/g, '')}-${suffix()}`; } while (used.has(next)); }
    used.add(next);
    console.log(`${apply ? '~' : '?'} ${p._id}  ${current}  ->  ${next}`);
    if (apply) {
      const previous = [...new Set([...(p.previousSlugs ?? []), current])].filter((s) => s !== next).slice(-20);
      await col.updateOne({ _id: p._id }, { $set: { slug: next, previousSlugs: previous } });
    }
    fixed++;
  }
  console.log(`\n${apply ? 'DONE' : 'DRY RUN - nothing written'}: ${fixed} slug(s) ${apply ? 'regenerated' : 'would be regenerated'}; ${skipped} left untouched.`);
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
