/* eslint-disable prettier/prettier */
import { detectLanguage, normalizeText } from './chatbot.lang';
import { detectGreeting, greetingReplyFor } from './chatbot.greetings';

describe('detectLanguage', () => {
  it.each([
    ['میں اپنی خریداری کیسے ڈاؤن لوڈ کروں؟', 'ur'],
    ['مرحبا كيف أطلب', 'ar'],
    ['मैं भुगतान कैसे करूं', 'hi'],
    ['আমি কীভাবে পেমেন্ট করব', 'bn'],
    ['如何下载我的购买', 'zh'],
    ['Main apni kharidari kaise download karoon?', 'ur-latn'],
    ['mujhe payment kab milegi', 'ur-latn'],
    ['How can I pay for my order?', 'en'],
    ['Comment puis-je télécharger mon achat ?', 'fr'],
    ['¿Cómo puedo pagar mi pedido?', 'es'],
    ['Wie kann ich meine Bestellung bezahlen?', 'de'],
    ['Siparişimi nasıl takip edebilirim', 'tr'],
    ['Bagaimana saya boleh bayar pesanan saya', 'ms'],
  ])('%s -> %s', (text, lang) => { expect(detectLanguage(text)).toBe(lang); });

  it('falls back when there is no signal', () => {
    expect(detectLanguage('???', 'ur')).toBe('ur');
    expect(detectLanguage('', 'en')).toBe('en');
  });
  it('normalises Arabic/Urdu variants', () => {
    expect(normalizeText('السلام عليكم')).toBe(normalizeText('السلام علیکم'));
  });
});

describe('detectGreeting', () => {
  const opts = { replyLang: 'en' as const };
  const reply = (t: string, replyLang: 'en' | 'ur' = 'en') => { const g = detectGreeting(t)!; return { g, text: greetingReplyFor(t, g, { replyLang }) }; };

  it.each([
    'Assalamualaikum', 'assalam o alaikum', 'Assalamu alaikum wa rahmatullahi wa barakatuh', 'as salam alaikum', 'Salam', 'salaam', 'AOA', 'a.o.a', 'slm', 'walaikum assalam', 'Salam bhai',
  ])('salam "%s"', (t) => {
    const { g, text } = reply(t);
    expect(g.kinds).toContain('salam'); expect(g.rest).toBe('');
    expect(text).toContain('Wa alaikum assalam wa rahmatullahi wa barakatuh');
    expect(text).toContain('Welcome to Edudeen');
  });

  it('Urdu script salam gets an Urdu reply; Arabic gets Arabic', () => {
    expect(reply('السلام علیکم').text).toContain('وعلیکم السلام');
    expect(detectGreeting('السلام عليكم')!.lang).toBe('ar');
    expect(reply('السلام عليكم').text).toContain('وعليكم السلام');
  });

  it.each([
    ['Hello', 'en', 'Hello!'], ['hii', 'en', 'Hello!'], ['Good morning', 'en', 'Hello!'], ['ہیلو', 'ur', 'السلام علیکم!'], ['مرحبا', 'ar', 'أهلاً'], ['नमस्ते', 'hi', 'नमस्ते'],
    ['Bonjour', 'fr', 'Bonjour'], ['Hola', 'es', 'Hola'], ['Hallo', 'de', 'Hallo'], ['Merhaba', 'tr', 'Merhaba'], ['নমস্কার', 'bn', 'নমস্কার'], ['你好', 'zh', '你好'],
    ['Selamat pagi', 'ms', 'Hai'], ['apa kabar', 'ms', 'Alhamdulillah'], ['Ciao', 'it', 'Ciao'],
  ])('hello "%s" -> %s', (t, lang, word) => {
    const { g, text } = reply(t);
    expect(g.lang).toBe(lang); expect(text).toContain(word);
  });

  it('thanks, jazakallah, goodbye and how are you', () => {
    expect(reply('shukriya').text).toContain('Wa iyyakum');
    expect(reply('thank you').text).toContain('welcome');
    expect(reply('Jazakallah khair').text).toContain('Jazakumullahu khairan');
    expect(reply('جزاک اللہ').text).toContain('وایاکم');
    expect(reply('شکریہ').g.lang).toBe('ur');
    expect(reply('Allah hafiz').text).toContain('Allah hafiz');
    expect(reply('خدا حافظ').text).toContain('اللہ حافظ');
    expect(reply('khuda hafiz').g.kinds).toEqual(['bye']);
    expect(reply('bye').text).toContain('Goodbye');
    expect(reply('how are you').text).toContain('Alhamdulillah');
    expect(reply('aap kaise hain').text).toContain('Alhamdulillah');
  });

  it('combined greetings and site-language Urdu', () => {
    const { g, text } = reply('salam, kaise ho');
    expect(g.kinds).toEqual(['salam', 'howareyou']); expect(text).toContain('Alhamdulillah');
    expect(reply('hello', 'ur').text).toContain('السلام علیکم');
  });

  it('leaves the question in `rest`, and ignores non-greetings', () => {
    expect(detectGreeting('salam, how do I download my file?')!.rest).toBe('how do i download my file');
    expect(detectGreeting('how do I download')).toBeNull();
    expect(detectGreeting('salamat')).toBeNull();
    expect(detectGreeting('history of Pakistan book')).toBeNull();
    void opts;
  });
});
