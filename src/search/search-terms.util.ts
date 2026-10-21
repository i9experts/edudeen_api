/* eslint-disable prettier/prettier */
// Pakistani-buyer search helpers: Roman-Urdu <-> Urdu script / spelling-variant synonyms,
// and a cheap in-memory typo-correction index. Pure (no Nest / DB) so it is unit-testable.
//
// To teach search a new word: add a row to SYNONYM_GROUPS (every term in a row is treated as
// equivalent). Keep terms lowercase; Urdu script is normalised automatically.

export const SYNONYM_GROUPS: string[][] = [
  ['noorani qaida', 'nurani qaida', 'norani qaida', 'noorani kaida', 'nurani kaida', 'نورانی قاعدہ'],
  ['urdu qaida', 'urdu kaida', 'اردو قاعدہ'],
  ['namaz', 'salah', 'salat', 'salaah', 'salaat', 'prayer', 'نماز'],
  ['dua', 'duaa', 'doa', 'duain', 'duas', 'دعا', 'دعائیں'],
  ['quran', 'koran', 'quraan', 'qoran', 'quran pak', 'قرآن', 'قرآن پاک'],
  ['hifz', 'hifdh', 'hifd', 'حفظ'],
  ['tajweed', 'tajwid', 'tajvid', 'تجوید'],
  ['tafseer', 'tafsir', 'تفسیر'],
  ['tarjuma', 'tarjumah', 'ترجمہ'],
  ['hadith', 'hadees', 'hadis', 'حدیث'],
  ['seerat', 'seerah', 'sirah', 'seeratun nabi', 'سیرت'],
  ['kalma', 'kalima', 'kalimah', 'کلمہ'],
  ['islamiat', 'islamiyat', 'islamyat', 'islamic studies', 'اسلامیات'],
  ['ramadan', 'ramzan', 'ramazan', 'رمضان'],
  ['arabic', 'arbi', 'عربی'],
  ['urdu', 'اردو'],
  ['english', 'angrezi', 'انگریزی'],
  ['maths', 'math', 'mathematics', 'riyazi', 'ریاضی'],
  ['science', 'سائنس'],
  ['worksheet', 'worksheets', 'work sheet', 'work sheets', 'ورک شیٹ'],
  ['flashcards', 'flash cards', 'flashcard', 'فلیش کارڈ'],
  ['past papers', 'past paper', 'pastpapers', 'پرانے پیپر'],
  ['nazm', 'nazam', 'poem', 'poems', 'rhymes', 'نظم'],
  ['kahani', 'kahaniyan', 'story', 'stories', 'کہانی', 'کہانیاں'],
  ['nursery', 'preschool', 'pre school', 'pre-school', 'prep'],
];

const ARABIC_MARKS = /[ً-ٰٟـ]/g;
const CHAR_MAP: Record<string, string> = { 'ي': 'ی', 'ى': 'ی', 'ے': 'ے', 'ك': 'ک', 'ه': 'ہ', 'ة': 'ہ', 'ۃ': 'ہ', 'ۂ': 'ہ' };

