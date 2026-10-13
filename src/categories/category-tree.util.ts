/* eslint-disable prettier/prettier */
/** Shared helpers for the (up to 4 level) category tree: main > sub > sub-sub > sub-sub-sub. */
export const MAX_CATEGORY_DEPTH = 4;

/** Minimal shape of the mongoose category model these helpers need. */
interface CategoryModelLike {
  find(filter: any, projection?: any): { lean(): Promise<any[]> } | any;
}

interface ParentMap { at: number; parents: Map<string, string | null>; children: Map<string, string[]> }
const TTL_MS = 15_000;
let cache: ParentMap | null = null;
let inflight: Promise<ParentMap> | null = null;

/** Call after any create / delete / move so descendant lookups never serve a stale tree in this process. */
export function invalidateCategoryTreeCache(): void {
  cache = null;
}

/** One lightweight query (id + parentId of every non-deleted category), cached for a few seconds. */
async function loadMaps(model: CategoryModelLike): Promise<ParentMap> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  if (!inflight) {
    inflight = (async () => {
      const rows: any[] = await model.find({ isDelete: false }, { parentId: 1 }).lean();
      const parents = new Map<string, string | null>();
      const children = new Map<string, string[]>();
      for (const r of rows) {
        const id = String(r._id);
        const pid = r.parentId ? String(r.parentId) : null;
        parents.set(id, pid);
        if (pid) {
          const list = children.get(pid);
          if (list) list.push(id); else children.set(pid, [id]);
        }
      }
      cache = { at: Date.now(), parents, children };
      return cache;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

/** `id` plus every non-deleted descendant id at any depth (cycle-safe, capped at MAX_CATEGORY_DEPTH levels). */
export async function getDescendantIds(model: CategoryModelLike, id: string): Promise<string[]> {
  const { children } = await loadMaps(model);
  const out: string[] = [id];
  const seen = new Set<string>([id]);
  let frontier = [id];
  for (let depth = 1; depth < MAX_CATEGORY_DEPTH + 1 && frontier.length; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const c of children.get(f) ?? []) {
        if (seen.has(c)) continue;
        seen.add(c);
        out.push(c);
        next.push(c);
      }
    }
    frontier = next;
  }
  return out;
}

/** Ids from `id` up to its root (inclusive of both). Empty when `id` is unknown. */
export async function getAncestorChain(model: CategoryModelLike, id: string): Promise<string[]> {
  const { parents } = await loadMaps(model);
  const chain: string[] = [];
  let cur: string | null | undefined = id;
  while (cur && parents.has(cur) && !chain.includes(cur) && chain.length <= MAX_CATEGORY_DEPTH + 1) {
    chain.push(cur);
    cur = parents.get(cur);
  }
  return chain;
}

/** Number of levels in a node's subtree below it (0 = leaf), used to stop a move/add from exceeding the limit. */
export async function getSubtreeHeight(model: CategoryModelLike, id: string): Promise<number> {
  const { children } = await loadMaps(model);
  const walk = (n: string, d: number): number => {
    if (d > MAX_CATEGORY_DEPTH) return 0;
    let h = 0;
    for (const c of children.get(n) ?? []) h = Math.max(h, 1 + walk(c, d + 1));
    return h;
  };
  return walk(id, 0);
}

/** Pure: nest flat rows (already sorted) into a tree. Orphans (parent missing) are dropped. */
export function nestCategories<T extends { _id: any; parentId?: any }>(rows: T[]): (T & { children: any[] })[] {
  const nodes = new Map<string, any>();
  for (const r of rows) nodes.set(String(r._id), { ...r, children: [] });
  const roots: any[] = [];
  for (const n of nodes.values()) {
    if (n.parentId) nodes.get(String(n.parentId))?.children.push(n);
    else roots.push(n);
  }
  return roots;
}
