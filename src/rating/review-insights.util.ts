/* eslint-disable prettier/prettier */
/** Pure review helpers (no database, no AI): star percentages that add up to exactly 100, and keyword themes. */

export const CUSTOMERS_SAY_MIN_REVIEWS = 5;

/** Largest-remainder rounding: whole percents per star that always sum to 100 (all zeros when there are no reviews). */
export function starPercentages(breakdown: Record<string, number>): Record<string, number> {
  const stars = ['5', '4', '3', '2', '1'];
  const total = stars.reduce((s, k) => s + Math.max(0, breakdown[k] ?? 0), 0);
  const out: Record<string, number> = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
  if (total <= 0) return out;
  const parts = stars.map((k) => {
    const exact = (Math.max(0, breakdown[k] ?? 0) / total) * 100;
    return { k, floor: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = 100 - parts.reduce((s, p) => s + p.floor, 0);
  for (const p of [...parts].sort((a, b) => b.rem - a.rem || Number(b.k) - Number(a.k))) {
    if (left <= 0) break;
    p.floor += 1; left -= 1;
  }
  for (const p of parts) out[p.k] = p.floor;
  return out;
}

/** Themes buyers mention. Fixed word lists on purpose (cheap, predictable, no AI). */
const THEMES: { key: string; label: string; words: RegExp }[] = [
  { key: 'clear', label: 'Clear explanations', words: /\b(clear|easy to (follow|understand)|well explained|simple)\b/i },
  { key: 'practice', label: 'Good practice questions', words: /\b(practice|exercises?|worksheets?|questions?)\b/i },
  { key: 'kids', label: 'Children enjoy it', words: /\b(fun|enjoy(ed|s)?|loves?|loved|engaging|interesting)\b/i },
  { key: 'quality', label: 'Good print / quality', words: /\b(quality|printing|print|paper|colou?rful|illustrations?)\b/i },
  { key: 'value', label: 'Good value', words: /\b(value|worth|affordable|price)\b/i },
  { key: 'syllabus', label: 'Matches the syllabus', words: /\b(syllabus|curriculum|board|exam)\b/i },
  { key: 'delivery', label: 'Fast delivery', words: /\b(fast|quick|on time|delivery|delivered)\b/i },
];

export interface CustomersSay { themes: { key: string; label: string; count: number }[]; basedOn: number }

/** Top themes mentioned by at least 2 reviews and ~20% of the commented reviews. Null under CUSTOMERS_SAY_MIN_REVIEWS reviews. */
export function customersSay(comments: (string | null | undefined)[], totalReviews: number): CustomersSay | null {
  if (totalReviews < CUSTOMERS_SAY_MIN_REVIEWS) return null;
  const texts = comments.map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean);
  if (texts.length < 2) return null;
  const counted = THEMES.map((t) => ({ key: t.key, label: t.label, count: texts.filter((x) => t.words.test(x)).length }))
    .filter((t) => t.count >= 2 && t.count / texts.length >= 0.2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);
  return counted.length ? { themes: counted, basedOn: texts.length } : null;
}
