/**
 * Fills `digital.files[].pageCount` and `digital.pageCount` for existing digital products (PDF files only).
 * ADDITIVE: only sets those two fields, only on files that have no pageCount yet. DRY-RUN by default.
 *
 *   npm run backfill:pdf-pages          # plan only (downloads PDFs to count them, writes nothing)
 *   npm run backfill:pdf-pages:apply    # writes
 *
 * Run it only against the database you mean to change. Needs MONGO_URI and CLOUDINARY_* in the environment.
 */
import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  const util: any = await import(pathToFileURL(path.join(process.cwd(), 'src/products/pdf-page-count.util.ts')).href);

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const col = db.collection('products');

  let products = 0, filesCounted = 0, filesFailed = 0;
  const cursor = col.find({ type: 'digital', 'digital.files.0': { $exists: true } }, { projection: { name: 1, digital: 1 } });
  for await (const p of cursor) {
    const files: any[] = (p as any).digital?.files ?? [];
    let changed = false;
    for (const f of files) {
      if (typeof f.pageCount === 'number' || !util.isPdfName(f.name, f.mimeType)) continue;
      const url = cloudinary.url(f.url, { sign_url: true, secure: true, type: 'private', resource_type: 'raw' });
      const n = await util.fetchPdfPageCount(url);
      if (n === null) { filesFailed++; console.log(`  skip  ${p._id} ${f.name} (could not count)`); continue; }
      f.pageCount = n; changed = true; filesCounted++;
      console.log(`  ${apply ? 'set ' : 'would set'} ${p._id} ${f.name} = ${n} pages`);
      if (apply) await col.updateOne({ _id: p._id }, { $set: { 'digital.files.$[f].pageCount': n } }, { arrayFilters: [{ 'f.url': f.url }] });
    }
    if (!changed) continue;
    products++;
    const total = files.reduce((s, f) => s + (typeof f.pageCount === 'number' ? f.pageCount : 0), 0);
    if (apply && total) await col.updateOne({ _id: p._id }, { $set: { 'digital.pageCount': total } });
  }

  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN (nothing written)'}: ${products} product(s), ${filesCounted} PDF file(s) counted, ${filesFailed} skipped.`);
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
