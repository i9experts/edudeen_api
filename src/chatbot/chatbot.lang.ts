/* eslint-disable prettier/prettier */
/**
 * Language detection + text normalisation for the Edudeen Help chat widget (pure, no I/O).
 * Codes: en, ur (Urdu script), ur-latn (Roman Urdu), ar, hi, bn, zh, ja, ko, ru, fr, es, de, tr, ms (Malay/Indonesian), pt, it.
 */
export type ChatLang = 'en' | 'ur' | 'ur-latn' | 'ar' | 'hi' | 'bn' | 'zh' | 'ja' | 'ko' | 'ru' | 'fr' | 'es' | 'de' | 'tr' | 'ms' | 'pt' | 'it';

/** Languages the curated Q&A cover without any translation. */
export const CURATED_LANGS: ChatLang[] = ['en', 'ur', 'ur-latn'];
export const isCuratedLang = (l: string): boolean => (CURATED_LANGS as string[]).includes(l);

/** Human name used in translation prompts. */
export const LANG_NAMES: Record<ChatLang, string> = {
  en: 'English', ur: 'Urdu', 'ur-latn': 'Roman Urdu (Urdu in Latin letters)', ar: 'Arabic', hi: 'Hindi', bn: 'Bengali', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  ru: 'Russian', fr: 'French', es: 'Spanish', de: 'German', tr: 'Turkish', ms: 'Malay / Indonesian', pt: 'Portuguese', it: 'Italian',
};

/** Normalise for matching: lowercase, strip Latin accents + Arabic diacritics, unify Arabic/Urdu letter variants, punctuation -> space. */
export function normalizeText(input: string): string {
  let s = String(input ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[ً-ٰٟـ]/g, '').normalize('NFC').toLowerCase();
  s = s
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[أإآ]/g, 'ا').replace(/[ةهھۃ]/g, 'ہ').replace(/ؤ/g, 'و')
    .replace(/ı/g, 'i').replace(/ß/g, 'ss');
  s = s.replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

const RX = {
  arabic: /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g,
  devanagari: /[ऀ-ॿ]/g,
  bengali: /[ঀ-৿]/g,
  han: /[一-鿿]/g,
  kana: /[぀-ヿ]/g,
  hangul: /[가-힯]/g,
  cyrillic: /[Ѐ-ӿ]/g,
  latin: /[A-Za-zÀ-ɏ]/g,
};
const count = (s: string, rx: RegExp) => (s.match(rx) ?? []).length;

const URDU_LETTERS = /[ٹڈڑںےگچپکھ]/;
const URDU_WORDS = new Set(['کیا', 'ہے', 'ہیں', 'میں', 'کیسے', 'کو', 'کی', 'کا', 'اور', 'مجھے', 'میرا', 'میری', 'سے', 'نہیں', 'کب', 'کہاں', 'آپ', 'کر', 'ہو', 'کرنا', 'چاہیے', 'سکتا', 'سکتی', 'ہوں']);

