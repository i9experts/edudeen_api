/* eslint-disable prettier/prettier */
import { DEFAULT_BUYER_QUESTIONS, DEFAULT_CHATBOT, DEFAULT_SELLER_QUESTIONS, CHIP_COUNT } from './chatbot.defaults';
import { matchFaq } from './chatbot.matcher';
import { effectiveChatbot, sanitizeChatbot } from './chatbot.config';

const idOf = (m: string, list = DEFAULT_BUYER_QUESTIONS) => { const r = matchFaq(m, list); return r.best && r.confident ? r.best.qa.id : null; };

describe('defaults', () => {
  it('has exactly 5 chip questions per audience, each with English, Urdu and Roman Urdu text and unique ids', () => {
    expect(DEFAULT_CHATBOT.buyerQuestions).toHaveLength(CHIP_COUNT);
    expect(DEFAULT_CHATBOT.sellerQuestions).toHaveLength(CHIP_COUNT);
    const all = [...DEFAULT_BUYER_QUESTIONS, ...DEFAULT_SELLER_QUESTIONS];
    expect(new Set(all.map(q => q.id)).size).toBe(10);
    for (const q of all) { expect(q.qUr && q.aUr && q.qRu && q.aRu).toBeTruthy(); expect(q.a.length).toBeLessThan(1500); }
  });
  it('internal links in answers are valid paths', () => {
    for (const q of [...DEFAULT_BUYER_QUESTIONS, ...DEFAULT_SELLER_QUESTIONS]) for (const t of [q.a, q.aUr!, q.aRu!]) for (const m of t.matchAll(/\]\(([^)]*)\)/g)) expect(m[1]).toMatch(/^\/[a-z-/]+$/);
  });
});

describe('matchFaq (buyer)', () => {
  it.each([
    ['how do i download my file', 'buyer-download'], ['mera download link kaam nahi kar raha', 'buyer-download'], ['ڈاؤن لوڈ کیسے کروں', 'buyer-download'], ['dawnload kese karun', 'buyer-download'],
    ['payment kaise karun', 'buyer-pay'], ['can I pay by bank transfer', 'buyer-pay'], ['ادائیگی کیسے کریں', 'buyer-pay'], ['do you accept cash on delivery', 'buyer-pay'],
    ['mera order kahan hai', 'buyer-track'], ['track my order', 'buyer-track'], ['ڈیلیوری کب ہوگی', 'buyer-track'],
    ['mujhe refund chahiye', 'buyer-refund'], ['can I return this', 'buyer-refund'], ['paise wapas', 'buyer-refund'], ['ریفنڈ کیسے ملے گا', 'buyer-refund'],
    ['what is premium', 'buyer-premium'], ['premium membership kya hai', 'buyer-premium'], ['پریمیم کیا ہے', 'buyer-premium'],
  ])('%s -> %s', (m, id) => { expect(idOf(m)).toBe(id); });

  it('exact chip text in any variant matches', () => {
    for (const q of DEFAULT_BUYER_QUESTIONS) for (const t of [q.q, q.qUr!, q.qRu!]) expect(idOf(t)).toBe(q.id);
  });
  it('tolerates typos', () => { expect(idOf('how to donwload')).toBe('buyer-download'); expect(idOf('refnd')).toBe('buyer-refund'); });
  it('unrelated text is not a confident match', () => { expect(idOf('what is the capital of france')).toBeNull(); expect(idOf('xyz')).toBeNull(); });
});

describe('matchFaq (seller)', () => {
  it.each([
    ['how do i open a store', 'seller-start'], ['main seller kaise banun', 'seller-start'], ['add product kaise karte hain', 'seller-add-product'], ['product upload', 'seller-add-product'],
    ['payout kab milega', 'seller-payout'], ['when will I be paid', 'seller-payout'], ['commission kitna hai', 'seller-fees'], ['platform fees', 'seller-fees'],
    ['flash sale mein kaise join karun', 'seller-sale'], ['premium discount lagana hai', 'seller-sale'], ['coupon banana hai', 'seller-sale'],
  ])('%s -> %s', (m, id) => { expect(idOf(m, DEFAULT_SELLER_QUESTIONS)).toBe(id); });
});

describe('chatbot config', () => {
  it('effective config falls back to defaults and merges overrides', () => {
    expect(effectiveChatbot(null).buyerQuestions).toBe(DEFAULT_BUYER_QUESTIONS);
    expect(effectiveChatbot({ buyerQuestions: [] }).buyerQuestions).toBe(DEFAULT_BUYER_QUESTIONS);
    const c = effectiveChatbot({ enabled: false, buyerQuestions: [{ id: 'x', q: 'Q', a: 'A' }], fallbackText: 'Custom' });
    expect(c.enabled).toBe(false); expect(c.buyerQuestions).toHaveLength(1); expect(c.fallbackText).toBe('Custom'); expect(c.aiEnabled).toBe(true);
  });
  it('sanitizer validates and trims', () => {
    const ok = sanitizeChatbot({ enabled: true, buyerQuestions: [{ q: ' Hi? ', a: 'Yes [home](/)', junk: 1 }, { id: 'a b!', q: 'Q2', a: 'A2', qUr: 'سوال', aRu: 'jawab' }], fallbackText: null });
    const list = ok.set['chatbot.buyerQuestions'] as any[];
    expect(list[0].q).toBe('Hi?'); expect(list[0].junk).toBeUndefined(); expect(list[1].id).toBe('ab'); expect(list[1].qUr).toBe('سوال'); expect(list[1].aRu).toBe('jawab');
    expect(ok.unset['chatbot.fallbackText']).toBe('');
  });
  it('sanitizer rejects bad input', () => {
    expect(() => sanitizeChatbot({})).toThrow();
    expect(() => sanitizeChatbot({ enabled: 'yes' })).toThrow();
    expect(() => sanitizeChatbot({ buyerQuestions: [{ q: 'x', a: '' }] })).toThrow();
    expect(() => sanitizeChatbot({ buyerQuestions: 'no' })).toThrow();
    expect(() => sanitizeChatbot({ sellerQuestions: [{ q: 'x', a: '[bad](javascript:alert(1))' }] })).toThrow();
    expect(() => sanitizeChatbot({ buyerQuestions: Array.from({ length: 31 }, () => ({ q: 'q', a: 'a' })) })).toThrow();
  });
});
