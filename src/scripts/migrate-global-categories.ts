/* eslint-disable prettier/prettier, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- one-off script over raw Mongo documents */
/**
 * Moves an existing (Pakistan-first) category tree into the global shape in src/categories/global-taxonomy.data.ts.
 * Run `seed:categories:apply` FIRST so the new parents (Languages, "Pakistan Boards & Tests", ...) exist.
 *
 * What it does (DRY-RUN by default: prints the plan and the counts, writes nothing):
 *   1. Renames a main category that still has a former name (e.g. "Social Studies & Pakistan Studies" ->
 *      "Social Studies & Geography"). The slug, i.e. the public URL, never changes.
 *   2. Moves the nodes listed in TAXONOMY_MOVES under their new parent. When a MAIN category becomes a subcategory
 *      (Urdu Language, English Language -> Languages), its products and stores are re-pointed so every product's
 *      subCategoryId stays inside its categoryId:
 *        product { categoryId: Urdu, subCategoryId: null }  -> { categoryId: Languages, subCategoryId: Urdu }
 *        product { categoryId: Urdu, subCategoryId: X }     -> { categoryId: Languages, subCategoryId: X }
 *        store   { categoryId: Urdu }                       -> { categoryId: Languages }
 *   2b. Merges the main categories listed in TAXONOMY_MERGES into another main category (e.g. "Islamic & Educational
 *      Resources" -> "Islamic Studies"): its subcategories move across (a same-named one is merged into the existing one),
 *      its products, stores and pending requests are re-pointed, and the emptied category is soft-deleted. Its old
 *      /marketplace/<slug> page stops resolving.
 *   3. --settings: fills each main category's admin settings (icon, colour, translations, allowed product types,
 *      review rule) from the taxonomy, ONLY where the admin has not set them yet.
 *   4. --reorder: puts the main categories in the taxonomy's order (Islamic groups first); others go after.
 *
 *   node --env-file=.env --experimental-strip-types src/scripts/migrate-global-categories.ts [--settings] [--reorder]           # plan
 *   node --env-file=.env --experimental-strip-types src/scripts/migrate-global-categories.ts [--settings] [--reorder] --apply   # write
 *
 * Idempotent: a second run finds nothing left to do. Take a database backup before --apply on production.
 * The API caches the public tree for up to 60 s per instance; restart or wait after applying.
 */
import mongoose from 'mongoose';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_DEPTH = 4; // MAX_CATEGORY_DEPTH in category-tree.util.ts
const key = (s: string) => String(s ?? '').trim().toLowerCase();

