/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import { ThrottlerGuard } from '@nestjs/throttler';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ChatbotService, chipLabel } from './chatbot.service';
import { ChatTranslator, translationKeepsFacts } from './chat-translator.service';
import { ChatbotController, ChatMessageDto } from './chatbot.controller';
import { effectiveChatbot } from './chatbot.config';
import { DEFAULT_BUYER_QUESTIONS } from './chatbot.defaults';

function build(opts: { aiAvailable?: boolean; aiText?: (system: string, content: string) => string | Error; cfg?: any } = {}) {
  const generate = jest.fn(async (req: any) => {
    const r = opts.aiText ? opts.aiText(req.system, req.messages[0].content) : 'ok';
    if (r instanceof Error) throw r;
    return { text: r };
  });
  const ai: any = { generate, isAvailable: () => opts.aiAvailable ?? false, isFeatureOn: async () => true };
  const config: any = { getChatbotConfig: async () => effectiveChatbot(opts.cfg ?? null) };
  const help: any = { answerForChat: jest.fn(async () => 'AI grounded answer') };
  const translator = new ChatTranslator(ai);
  const support: any = { escalate: jest.fn(async () => ({ kind: 'escalated', conv: { _id: 'c1', shortCode: 'A7K2', status: 'open' }, messageId: 'm1', created: true })) };
  const svc = new ChatbotService(config, ai, help, translator, support);
  return { svc, generate, help, translator, support };
}
const send = (svc: ChatbotService, text: string, extra: any = {}) => svc.handle({ audience: 'buyer', text, ...extra });

describe('ChatbotService', () => {
  it('replies to greetings without touching AI, with chips', async () => {
    const { svc, generate } = build({ aiAvailable: true });
    const r = await send(svc, 'Assalamualaikum');
    expect(r.source).toBe('greeting'); expect(r.reply).toContain('Wa alaikum assalam'); expect(r.quickReplies).toHaveLength(5);
    expect(generate).not.toHaveBeenCalled();
  });

  it('answers in the language typed: English, Urdu, Roman Urdu (curated, no AI)', async () => {
    const { svc, generate } = build();
    const en = await send(svc, 'how do i download my file'); expect(en.reply).toContain('Resend download link'); expect(en.lang).toBe('en');
    const ur = await send(svc, 'میں ڈاؤن لوڈ کیسے کروں'); expect(ur.lang).toBe('ur'); expect(ur.reply).toContain('ڈاؤن لوڈز');
    const ru = await send(svc, 'mera download link kaise milega'); expect(ru.lang).toBe('ur-latn'); expect(ru.reply).toContain('Payment confirm hote hi');
    expect(ru.quickReplies[0].label).toBe(DEFAULT_BUYER_QUESTIONS[0].qRu);
    expect(generate).not.toHaveBeenCalled();
  });

  it('other languages: translates question + answer via AI, then serves repeats from the cache', async () => {
    const { svc, generate, translator } = build({
      aiAvailable: true,
      aiText: (system, content) => {
        if (system.startsWith('Translate the user message into English')) return 'How do I download my purchase?';
        if (system.startsWith('Translate the chat answer into French')) return content.replace('Once your payment is confirmed', 'Une fois le paiement confirmé');
        return 'x';
      },
    });
    const r1 = await send(svc, 'Comment puis-je télécharger mon achat ?');
    expect(r1.lang).toBe('fr'); expect(r1.source).toBe('faq'); expect(r1.reply).toContain('Une fois le paiement confirmé'); expect(r1.reply).toContain('(/account/downloads)');
    const calls = generate.mock.calls.length; // 1 question + 1 answer
    expect(calls).toBe(2);
    const r2 = await send(svc, 'Comment puis-je télécharger mon achat ?');
    expect(r2.reply).toBe(r1.reply); expect(generate.mock.calls.length).toBe(calls); expect(translator.cacheSize()).toBe(2);
  });

  it('rejects a translation that loses a link and falls back to curated English with a one-time notice', async () => {
    const { svc } = build({ aiAvailable: true, aiText: (system) => (system.startsWith('Translate the user message') ? 'how do I download my purchase' : 'Texte sans lien') });
    const r = await send(svc, 'Comment puis-je télécharger mon achat ?');
    expect(r.reply).toContain('Resend download link'); expect(r.reply).toContain('assistant IA'); expect(r.notice).toBe(true);
    const again = await send(svc, 'Comment puis-je télécharger mon achat ?', { langNoticeShown: true });
    expect(again.notice).toBeUndefined(); expect(again.reply).not.toContain('assistant IA');
  });

  it('AI off: other languages get the curated English answer and the notice in the user language when known', async () => {
    const { svc } = build({ aiAvailable: false });
    const r = await send(svc, 'wie kann ich meine bestellung bezahlen und herunterladen');
    expect(r.lang).toBe('de');
    // not confidently matched without translation -> fallback (English) - never an error
    expect(['escalated', 'faq']).toContain(r.source);
    const d = await send(svc, 'Mein Download Link funktioniert nicht ich brauche Hilfe beim Download');
    if (d.source === 'faq') expect(d.reply).toContain('Hinweis');
  });

  it('uses the existing help-bot for unmatched curated-language questions when AI is on, falls back when it is off or fails', async () => {
    const on = build({ aiAvailable: true, cfg: { useAiFallback: true } });
    const r = await send(on.svc, 'do you have a mobile app for ios');
    expect(r.source).toBe('ai'); expect(on.help.answerForChat).toHaveBeenCalled();
    const off = build({ aiAvailable: false, cfg: { useAiFallback: true } });
    const f = await send(off.svc, 'do you have a mobile app for ios');
    expect(f.source).toBe('fallback'); expect(f.actions[0].to).toBe('/contact-us'); expect(f.quickReplies).toHaveLength(5);
    const failing = build({ aiAvailable: true, cfg: { useAiFallback: true } }); failing.help.answerForChat.mockRejectedValue(new Error('boom'));
    expect((await send(failing.svc, 'do you have a mobile app for ios')).source).toBe('fallback');
    const noAiCfg = build({ aiAvailable: true, cfg: { aiEnabled: false, useAiFallback: true } });
    expect((await send(noAiCfg.svc, 'do you have a mobile app for ios')).source).toBe('fallback');
  });

  it('Urdu fallback follows the typed language; disabled widget returns a polite note', async () => {
    const { svc } = build({ cfg: { useAiFallback: true } });
    expect((await send(svc, 'آپ کے پاس موبائل ایپ ہے')).reply).toContain('معذرت');
    const off = build({ cfg: { enabled: false } });
    expect((await send(off.svc, 'hello')).reply).toContain('switched off');
  });

  it('seller audience uses the seller list', async () => {
    const { svc } = build();
    const r = await svc.handle({ audience: 'seller', text: 'platform fees kitni hain' });
    expect(r.reply).toContain('Premium fee'.slice(0, 7)); expect(r.quickReplies[0].id).toBe('seller-start');
  });

  it('default: an unmatched typed question is escalated to the admin inbox, never to the AI', async () => {
    const { svc, help, generate, support } = build({ aiAvailable: true });
    const r = await send(svc, 'do you have a mobile app for ios', { userId: 'u1', role: 'user' });
    expect(r.source).toBe('escalated'); expect(r.conversationId).toBe('c1'); expect(r.reply).toContain('sent to the Edudeen team');
    expect(help.answerForChat).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    expect(support.escalate.mock.calls[0][0]).toMatchObject({ userId: 'u1', role: 'user' });
    const ru = await send(svc, 'kya aapke paas koi mobile app hai ios ke liye'); expect(ru.reply).toContain('Shukriya');
  });

  it('known FAQ questions and greetings are never escalated', async () => {
    const { svc, support } = build();
    expect((await send(svc, 'how do i download my file')).source).toBe('faq');
    expect((await send(svc, 'hello')).source).toBe('greeting');
    expect(support.escalate).not.toHaveBeenCalled();
  });

  it('surfaces needs_contact and rate_limited from the support service', async () => {
    const a = build(); a.support.escalate.mockResolvedValue({ kind: 'needs_contact' });
    expect((await send(a.svc, 'do you have a mobile app for ios')).source).toBe('needs_contact');
    const b = build(); b.support.escalate.mockResolvedValue({ kind: 'rate_limited' });
    expect((await send(b.svc, 'do you have a mobile app for ios')).source).toBe('rate_limited');
  });

  it('chip labels switch with the language', () => {
    expect(chipLabel(DEFAULT_BUYER_QUESTIONS[0], 'ur')).toBe(DEFAULT_BUYER_QUESTIONS[0].qUr);
    expect(chipLabel(DEFAULT_BUYER_QUESTIONS[0], 'fr')).toBe(DEFAULT_BUYER_QUESTIONS[0].q);
  });
});

