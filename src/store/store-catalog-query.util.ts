import { CLASS_LEVELS, canonicalClass, classFilter, productCoversClass } from 'src/products/class-levels';
import { queryString } from 'src/products/product-public-view.util';
import { searchTerm } from 'src/common/query-safety.util';

export const CATALOG_SORTS = ['newest', 'price_asc', 'price_desc', 'best_rated'] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export interface CatalogParams {
  q?: string;
  /** Mongo clause for the class filter, null when no class was asked for. */
  classClause: Record<string, any> | null;
  subject?: string;
  min?: number;
  max?: number;
  sort: CatalogSort;
}

function price(value: unknown, name: string, bad: (m: string) => Error): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) throw bad(`${name} must be a non-negative number`);
  return n;
}

/** Validates the buyer-facing in-store catalog params; anything malformed is a 400, never silently ignored. */
export function parseCatalogParams(query: Record<string, any>, bad: (m: string) => Error, isId: (v: string) => boolean): CatalogParams {
  const rawSort = queryString(query.sort);
  if (rawSort && !(CATALOG_SORTS as readonly string[]).includes(rawSort)) {
    throw bad(`sort must be one of: ${CATALOG_SORTS.join(', ')}`);
  }

  const rawClass = queryString(query.class);
  let classClause: Record<string, any> | null = null;
  if (rawClass) {
    const cls = canonicalClass(rawClass);
    classClause = cls ? classFilter(cls) : null;
    if (!classClause) throw bad('class is not a known class level');
  }

  const rawSubject = queryString(query.subject);
  if (rawSubject && rawSubject !== 'all' && !isId(rawSubject)) throw bad('subject must be a category id');

  const min = price(query.min, 'min', bad);
  const max = price(query.max, 'max', bad);
  if (min !== undefined && max !== undefined && min > max) throw bad('min must not be greater than max');

  return {
    // `search` is the older name the storefront search page already sends.
    q: searchTerm(query.q ?? query.search, 100),
    classClause,
    subject: rawSubject && rawSubject !== 'all' ? rawSubject : undefined,
    min,
    max,
    sort: (rawSort as CatalogSort) || 'newest',
  };
}

interface ClassGroup {
  _id: { classFrom?: string | null; classTo?: string | null; educationLevel?: string | null; normalizedCustomLevel?: string | null };
  count: number;
}

/** Per-class product counts (a range product counts for every class it covers); classes with 0 are left out. */
export function classFacetCounts(groups: ClassGroup[]): { value: string; label: string; count: number }[] {
  const out: { value: string; label: string; count: number }[] = [];
  for (const c of CLASS_LEVELS) {
    let count = 0;
    for (const g of groups) if (productCoversClass(g._id ?? {}, c.value)) count += g.count;
    if (count > 0) out.push({ value: c.value, label: c.label, count });
  }
  return out;
}