async function run() {
  const apply = process.argv.includes('--apply');
  const doSettings = process.argv.includes('--settings');
  const doReorder = process.argv.includes('--reorder');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  const { GLOBAL_TAXONOMY, TAXONOMY_MOVES, TAXONOMY_MERGES } = await import(pathToFileURL(path.join(process.cwd(), 'src/categories/global-taxonomy.data.ts')).href);
  const { planCategoryMerge } = await import(pathToFileURL(path.join(process.cwd(), 'src/categories/category-merge.plan.ts')).href);

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const cats = db.collection('categories');
  const products = db.collection('products');
  const stores = db.collection('stores');
  const requests = db.collection('category_requests');

  const load = async () => (await cats.find({ isDelete: { $ne: true } }).toArray()) as any[];
  let rows = await load();
  const byId = () => new Map<string, any>(rows.map((r) => [String(r._id), r]));
  const roots = () => rows.filter((r) => !r.parentId);
  const childOf = (parentId: string, name: string) => rows.find((r) => String(r.parentId ?? '') === parentId && key(r.name) === key(name));
  const rootNamed = (name: string) => roots().find((r) => key(r.name) === key(name));
  const depthOf = (id: string) => { const m = byId(); let d = 0; let cur = m.get(id); while (cur && d < 10) { d++; cur = cur.parentId ? m.get(String(cur.parentId)) : null; } return d; };
  const heightBelow = (id: string): number => { const kids = rows.filter((r) => String(r.parentId ?? '') === id); return kids.length ? 1 + Math.max(...kids.map((k) => heightBelow(String(k._id)))) : 0; };
  const resolvePath = (names: string[]) => { let cur = rootNamed(names[0]); for (const n of names.slice(1)) cur = cur ? childOf(String(cur._id), n) : undefined; return cur; };
  const now = new Date();
  let changes = 0;
  const say = (s: string) => console.log(s);

  // 1. Renames
  say('\n1. Renames');
  for (const node of GLOBAL_TAXONOMY) {
    for (const old of node.formerNames ?? []) {
      const r = rootNamed(old);
      if (!r) continue;
      if (rootNamed(node.name)) { say(`   ! "${old}" not renamed: a main category "${node.name}" already exists. Merge them by hand (delete one with ?reassignTo=).`); continue; }
      say(`   ~ "${r.name}" -> "${node.name}" (slug stays "${r.slug}")`);
      changes++;
      if (apply) await cats.updateOne({ _id: r._id }, { $set: { name: node.name, updatedAt: now } });
    }
  }
  if (apply) rows = await load();

  // 2. Moves
  say('\n2. Moves');
  for (const mv of TAXONOMY_MOVES) {
    const node = mv.from === null ? rootNamed(mv.name) : (() => { const p = rootNamed(mv.from); return p ? childOf(String(p._id), mv.name) : undefined; })();
    const target = resolvePath(mv.to);
    if (!node) { const already = resolvePath([...mv.to, mv.name]); say(already ? `   = ${mv.name}: already under ${mv.to.join(' > ')}` : `   - ${mv.name}: not found at its old place, skipped`); continue; }
    if (!target) { say(`   ! ${mv.name}: target ${mv.to.join(' > ')} does not exist. Run seed:categories:apply first.`); continue; }
    const nodeId = String(node._id); const targetId = String(target._id);
    if (childOf(targetId, mv.name) && String(childOf(targetId, mv.name)._id) !== nodeId) { say(`   ! ${mv.name}: ${mv.to.join(' > ')} already has a "${mv.name}". Merge them by hand.`); continue; }
    if (depthOf(targetId) + 1 + heightBelow(nodeId) > MAX_DEPTH) { say(`   ! ${mv.name}: moving it would nest deeper than ${MAX_DEPTH} levels, skipped`); continue; }
    const targetRoot = String(resolvePath([mv.to[0]])._id);

    if (!node.parentId) {
      // A main category becomes a subcategory: re-point its products and stores.
      const [pNoSub, pWithSub, st, rq] = await Promise.all([
        products.countDocuments({ categoryId: nodeId, $or: [{ subCategoryId: null }, { subCategoryId: { $exists: false } }] }),
        products.countDocuments({ categoryId: nodeId, subCategoryId: { $nin: [null] } }),
        stores.countDocuments({ categoryId: nodeId }),
        requests.countDocuments({ mainCategoryId: nodeId, status: 'pending' }),
      ]);
      say(`   > ${mv.name} (main) -> ${mv.to.join(' > ')}: ${pNoSub + pWithSub} product(s), ${st} store(s), ${rq} pending request(s) re-pointed`);
      changes++;
      if (apply) {
        await products.updateMany({ categoryId: nodeId, $or: [{ subCategoryId: null }, { subCategoryId: { $exists: false } }] }, { $set: { categoryId: targetRoot, subCategoryId: nodeId } });
        await products.updateMany({ categoryId: nodeId }, { $set: { categoryId: targetRoot } });
        await stores.updateMany({ categoryId: nodeId }, { $set: { categoryId: targetRoot } });
        await requests.updateMany({ mainCategoryId: nodeId, status: 'pending' }, { $set: { mainCategoryId: targetRoot } });
        await cats.updateOne({ _id: node._id }, { $set: { parentId: targetId, sortOrder: 0, updatedAt: now } });
      }
    } else {
      // Inside the same main category: only the parent changes (products keep their categoryId).
      const m = byId(); let r = node; while (r?.parentId) r = m.get(String(r.parentId));
      if (String(r?._id) !== targetRoot) { say(`   ! ${mv.name}: would leave its main category, skipped`); continue; }
      if (String(node.parentId) === targetId) { say(`   = ${mv.name}: already under ${mv.to.join(' > ')}`); continue; }
      say(`   > ${mv.name} -> ${mv.to.join(' > ')}`);
      changes++;
      if (apply) await cats.updateOne({ _id: node._id }, { $set: { parentId: targetId, updatedAt: now } });
    }
  }
  if (apply) rows = await load();

  // 2b. Merges (main category into main category)
  say('\n2b. Merges');
  for (const mg of TAXONOMY_MERGES) {
    const from = rootNamed(mg.from);
    const into = rootNamed(mg.into);
    if (!from) { say(`   = "${mg.from}": not found (already merged?)`); continue; }
    if (!into) { say(`   ! "${mg.from}": target main category "${mg.into}" does not exist, skipped`); continue; }
    const fromId = String(from._id); const intoId = String(into._id);
    const plan = planCategoryMerge(rows, fromId, intoId);
    const [pRoot, st, rq] = await Promise.all([
      products.countDocuments({ categoryId: fromId }),
      stores.countDocuments({ categoryId: fromId }),
      requests.countDocuments({ mainCategoryId: fromId, status: 'pending' }),
    ]);
    say(`   > "${from.name}" -> "${into.name}": ${pRoot} product(s), ${st} store(s), ${rq} pending request(s) re-pointed; slug "${from.slug}" retired`);
    for (const m of plan.moves) say(`       move  ${m.name}`);
    for (const r of plan.remaps.slice(1)) {
      const n = await products.countDocuments({ subCategoryId: r.from });
      say(`       merge ${r.name} into the existing one (${n} product(s))`);
    }
    changes++;
    if (!apply) continue;
    for (const m of plan.moves) await cats.updateOne({ _id: rows.find((r) => String(r._id) === m.id)._id }, { $set: { parentId: m.newParentId, updatedAt: now } });
    for (const r of plan.remaps.slice(1)) await products.updateMany({ subCategoryId: r.from }, { $set: { subCategoryId: r.to } });
    // A product filed directly on the old main category keeps "no subcategory" under the new one.
    await products.updateMany({ subCategoryId: fromId }, { $set: { subCategoryId: null } });
    await products.updateMany({ categoryId: fromId }, { $set: { categoryId: intoId } });
    await stores.updateMany({ categoryId: fromId }, { $set: { categoryId: intoId } });
    await requests.updateMany({ mainCategoryId: fromId, status: 'pending' }, { $set: { mainCategoryId: intoId } });
    const delIds = rows.filter((r) => plan.deletes.includes(String(r._id))).map((r) => r._id);
    await cats.updateMany({ _id: { $in: delIds } }, { $set: { isDelete: true, status: 'inactive', updatedAt: now } });
  }
  if (apply) rows = await load();

  // 3. Settings (only where unset)
  if (doSettings) {
    say('\n3. Settings (only where not set yet)');
    for (const node of GLOBAL_TAXONOMY) {
      const r = rootNamed(node.name);
      if (!r) continue;
      const set: any = {};
      if (node.icon && !r.icon) set.icon = node.icon;
      if (node.color && !r.color) set.color = node.color;
      if (node.nameTranslations && !Object.keys(r.nameTranslations ?? {}).length) set.nameTranslations = node.nameTranslations;
      if (node.allowedProductTypes?.length && !(r.allowedProductTypes ?? []).length) set.allowedProductTypes = node.allowedProductTypes;
      if (node.requiresListingReview && r.requiresListingReview !== true) set.requiresListingReview = true;
      if (!Object.keys(set).length) continue;
      say(`   * ${node.name}: ${Object.keys(set).join(', ')}`);
      if (set.allowedProductTypes) {
        const kinds: string[] = set.allowedProductTypes;
        const or: any[] = [];
        if (!kinds.includes('physical')) or.push({ type: 'physical' });
        if (!kinds.includes('digital')) or.push({ type: { $ne: 'physical' }, deliveryFormat: { $ne: 'course' } });
        if (!kinds.includes('course')) or.push({ type: { $ne: 'physical' }, deliveryFormat: 'course' });
        const clash = or.length ? await products.countDocuments({ categoryId: String(r._id), isDelete: { $ne: true }, $or: or }) : 0;
        if (clash) say(`     note: ${clash} existing product(s) here are of another kind. They stay listed; the rule applies when they change category or format.`);
      }
      changes++;
      if (apply) await cats.updateOne({ _id: r._id }, { $set: { ...set, updatedAt: now } });
    }
  }

  // 4. Order of main categories
  if (doReorder) {
    say('\n4. Main category order');
    const order = GLOBAL_TAXONOMY.map((n: any) => key(n.name));
    const sorted = [...roots()].sort((a, b) => {
      const ia = order.indexOf(key(a.name)); const ib = order.indexOf(key(b.name));
      return (ia < 0 ? 1e6 + (Number(a.sortOrder) || 0) : ia) - (ib < 0 ? 1e6 + (Number(b.sortOrder) || 0) : ib);
    });
    for (const [i, r] of sorted.entries()) {
      if (Number(r.sortOrder) === i) continue;
      say(`   ${String(i).padStart(2)}. ${r.name}`);
      changes++;
      if (apply) await cats.updateOne({ _id: r._id }, { $set: { sortOrder: i, updatedAt: now } });
    }
  }

  say(`\n${apply ? 'DONE' : 'DRY RUN - nothing written'}: ${changes} change(s) ${apply ? 'applied' : 'planned'}.`);
  if (!apply && changes) say('Re-run with --apply to write them (take a backup first).');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
