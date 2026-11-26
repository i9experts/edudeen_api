/* eslint-disable prettier/prettier, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- one-off script over raw Mongo documents */
/**
 * Adds Edudeen's default GLOBAL category tree (src/categories/global-taxonomy.data.ts).
 * ADDITIVE and idempotent: a category that already exists is left exactly as it is; nothing is edited, renamed,
 * reordered, moved or deleted. A node is "already there" when a category with its name (or a former name) exists
 * under the same parent, OR anywhere inside the same main category, OR as a main category (an older location that
 * `migrate-global-categories` moves into place). DRY-RUN by default.
 *
 *   node --env-file=.env --experimental-strip-types src/scripts/seed-education-categories.ts            # plan only
 *   node --env-file=.env --experimental-strip-types src/scripts/seed-education-categories.ts --apply    # writes
 *
 * (npm run seed:categories / seed:categories:apply). Run it only against the database you mean to change.
 * Then run `npm run migrate:global-categories` (dry run first) to move the older nodes into the new shape.
 */
import mongoose from 'mongoose';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const slugify = (s: string) =>
  s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9؀-ۿ]+/g, '-').replace(/^-+|-+$/g, '') || 'category';
const key = (s: string) => s.trim().toLowerCase();

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  const { GLOBAL_TAXONOMY } = await import(pathToFileURL(path.join(process.cwd(), 'src/categories/global-taxonomy.data.ts')).href);

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const col = db.collection('categories');

  // Whole tree in memory (a few hundred rows at most).
  const rows: any[] = await col.find({ isDelete: { $ne: true } }, { projection: { name: 1, parentId: 1, slug: 1, sortOrder: 1 } }).toArray();
  const byId = new Map<string, any>(rows.map((r) => [String(r._id), r]));
  const rootOf = (id: string): string => {
    let cur = byId.get(id); let guard = 0;
    while (cur?.parentId && byId.has(String(cur.parentId)) && guard++ < 10) cur = byId.get(String(cur.parentId));
    return cur ? String(cur._id) : id;
  };
  const usedSlugs = new Set<string>((await col.find({}, { projection: { slug: 1 } }).toArray()).map((c: any) => c.slug).filter(Boolean));
  const uniqueSlug = (name: string, parentSlug?: string) => {
    const base = slugify(name);
    let slug = base;
    if (usedSlugs.has(slug) && parentSlug) slug = `${parentSlug}-${base}`;
    for (let i = 2; usedSlugs.has(slug); i++) slug = `${base}-${i}`;
    usedSlugs.add(slug);
    return slug;
  };

  const names = (n: any) => [n.name, ...(n.formerNames ?? [])].map(key);
  const findExisting = (node: any, parentId: string | null, rootId: string | null): { row: any; where: string } | null => {
    const wanted = names(node);
    const hit = (pred: (r: any) => boolean) => rows.find((r) => wanted.includes(key(r.name)) && pred(r));
    if (parentId === null) {
      const r = hit((r) => !r.parentId);
      return r ? { row: r, where: 'here' } : null;
    }
    const here = hit((r) => String(r.parentId ?? '') === parentId);
    if (here) return { row: here, where: 'here' };
    if (rootId && !rootId.startsWith('dry:')) {
      const inRoot = hit((r) => r.parentId && rootOf(String(r._id)) === rootId);
      if (inRoot) return { row: inRoot, where: 'elsewhere in the same main category' };
    }
    const asRoot = hit((r) => !r.parentId);
    if (asRoot) return { row: asRoot, where: 'as a main category' };
    return null;
  };

  let created = 0, existed = 0, elsewhere = 0;
  const now = new Date();
  const maxSort = rows.filter((r) => !r.parentId).reduce((m, r) => Math.max(m, Number(r.sortOrder) || 0), -1);
  let rootSort = maxSort + 1;

  const visit = async (node: any, parent: { id: string; slug: string } | null, rootId: string | null, depth: number, sortOrder: number) => {
    const indent = '    '.repeat(depth);
    const found = parent?.id.startsWith('dry:') ? null : findExisting(node, parent ? parent.id : null, rootId);
    let me: { id: string; slug: string };
    if (found) {
      existed++;
      if (found.where !== 'here') {
        elsewhere++;
        console.log(`${indent}= ${node.name}  (exists ${found.where}; run migrate:global-categories to move it)`);
      }
      me = { id: String(found.row._id), slug: found.row.slug };
    } else {
      created++;
      const doc: any = {
        name: node.name, slug: uniqueSlug(node.name, parent?.slug), parentId: parent ? parent.id : null, image: null,
        description: node.description ?? null, sortOrder: parent ? sortOrder : rootSort++, status: 'active', isDelete: false,
        icon: node.icon ?? null, color: node.color ?? null, nameTranslations: node.nameTranslations ?? {},
        allowedProductTypes: node.allowedProductTypes ?? [], requiresListingReview: node.requiresListingReview === true,
        createdBy: null, createdByRole: 'admin', seo: {}, createdAt: now, updatedAt: now,
      };
      console.log(`${indent}+ ${node.name}`);
      if (apply) {
        const r = await col.insertOne(doc);
        const row = { ...doc, _id: r.insertedId };
        rows.push(row); byId.set(String(r.insertedId), row);
        me = { id: String(r.insertedId), slug: doc.slug };
      } else me = { id: `dry:${node.name}`, slug: doc.slug };
    }
    const myRoot = parent ? rootId : me.id;
    let i = 0;
    for (const sub of node.subs ?? []) await visit(sub, me, myRoot, depth + 1, i++);
  };

  for (const main of GLOBAL_TAXONOMY) await visit(main, null, null, 0, 0);

  console.log(`\n${apply ? 'DONE' : 'DRY RUN - nothing written'}: ${created} categories ${apply ? 'created' : 'would be created'}; ${existed} already existed (left untouched${elsewhere ? `, ${elsewhere} of them in an older place` : ''}).`);
  if (!apply) console.log('Re-run with --apply to write them.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
