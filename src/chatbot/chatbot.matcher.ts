/* eslint-disable prettier/prettier */
import { ChatQA } from './chatbot.defaults';
import { normalizeText } from './chatbot.lang';

/**
 * FAQ matcher (pure). English / Roman Urdu / Urdu words are folded into shared CONCEPTS ("download", "pay", ...),
 * then the message is scored against each question with IDF weights, so a distinctive word ("download") beats a generic one ("order").
 * Unknown words fall back to typo-tolerant raw-token overlap (works for admin-added Q&As too).
 */
const STOP = new Set(normalizeText('the a an is are to of and or how do does did i my can what in on for it me you your we our be get have has with this that there their at by from will would should could when where why which who please help ka ki ke kya hai hain kaise kese kaisay mujhe mera meri mere main me aap ap se ko hota hoti ho kar karna karun karoon karein kon kaun aur ya bhi liye wala wali ہے ہیں کیا کیسے کو کی کا کے میں سے اور یا بھی مجھے میرا میری آپ کر ہو ہوتا ہوتی کرنا کریں پر').split(' '));

/** concept -> words (Latin words are normalised on load). Weak words (generic nouns) contribute half. */
const CONCEPTS: Record<string, { strong: string[]; weak?: string[] }> = {
  download: { strong: ['download', 'downloads', 'downloading', 'downloaded', 'dawnload', 'downlod', 'ڈاؤن', 'ڈاون', 'لوڈ', 'ڈاؤنلوڈ', 'library', 'لائبریری', 'resend'], weak: ['file', 'files', 'pdf', 'link', 'فائل', 'فائلیں', 'لنک'] },
  pay: { strong: ['pay', 'paid', 'paying', 'payment', 'payments', 'pyment', 'payout', 'payouts', 'withdraw', 'withdrawal', 'earning', 'earnings', 'earn', 'earned', 'income', 'wallet', 'bank', 'transfer', 'card', 'credit', 'debit', 'cod', 'cash', 'jazzcash', 'easypaisa', 'receipt', 'proof', 'bhugtan', 'adaigi', 'adayegi', 'ادائیگی', 'ادا', 'پیمنٹ', 'کارڈ', 'بینک', 'ٹرانسفر', 'والیٹ', 'کیش', 'رسید', 'کمائی', 'آمدنی', 'kamai'] },
  track: { strong: ['track', 'tracking', 'status', 'ship', 'shipped', 'shipping', 'deliver', 'delivery', 'delivered', 'dispatch', 'dispatched', 'parcel', 'courier', 'arrive', 'arrival', 'ٹریک', 'ٹریکنگ', 'ڈیلیوری', 'پارسل', 'کورئیر', 'شپ', 'شپنگ'], weak: ['order', 'orders', 'آرڈر', 'آرڈرز', 'kahan', 'kidhar', 'کہاں'] },
  refund: { strong: ['refund', 'refunds', 'refunded', 'return', 'returns', 'returned', 'wapas', 'واپس', 'واپسی', 'ریفنڈ', 'ریٹرن', 'cancel', 'cancellation', 'exchange', 'replace', 'replacement', 'damaged', 'broken', 'wrong', 'galat', 'منسوخ', 'غلط', 'کینسل'] },
  premium: { strong: ['premium', 'member', 'members', 'membership', 'پریمیم', 'ممبر', 'ممبرز', 'ممبرشپ', 'early'] },
  sell: { strong: ['sell', 'selling', 'seller', 'sellers', 'become', 'register', 'signup', 'bechna', 'bechne', 'بیچنا', 'بیچنے', 'سیلر', 'رجسٹر', 'plan', 'plans', 'monthly', 'yearly', 'trial', 'approval', 'approve', 'approved', 'verify', 'verification'], weak: ['store', 'shop', 'open', 'create', 'start', 'dukan', 'دکان', 'اسٹور', 'شروع', 'account'] },
  product: { strong: ['add', 'upload', 'listing', 'listings', 'list', 'publish', 'post', 'اپ', 'پروڈکٹ', 'پروڈکٹس', 'شامل', 'product', 'products'] },
  fee: { strong: ['fee', 'fees', 'commission', 'charges', 'charge', 'percentage', 'percent', 'deduction', 'cut', 'کمیشن', 'فیس', 'چارجز', 'کٹوتی', 'platform', 'rate', 'ریٹ', 'پلیٹ', 'فارم'] },
  sale: { strong: ['sale', 'sales', 'offer', 'offers', 'discount', 'discounts', 'campaign', 'campaigns', 'flash', 'promotion', 'promo', 'coupon', 'coupons', 'deal', 'deals', 'marketing', 'advertise', 'ڈسکاؤنٹ', 'سیل', 'آفر', 'مہم', 'کوپن', 'پروموشن', 'کیمپین', 'riayat', 'chhoot', 'رعایت', 'چھوٹ'] },
};
const WORD_TO_CONCEPT = new Map<string, { concept: string; w: number }>();
for (const [concept, { strong, weak }] of Object.entries(CONCEPTS)) {
  for (const w of strong) WORD_TO_CONCEPT.set(normalizeText(w), { concept, w: 1 });
  for (const w of weak ?? []) if (!WORD_TO_CONCEPT.has(normalizeText(w))) WORD_TO_CONCEPT.set(normalizeText(w), { concept, w: 0.5 });
}
const CONCEPT_VOCAB = [...WORD_TO_CONCEPT.keys()].filter(w => /^[a-z]+$/.test(w));

