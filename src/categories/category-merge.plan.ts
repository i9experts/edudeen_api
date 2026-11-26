/* eslint-disable prettier/prettier */
/**
 * Pure planner for folding one category (and everything below it) into another, e.g. the main category
 * "Islamic & Educational Resources" into "Islamic Studies". No database access: the migration script loads the
 * rows, calls planCategoryMerge, then applies the plan. Self-contained (no imports) so the script can load it with
 * `node --experimental-strip-types`.
 *
 * Rules:
 * - A child of `from` whose name (case-insensitive) is not under `into` is MOVED under `into`, with its subtree.
 * - A child whose name already exists under `into` is MERGED into that one, recursively: its products are re-pointed
 *   to the existing node, its own children are handled the same way, and it is then soft-deleted.
 * - `from` itself is soft-deleted; products / stores / requests that pointed at it are re-pointed to `into`.
 */
type IdLike = string | { toString(): string };
export interface MergeRow { _id: IdLike; name: string; parentId?: IdLike | null }

export interface MergePlan {
  /** Categories that get a new parent (keep their id, slug and products). */
  moves: { id: string; name: string; newParentId: string }[];
  /** Every product/store/request reference `from` -> `to` (category ids). Includes the root pair. */
  remaps: { from: string; to: string; name: string }[];
  /** Categories to soft-delete after the remaps (the root `from` and every merged duplicate). */
  deletes: string[];
}

const k = (s: string) => String(s ?? '').trim().toLowerCase();

export function planCategoryMerge(rows: MergeRow[], fromId: string, intoId: string): MergePlan {
  const plan: MergePlan = { moves: [], remaps: [], deletes: [] };
  const childrenOf = (id: string) => rows.filter((r) => String(r.parentId ?? '') === id);
  const fromRow = rows.find((r) => String(r._id) === fromId);
  if (!fromRow || !rows.some((r) => String(r._id) === intoId) || fromId === intoId) return plan;

  // Guard: `into` must not be inside `from` (that would move a node under its own descendant).
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  for (let cur = byId.get(intoId), i = 0; cur && i < 20; cur = cur.parentId ? byId.get(String(cur.parentId)) : undefined, i++) {
    if (String(cur._id) === fromId) return plan;
  }

  const merge = (src: string, dst: string, name: string) => {
    plan.remaps.push({ from: src, to: dst, name });
    plan.deletes.push(src);
    const existing = childrenOf(dst);
    for (const child of childrenOf(src)) {
      const twin = existing.find((e) => k(e.name) === k(child.name));
      if (twin) merge(String(child._id), String(twin._id), child.name);
      else plan.moves.push({ id: String(child._id), name: child.name, newParentId: dst });
    }
  };
  merge(fromId, intoId, fromRow.name);
  return plan;
}
