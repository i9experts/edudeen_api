import { CLASS_VALUES, classIndex } from 'src/products/class-levels';

export interface BrowseComboRow { categoryId?: string | null; subCategoryId?: string | null; classFrom?: string | null; classTo?: string | null; n: number }
export interface BrowseComboCategory { _id: unknown; slug?: string | null; parentId?: unknown }
export interface BrowseCombo { cls: string; slug: string | null; count: number }

/** Hard cap on `/browse/...` URLs in the sitemap (a class x category grid can explode; best-stocked ones first). */
export const BROWSE_SITEMAP_CAP = 2000;

/**
 * Class x category combinations that have at least one product, for the sitemap.
 * Input rows are products grouped by (categoryId, subCategoryId, classFrom, classTo) with a count.
 * A product counts for every class in its range, for its category, its sub-category and every ancestor
 * (the browse page lists descendants). Products without a class range are skipped: the sitemap only lists
 * combinations that are certain to have something (the page itself still shows legacy level-only products).
 * Also returns one class-only entry (`slug: null`) per class that has products.
 */
export function buildBrowseCombos(rows: BrowseComboRow[], categories: BrowseComboCategory[], cap = BROWSE_SITEMAP_CAP): BrowseCombo[] {
  const byId = new Map(categories.map((c) => [String(c._id), c]));
  const ancestorsOrSelf = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let cur = byId.get(id); cur && !seen.has(String(cur._id)); cur = cur.parentId ? byId.get(String(cur.parentId)) : undefined) {
      seen.add(String(cur._id));
      out.push(String(cur._id));
    }
    return out;
  };
  const counts = new Map<string, number>();
  const bump = (key: string, n: number) => counts.set(key, (counts.get(key) ?? 0) + n);
  for (const r of rows) {
    const from = classIndex(r.classFrom ?? r.classTo);
    const to = classIndex(r.classTo ?? r.classFrom);
    if (from < 0 || to < 0 || from > to) continue;
    const cats = new Set<string>();
    for (const id of [r.categoryId, r.subCategoryId]) if (id) for (const a of ancestorsOrSelf(String(id))) cats.add(a);
    for (let i = from; i <= to; i++) {
      const cls = CLASS_VALUES[i];
      bump(`${cls}\n`, r.n);
      for (const id of cats) {
        const slug = byId.get(id)?.slug;
        if (slug) bump(`${cls}\n${String(slug).toLowerCase()}`, r.n);
      }
    }
  }
  const all: BrowseCombo[] = [...counts].map(([k, count]) => {
    const [cls, slug] = k.split('\n');
    return { cls, slug: slug || null, count };
  });
  // Class-only pages first (few, broad), then the best-stocked class x category pages; stable order for equal counts.
  all.sort((a, b) => (a.slug === null ? 0 : 1) - (b.slug === null ? 0 : 1) || b.count - a.count || a.cls.localeCompare(b.cls) || String(a.slug).localeCompare(String(b.slug)));
  return all.slice(0, cap);
}