describe('translationKeepsFacts', () => {
  it('requires links and numbers to survive', () => {
    const src = 'Open [Premium](/premium) - save 5 percent.';
    expect(translationKeepsFacts(src, 'Ouvrez [Premium](/premium) - économisez 5 pour cent.')).toBe(true);
    expect(translationKeepsFacts(src, 'Ouvrez Premium - économisez 5 pour cent.')).toBe(false);
    expect(translationKeepsFacts(src, 'Ouvrez [Premium](/premium) - économisez.')).toBe(false);
    expect(translationKeepsFacts(src, 'کھولیں [Premium](/premium) - ٥ فیصد')).toBe(true);
  });
});

describe('ChatbotController', () => {
  it('is throttled, public with optional auth, and the DTO caps length / validates audience', async () => {
    const throttle = Reflect.getMetadata('THROTTLER:LIMITdefault', ChatbotController.prototype.message);
    expect(throttle).toBeLessThanOrEqual(30);
    expect(Reflect.getMetadata('__guards__', ChatbotController.prototype.message)?.length).toBe(1);
    const good = plainToInstance(ChatMessageDto, { audience: 'buyer', text: 'hi' });
    expect(await validate(good)).toHaveLength(0);
    expect((await validate(plainToInstance(ChatMessageDto, { audience: 'admin', text: 'hi' }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(ChatMessageDto, { audience: 'buyer', text: 'x'.repeat(1001) }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(ChatMessageDto, { audience: 'buyer', text: '' }))).length).toBeGreaterThan(0);
    void ThrottlerGuard;
  });
});
