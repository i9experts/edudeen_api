/**
 * Renames the main category 'Courses & Live Classes' to 'Online Courses'.
 * The SLUG is kept as it is, so every existing /?category=<slug> link keeps working and no redirect is needed.
 * Only the display name changes. DRY-RUN by default (prints what would change); add --apply to write.
 *
 *   npm run rename:courses-category           (dry-run)
 *   npm run rename:courses-category:apply     (writes - live DB only with the owner's approval)
 */
import mongoose from 'mongoose';

const NEW_NAME = 'Online Courses';

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const cats = db.collection('categories');

  const mains = await cats.find({
    name: { $regex: '^courses\\s*(&|and)\\s*live\\s*classes$', $options: 'i' },
    isDelete: { $ne: true },
  }).toArray();
  if (!mains.length) { console.log('No "Courses & Live Classes" category found. Nothing to do.'); await mongoose.disconnect(); return; }

  for (const c of mains) {
    const clash = await cats.countDocuments({ _id: { $ne: c._id }, parentId: c.parentId ?? null, isDelete: { $ne: true }, name: { $regex: `^${NEW_NAME}$`, $options: 'i' } });
    if (clash) { console.log(`SKIP ${c._id}: a sibling named "${NEW_NAME}" already exists.`); continue; }
    console.log(`${apply ? 'RENAME' : 'WOULD RENAME'} ${c._id}: "${c.name}" -> "${NEW_NAME}" (slug stays "${c.slug}")`);
    if (apply) await cats.updateOne({ _id: c._id }, { $set: { name: NEW_NAME, updatedAt: new Date() } });
  }
  if (!apply) console.log('\nDry run only. Nothing was written.');
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
