import { boundedEditDistance, normalizeSearchText } from '../search/search-terms.util';

export interface LookupStore { id: string; name: string; slug: string; status?: string; email?: string; ownerName?: string }

const words = (s: string) => normalizeSearchText(s).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Lower = better; null = not a match. One query word against one name word. */
function wordScore(q: string, w: string): number | null {
  if (w.startsWith(q)) return 0;
  if (q.length < 3) return null; // 1-2 letters: word start only, no substring/typo guessing
  if (w.includes(q)) return 1;
  const max = q.length >= 6 ? 2 : 1;
  // typo anywhere in the word, or in the part the admin has typed so far
  const full = boundedEditDistance(q, w, max);
  const head = w.length > q.length ? boundedEditDistance(q, w.slice(0, q.length), max) : max + 1;
  const d = Math.min(full, head);
  return d <= max ? 2 + d : null;
}

/** Stores whose name/slug contains the typed letters, or is close to them (wrong spelling). Best first. */
export function lookupStores(stores: LookupStore[], query: string, limit = 10): LookupStore[] {
  const qWords = words(query);
  if (!qWords.length) return [];
  const qJoined = qWords.join('');
  const rawQ = String(query ?? '').trim().toLowerCase();
  const scored: Array<{ s: LookupStore; score: number }> = [];
  for (const s of stores) {
    // The seller's e-mail: typed straight in ("ali.khan@gm") it matches as text; its parts ("ali", "gmail") match as words.
    const email = String(s.email ?? '').toLowerCase();
    if (email && (rawQ.includes('@') || rawQ.length >= 3) && email.includes(rawQ)) {
      scored.push({ s, score: email.startsWith(rawQ) ? 0 : 1 });
      continue;
    }
    const nameWords = [...words(s.name), ...words(s.slug), ...words(s.ownerName ?? ''), ...words(email)];
    if (!nameWords.length) continue;
    let total = 0;
    let ok = true;
    for (const q of qWords) {
      let best: number | null = null;
      for (const w of nameWords) {
        const sc = wordScore(q, w);
        if (sc !== null && (best === null || sc < best)) best = sc;
      }
      if (best === null) { ok = false; break; }
      total += best;
    }
    if (!ok) {
      // "edu deen" typed with a space vs a one-word store name
      const joinedName = words(s.name).join('');
      const sc = qWords.length > 1 ? wordScore(qJoined, joinedName) : null;
      if (sc === null) continue;
      total = sc;
    }
    scored.push({ s, score: total });
  }
  scored.sort((a, b) => a.score - b.score || a.s.name.localeCompare(b.s.name));
  return scored.slice(0, limit).map(x => x.s);
}