export function levenshtein(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const stem = (w: string) => (/^[a-z]+$/.test(w) && w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w);

/** Term -> weight for a piece of text. Terms are "c:<concept>" or "w:<token>". */
export function termsOf(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (t: string, w: number) => { if ((out.get(t) ?? 0) < w) out.set(t, w); };
  const weakSeen = new Map<string, Set<string>>();
  const prepared = text.replace(/cash[\s-]+on[\s-]+delivery|کیش آن ڈیلیوری/gi, ' cod ');
  for (const tok of normalizeText(prepared).split(' ')) {
    if (!tok || STOP.has(tok) || tok.length < 2) continue;
    let hit = WORD_TO_CONCEPT.get(tok);
    if (!hit && /^[a-z]{5,}$/.test(tok)) {
      const max = tok.length >= 8 ? 2 : 1;
      let bestD = max + 1; let bestW = '';
      for (const v of CONCEPT_VOCAB) {
        if (v.length < 5) continue;
        const d = levenshtein(tok, v, max);
        if (d < bestD) { bestD = d; bestW = v; }
      }
      if (bestW) hit = WORD_TO_CONCEPT.get(bestW);
    }
    if (hit && hit.w < 1) {
      // two different weak words of one concept (e.g. open + store) together count as a strong signal
      const seen = weakSeen.get(hit.concept) ?? new Set<string>(); seen.add(tok); weakSeen.set(hit.concept, seen);
      add(`c:${hit.concept}`, seen.size >= 2 ? 1 : hit.w);
    } else if (hit) add(`c:${hit.concept}`, hit.w);
    else add(`w:${stem(tok)}`, 1);
  }
  return out;
}

export interface FaqMatch { qa: ChatQA; score: number; index: number }
export interface FaqResult {
  best: FaqMatch | null;
  /** Other close candidates (best first, excluding `best`). */
  others: FaqMatch[];
  /** True when `best` is clearly the answer (distinctive and not tied). */
  confident: boolean;
}

const MIN_SCORE = 1.2;

export function matchFaq(message: string, list: ChatQA[]): FaqResult {
  const none: FaqResult = { best: null, others: [], confident: false };
  if (!list.length) return none;
  const norm = normalizeText(message);
  if (!norm) return none;
  // 1) exact question text (chips) in any language variant
  const exact = list.findIndex(qa => [qa.q, qa.qUr, qa.qRu].some(v => v && normalizeText(v) === norm));
  if (exact >= 0) { const m = { qa: list[exact], score: 99, index: exact }; return { best: m, others: [], confident: true }; }

  const msg = termsOf(message);
  if (!msg.size) return none;
  const qTerms = list.map(qa => {
    const m = new Map<string, number>();
    for (const t of [qa.q, qa.qUr, qa.qRu]) if (t) for (const [k, w] of termsOf(t)) if ((m.get(k) ?? 0) < w) m.set(k, w);
    return m;
  });
  const aTerms = list.map(qa => {
    const m = new Map<string, number>();
    for (const t of [qa.a, qa.aUr, qa.aRu]) if (t) for (const [k, w] of termsOf(t)) if ((m.get(k) ?? 0) < w) m.set(k, w);
    return m;
  });
  const N = list.length;
  const df = new Map<string, number>();
  for (const m of qTerms) for (const k of m.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const idf = (k: string) => Math.log(1 + N / (df.get(k) ?? 1));

  let matchedWeight = 0;
  const scored: FaqMatch[] = list.map((qa, index) => {
    let score = 0;
    for (const [k, wm] of msg) {
      const wq = qTerms[index].get(k);
      if (wq !== undefined) { score += idf(k) * Math.min(wm, wq); continue; }
      const wa = aTerms[index].get(k);
      if (wa !== undefined) score += 0.25 * idf(k) * Math.min(wm, wa);
    }
    return { qa, score, index };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < MIN_SCORE) {
    return { best: best && best.score >= 0.6 ? best : null, others: scored.slice(1, 3).filter(s => s.score >= 0.6), confident: false };
  }
  for (const k of msg.keys()) if (qTerms[best.index].has(k)) matchedWeight += 1;
  const second = scored[1];
  const unique = !second || best.score >= second.score * 1.25;
  const coverage = matchedWeight / msg.size;
  const confident = unique && (msg.size <= 5 || coverage >= 0.25);
  return { best, others: scored.slice(1, 3).filter(s => s.score >= 0.6), confident };
}
