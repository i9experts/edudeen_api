/* eslint-disable prettier/prettier */
// One rule for what counts as "the same collection name": lowercase, then drop everything that is not a letter or
// digit (spaces, punctuation, symbols). "Hurry Up !" and "hurry-up" and "HURRY UP" all normalise to "hurryup".
// Unicode letters (Urdu etc.) are kept. scripts/report-collection-duplicates.ts keeps a copy of this function
// (the script runs without the TS build) - keep both in sync.
export const COLLECTION_NAME_MIN = 2;
export const COLLECTION_NAME_MAX = 40;
export const MAX_COLLECTIONS_PER_STORE = 20;

export function cleanCollectionName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
}

export function normalizeCollectionName(name: unknown): string {
  return cleanCollectionName(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