/** Lowercase, strip Arabic diacritics/tatweel, unify Arabic/Urdu letter variants, drop apostrophes, hyphens -> space. */
export function normalizeSearchText(s: string): string {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(ARABIC_MARKS, '')
    .replace(/[يىكهةۃۂ]/g, (c) => CHAR_MAP[c] ?? c)
    .replace(/['’`]/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GROUPS_NORM: string[][] = SYNONYM_GROUPS.map((g) => Array.from(new Set(g.map(normalizeSearchText))));

const MAX_VARIANTS = 14;

/** The query plus every equivalent phrasing found via the synonym table. Always begins with the (trimmed) original. */
export function expandSearchTerms(term: string, groups: string[][] = GROUPS_NORM): string[] {
  const original = String(term ?? '').trim();
  if (!original) return [];
  const out: string[] = [original];
  const seen = new Set<string>([original.toLowerCase()]);
  const add = (v: string) => {
    const t = v.trim();
    if (!t || seen.has(t.toLowerCase()) || out.length >= MAX_VARIANTS) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  const norm = normalizeSearchText(original);
  if (!norm) return out;
  const padded = ` ${norm} `;
  add(norm);
  for (const g of groups) {
    for (const phrase of g) {
      if (!padded.includes(` ${phrase} `)) continue;
      for (const alt of g) {
        if (alt === phrase) continue;
        add(padded.replace(` ${phrase} `, ` ${alt} `));
      }
    }
  }
  return out;
}

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive regex matching the query or any of its synonym/transliteration variants. */
export function buildSearchRegex(term: string): RegExp {
  const variants = expandSearchTerms(term);
  if (!variants.length) return new RegExp(escapeRx(String(term ?? '')), 'i');
  return new RegExp(variants.map(escapeRx).join('|'), 'i');
}

/** Query words (trimmed, de-duplicated, max 8). */
export function searchWords(term: string): string[] {
  const words = String(term ?? '').split(/\s+/).map((w) => w.trim()).filter(Boolean);
  return Array.from(new Set(words.map((w) => w.toLowerCase()))).slice(0, 8);
}

/** Mongo filter: EVERY word must match name, tags or description (any order). A word also matches its synonym variants. */
export function buildAllWordsFilter(term: string): Record<string, any> {
  const words = searchWords(term);
  if (!words.length) return {};
  const clauses = words.map((w) => {
    const rx = buildSearchRegex(w);
    return { $or: [{ name: rx }, { nameUr: rx }, { tags: rx }, { description: rx }] };
  });
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

/** Relevance tier (lower = better): 0 exact name, 1 name prefix, 2 name has all words, 3 name/tags have some, 4 description only. */
export function relevanceTier(term: string, name: string, tags: string[] = []): number {
  const q = normalizeSearchText(term);
  const n = normalizeSearchText(name);
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  const words = searchWords(q);
  if (words.length && words.every((w) => n.includes(w))) return 2;
  const tagText = normalizeSearchText((tags ?? []).join(' '));
  if (words.some((w) => n.includes(w) || tagText.includes(w))) return 3;
  return 4;
}

// ── typo tolerance ─────────────────────────────────────────────────────────

/** Levenshtein distance with early exit once it must exceed `max` (returns max + 1). */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const tokenize = (s: string) => normalizeSearchText(s).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Word-frequency vocabulary built from product names/tags; suggests a corrected query for misspelt words. */
export class FuzzyIndex {
  private freq = new Map<string, number>();
  builtAt = 0;

  get size() { return this.freq.size; }

  build(texts: Iterable<string>, now = Date.now()) {
    const m = new Map<string, number>();
    for (const t of texts) for (const w of tokenize(t)) if (w.length >= 3) m.set(w, (m.get(w) ?? 0) + 1);
    this.freq = m;
    this.builtAt = now;
  }

  /** Corrected query, or null when nothing needs/can be fixed. Words already in the vocabulary (or < 4 chars) are left alone. */
  correct(query: string): string | null {
    const words = tokenize(query);
    if (!words.length || !this.freq.size) return null;
    let changed = false;
    const fixed = words.map((w) => {
      if (w.length < 4 || this.freq.has(w)) return w;
      const maxD = w.length <= 5 ? 1 : 2;
      let best: string | null = null;
      let bestD = maxD + 1;
      let bestF = 0;
      for (const [cand, f] of this.freq) {
        if (Math.abs(cand.length - w.length) > maxD) continue;
        const d = boundedEditDistance(w, cand, maxD);
        if (d < bestD || (d === bestD && f > bestF)) { best = cand; bestD = d; bestF = f; }
      }
      if (best && bestD <= maxD) { changed = true; return best; }
      return w;
    });
    return changed ? fixed.join(' ') : null;
  }
}
