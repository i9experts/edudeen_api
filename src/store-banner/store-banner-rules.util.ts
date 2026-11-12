/* eslint-disable prettier/prettier */

/** A store shows at most this many slides at once (status active or scheduled). Server-enforced. */
export const MAX_ACTIVE_STORE_SLIDES = 4;

/** Statuses that occupy one of the slots. Paused / expired / draft do not. */
export const SLOT_STATUSES = ['active', 'scheduled'] as const;
export const isSlotStatus = (s: unknown): boolean => (SLOT_STATUSES as readonly string[]).includes(s as string);

/** A slide may only point at the seller's OWN product or collection (by id). */
export const SLIDE_LINK_TYPES = ['product', 'collection'] as const;
export type SlideLinkType = (typeof SLIDE_LINK_TYPES)[number];

const HEX24 = /^[a-f0-9]{24}$/i;

export type CleanLink = { linkType: SlideLinkType; linkTarget: string } | null;

/**
 * Shape check only (ownership / liveness is checked against the database by the service).
 * Empty target = no link (null). A target without a product|collection type, or a malformed id = throws via `fail`.
 */
export function cleanSlideLink(linkType: unknown, linkTarget: unknown, fail: (msg: string) => never): CleanLink {
  if (linkTarget === undefined || linkTarget === null || linkTarget === '') return null;
  if (typeof linkTarget !== 'string' || !HEX24.test(linkTarget)) fail('A banner link must be the id of one of your own products or collections');
  if (!(SLIDE_LINK_TYPES as readonly string[]).includes(linkType as string)) fail('A banner can only link to one of your live products or collections');
  return { linkType: linkType as SlideLinkType, linkTarget: linkTarget as string };
}

/** Is the banner at this position among the first MAX slots? `liveIdsOldestFirst` = ids of every slot-holding banner of the store. */
export function holdsSlot(liveIdsOldestFirst: string[], id: string, max = MAX_ACTIVE_STORE_SLIDES): boolean {
  const i = liveIdsOldestFirst.map(String).indexOf(String(id));
  return i !== -1 && i < max;
}

/** Ids from a reorder request: unique, 24-hex, and exactly the store's banner ids (no more, no fewer). */
export function validateReorderIds(ids: unknown, storeBannerIds: string[], fail: (msg: string) => never): string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) fail('ids must be a non-empty list');
  const list = (ids as unknown[]).map(String);
  if (new Set(list).size !== list.length) fail('ids must be unique');
  if (list.some((x) => !HEX24.test(x))) fail('ids must be banner ids');
  const known = new Set(storeBannerIds.map(String));
  if (list.length !== known.size || list.some((x) => !known.has(x))) fail('ids must be exactly this store\'s banners');
  return list;
}