const WORDS: Record<string, string[]> = {
  'ur-latn': ['kya', 'hai', 'hain', 'kaise', 'kese', 'kaisay', 'mujhe', 'mera', 'meri', 'mere', 'nahi', 'nahin', 'karna', 'kar', 'karo', 'karun', 'karoon', 'kahan', 'kab', 'aap', 'ap', 'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'main', 'me', 'chahiye', 'chahye', 'batao', 'bataye', 'batain', 'paisay', 'paise', 'wapas', 'kitna', 'kitni', 'kitne', 'kyun', 'kyon', 'hota', 'hoti', 'hoga', 'milega', 'milegi', 'sakta', 'sakti', 'sakte', 'lun', 'lu', 'dekh', 'bhej', 'bheji', 'bhejna', 'shukriya', 'acha', 'theek', 'aur', 'ya', 'wala', 'wali', 'raha', 'rahi', 'rahe', 'tha', 'thi', 'liye', 'bhi', 'abhi', 'jaldi', 'madad', 'bechna', 'dukan', 'khareed', 'kharidna', 'kharidari'],
  en: ['how', 'do', 'i', 'can', 'my', 'what', 'is', 'the', 'to', 'a', 'an', 'where', 'when', 'why', 'are', 'you', 'your', 'get', 'and', 'for', 'of', 'it', 'on', 'with', 'this', 'that', 'will', 'does', 'have', 'help', 'need', 'want', 'please', 'order', 'pay', 'download', 'refund', 'track', 'sell', 'product', 'store', 'fees', 'money', 'paid'],
  fr: ['le', 'la', 'les', 'des', 'est', 'je', 'comment', 'pour', 'mon', 'ma', 'mes', 'une', 'un', 'vous', 'quels', 'que', 'quoi', 'puis', 'peux', 'puisje', 'commande', 'paiement', 'remboursement', 'telecharger', 'ou', 'quand', 'avec', 'dans', 'sur', 'pas', 'bonjour', 'merci', 'aide', 'vendre'],
  es: ['el', 'los', 'las', 'como', 'puedo', 'para', 'mi', 'una', 'esta', 'que', 'donde', 'cuando', 'por', 'con', 'pedido', 'pago', 'reembolso', 'descargar', 'vender', 'hola', 'gracias', 'ayuda', 'quiero', 'necesito', 'cuanto', 'cuales'],
  de: ['ich', 'wie', 'kann', 'mein', 'meine', 'nicht', 'ist', 'das', 'der', 'die', 'und', 'wo', 'wann', 'bestellung', 'zahlung', 'rückerstattung', 'ruckerstattung', 'herunterladen', 'verkaufen', 'hallo', 'danke', 'hilfe', 'wie', 'ein', 'eine', 'ich', 'bezahlen', 'gebühren', 'gebuhren'],
  tr: ['nasil', 'ben', 'bir', 've', 'icin', 'mi', 'degil', 'nerede', 'ne', 'zaman', 'siparis', 'odeme', 'iade', 'indir', 'satmak', 'merhaba', 'tesekkurler', 'yardim', 'nasilsin', 'benim', 'bu', 'var', 'yok'],
  ms: ['bagaimana', 'saya', 'apa', 'yang', 'untuk', 'dan', 'cara', 'bisa', 'boleh', 'dengan', 'pesanan', 'pembayaran', 'bayar', 'muat', 'turun', 'jual', 'terima', 'kasih', 'tolong', 'mau', 'ingin', 'berapa', 'dimana', 'kapan', 'tidak', 'adalah', 'ini', 'itu'],
  pt: ['como', 'posso', 'meu', 'minha', 'pedido', 'pagamento', 'reembolso', 'baixar', 'vender', 'olá', 'obrigado', 'ajuda', 'não', 'você', 'quero'],
  it: ['come', 'posso', 'mio', 'mia', 'ordine', 'pagamento', 'rimborso', 'scaricare', 'vendere', 'ciao', 'grazie', 'aiuto', 'non', 'voglio', 'quanto'],
};
// Words shared across languages that must not decide on their own.
const AMBIGUOUS = new Set(['a', 'i', 'me', 'ap', 'ka', 'ki', 'ke', 'ko', 'se', 'do', 'on', 'la', 'le', 'no', 'un', 'una', 'mi', 'es', 'ne', 'mi', 'ya', 'ma', 'or', 'wo', 'die', 'der', 'is', 'ben', 'bu', 'lu', 'tha', 'main', 'order', 'pay', 'download', 'refund', 'track', 'product', 'store', 'sell', 'fees', 'money', 'ok', 'que', 'por', 'para', 'com']);
const WORD_SETS: Record<string, Set<string>> = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.map(w => normalizeText(w)))]));

/** Detect the language of one typed message. `fallback` is used when there is not enough signal (e.g. a single ambiguous word). */
export function detectLanguage(text: string, fallback: ChatLang = 'en'): ChatLang {
  const raw = String(text ?? '');
  if (!raw.trim()) return fallback;
  const ar = count(raw, RX.arabic), dv = count(raw, RX.devanagari), bn = count(raw, RX.bengali), han = count(raw, RX.han);
  const kana = count(raw, RX.kana), hangul = count(raw, RX.hangul), cyr = count(raw, RX.cyrillic), lat = count(raw, RX.latin);
  const best = Math.max(ar, dv, bn, han + kana, hangul, cyr, lat);
  if (best === 0) return fallback;
  if (best === ar) {
    if (URDU_LETTERS.test(raw)) return 'ur';
    const words = raw.split(/[^؀-ۿ]+/).filter(Boolean);
    if (words.some(w => URDU_WORDS.has(w))) return 'ur';
    // Arabic greetings written in Arabic script are also commonly Urdu ("السلام علیکم"): treat 'علیکم' with Urdu ی as Urdu.
    if (/علیکم/.test(raw)) return 'ur';
    return 'ar';
  }
  if (best === dv) return 'hi';
  if (best === bn) return 'bn';
  if (best === han + kana) return kana > 0 ? 'ja' : 'zh';
  if (best === hangul) return 'ko';
  if (best === cyr) return 'ru';

  // Latin script: keyword scoring.
  const norm = normalizeText(raw);
  const tokens = norm.split(' ').filter(Boolean);
  const scores: Record<string, number> = {};
  for (const [lang, set] of Object.entries(WORD_SETS)) {
    let sc = 0;
    for (const t of tokens) if (set.has(t)) sc += AMBIGUOUS.has(t) ? 0.4 : 1;
    scores[lang] = sc;
  }
  if (/[¿¡ñ]/.test(raw)) scores.es += 2;
  if (/[ç]/i.test(raw) && /[éèêàù]/i.test(raw)) scores.fr += 2;
  else if (/[éèêàù]/i.test(raw)) scores.fr += 0.7;
  if (/[äöüß]/i.test(raw)) scores.de += 2;
  if (/[ğşı]/i.test(raw)) scores.tr += 2;
  if (/[ãõ]/i.test(raw)) scores.pt += 2;
  // Roman Urdu salam/shukriya forms are handled by the greeting table; here only generic words.
  let top: string = 'en'; let topScore = scores.en ?? 0;
  for (const [lang, sc] of Object.entries(scores)) if (sc > topScore + 0.01) { top = lang; topScore = sc; }
  if (topScore < 1) return top === 'en' && (scores.en ?? 0) >= 0.4 ? 'en' : fallback;
  return top as ChatLang;
}
