/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { AiService } from '../ai-studio/core/ai.service';
import { HelpBotService } from '../ai-studio/features/help-bot.service';
import { ChatAudience, ChatbotConfig, ChatQA, CHIP_COUNT } from './chatbot.defaults';
import { ChatLang, detectLanguage, isCuratedLang } from './chatbot.lang';
import { detectGreeting, greetingReplyFor, KINDS_WITH_CHIPS } from './chatbot.greetings';
import { matchFaq } from './chatbot.matcher';
import { ChatTranslator } from './chat-translator.service';
import { ChatSupportService } from './chat-support.service';

export type ChatSource = 'faq' | 'greeting' | 'ai' | 'fallback' | 'escalated' | 'needs_contact' | 'rate_limited';
export interface ChatQuickReply { id: string; label: string }
export interface ChatAction { label: string; to: string }
export interface ChatReply {
  reply: string;
  quickReplies: ChatQuickReply[];
  actions: ChatAction[];
  source: ChatSource;
  /** Detected language of the visitor's message (en, ur, ur-latn, ar, hi, fr, ...). */
  lang: ChatLang;
  /** True when the reply carries the one-time "other languages need the assistant" note. */
  notice?: boolean;
  /** Set when source === 'escalated' (the question was sent to the Edudeen team's chat inbox). */
  conversationId?: string;
  escalation?: { conversationId: string; shortCode: string; status: string; messageId: string; guestToken?: string; notice: string };
}
export interface ChatInput {
  audience: ChatAudience; text: string; lang?: 'en' | 'ur'; langNoticeShown?: boolean; userId?: string | null; ip?: string | null;
  /** JWT role of the caller ('user' | 'seller' | 'admin'); identity itself is looked up server-side. */
  role?: string | null;
  guestToken?: string | null;
  guest?: { name?: string; email?: string; phone?: string } | null;
}

const ESC: Record<'en' | 'ur' | 'ur-latn', { sent: string; added: string; needsContact: string; rateLimited: string }> = {
  en: {
    sent: 'Thank you! Your question has been sent to the Edudeen team. You will get the answer right here in this chat.',
    added: 'Added to your conversation. The Edudeen team will reply right here.',
    needsContact: 'So we can reply to you, please share your name and an email or phone number.',
    rateLimited: 'You have sent several questions already. Please wait a little before sending another.',
  },
  ur: {
    sent: 'شکریہ! آپ کا سوال ایڈودین ٹیم کو بھیج دیا گیا ہے۔ جواب آپ کو یہیں اسی چیٹ میں ملے گا۔',
    added: 'آپ کی گفتگو میں شامل کر دیا گیا۔ ایڈودین ٹیم یہیں جواب دے گی۔',
    needsContact: 'ہم آپ کو جواب دے سکیں اس کے لیے اپنا نام اور ای میل یا فون نمبر بتائیں۔',
    rateLimited: 'آپ کئی سوالات بھیج چکے ہیں۔ دوسرا بھیجنے سے پہلے تھوڑا انتظار کریں۔',
  },
  'ur-latn': {
    sent: 'Shukriya! Aapka sawal Edudeen team ko bhej diya gaya hai. Jawab aapko yahin isi chat mein mil jayega.',
    added: 'Aapki guftagu mein shamil kar diya gaya. Edudeen team yahin jawab degi.',
    needsContact: 'Taake hum aapko jawab de saken, apna naam aur email ya phone number batayen.',
    rateLimited: 'Aap kai sawalat bhej chuke hain. Dusra bhejne se pehle thora intezar karein.',
  },
};

const NOTICE: Partial<Record<ChatLang, string>> = {
  en: 'Note: answers in other languages need the AI assistant to be on. Showing the English answer.',
  ur: 'نوٹ: دوسری زبانوں میں جواب کے لیے اے آئی اسسٹنٹ کا آن ہونا ضروری ہے۔ انگریزی جواب دکھایا جا رہا ہے۔',
  'ur-latn': 'Note: doosri zabanon mein jawab ke liye AI assistant on hona zaroori hai. English jawab dikhaya ja raha hai.',
  ar: 'ملاحظة: الإجابة بلغات أخرى تتطلب تشغيل المساعد الذكي. نعرض الإجابة بالإنجليزية.',
  hi: 'नोट: अन्य भाषाओं में उत्तर के लिए AI सहायक चालू होना चाहिए। अंग्रेज़ी उत्तर दिखाया जा रहा है।',
  fr: 'Remarque : les réponses dans d\'autres langues nécessitent l\'assistant IA. Réponse en anglais affichée.',
  es: 'Nota: las respuestas en otros idiomas requieren el asistente de IA. Se muestra la respuesta en inglés.',
  de: 'Hinweis: Antworten in anderen Sprachen erfordern den KI-Assistenten. Die englische Antwort wird angezeigt.',
  tr: 'Not: Diğer dillerde yanıt için yapay zeka asistanının açık olması gerekir. İngilizce yanıt gösteriliyor.',
  ms: 'Nota: jawapan dalam bahasa lain memerlukan pembantu AI diaktifkan. Jawapan Bahasa Inggeris dipaparkan.',
  bn: 'দ্রষ্টব্য: অন্য ভাষায় উত্তরের জন্য এআই সহকারী চালু থাকতে হবে। ইংরেজি উত্তর দেখানো হচ্ছে।',
  zh: '提示：其他语言的回答需要开启 AI 助手。现显示英文回答。',
};
const FALLBACK_RU = 'Maaf kijiye, mujhe iska durust jawab nahi mila. Neeche diye gaye sawalat mein se koi chunein ya hamari support team se rabta karein, hum aapki zaati madad karenge.';
const DISABLED_EN = 'Chat help is switched off right now. Please contact our support team.';
const DISABLED_UR = 'چیٹ ہیلپ فی الحال بند ہے۔ براہ کرم ہماری سپورٹ ٹیم سے رابطہ کریں۔';
const CONTACT_LABEL: Record<string, string> = { en: 'Contact support', ur: 'سپورٹ سے رابطہ کریں', 'ur-latn': 'Support se rabta karein' };

/** Chip labels follow the language the visitor last typed in when it is a curated one; otherwise the site language. */
export function chipLabel(qa: ChatQA, lang: ChatLang): string {
  if (lang === 'ur') return qa.qUr || qa.q;
  if (lang === 'ur-latn') return qa.qRu || qa.q;
  return qa.q;
}

@Injectable()
export class ChatbotService {
  private readonly logger = new Logger(ChatbotService.name);
  constructor(
    private readonly config: AdminConfigService,
    private readonly ai: AiService,
    private readonly help: HelpBotService,
    private readonly translator: ChatTranslator,
    private readonly support: ChatSupportService,
  ) {}

  private chips(list: ChatQA[], lang: ChatLang): ChatQuickReply[] {
    return list.slice(0, CHIP_COUNT).map(qa => ({ id: qa.id, label: chipLabel(qa, lang) }));
  }

  private async aiOn(cfg: ChatbotConfig): Promise<boolean> {
    if (!cfg.aiEnabled || !this.ai.isAvailable()) return false;
    try { return await this.ai.isFeatureOn('help_bot'); } catch { return false; }
  }

  private fallback(cfg: ChatbotConfig, list: ChatQA[], lang: ChatLang, surfaceLang: ChatLang): ChatReply {
    const text = lang === 'ur' ? cfg.fallbackTextUr : lang === 'ur-latn' ? FALLBACK_RU : cfg.fallbackText;
    const cl = CONTACT_LABEL[isCuratedLang(lang) ? lang : 'en'];
    return { reply: text, quickReplies: this.chips(list, surfaceLang), actions: [{ label: cl, to: '/contact-us' }], source: 'fallback', lang };
  }

  /** Curated variant -> translated English (cached) -> curated English + one-time note. */
  private async localize(qa: ChatQA, lang: ChatLang, ai: boolean, rateKey: string, noticeShown: boolean): Promise<{ text: string; notice: boolean }> {
    const direct = lang === 'en' ? qa.a : lang === 'ur' ? qa.aUr : lang === 'ur-latn' ? qa.aRu : undefined;
    if (direct) return { text: direct, notice: false };
    if (ai) {
      try { return { text: await this.translator.translateAnswer(qa.a, lang, rateKey), notice: false }; }
      catch (e) { this.logger.warn(`chat translation failed (${lang}): ${(e as Error).message}`); }
    }
    // AI off / failed: the curated English answer (curated Urdu/Roman Urdu without a stored variant also land here).
    const needsNotice = !isCuratedLang(lang) && !noticeShown;
    return { text: needsNotice ? `${qa.a}\n\n${NOTICE[lang] ?? NOTICE.en}` : qa.a, notice: needsNotice };
  }

  private async escalateReply(input: ChatInput, list: ChatQA[], lang: ChatLang, surface: ChatLang): Promise<ChatReply> {
    const tl: 'en' | 'ur' | 'ur-latn' = lang === 'ur' || lang === 'ur-latn' ? lang : 'en';
    const base = { quickReplies: this.chips(list, surface), actions: [] as ChatAction[], lang };
    const r = await this.support.escalate(
      { userId: input.userId, role: input.role, ip: input.ip, guestToken: input.guestToken, guest: input.guest },
      input.audience, String(input.text ?? ''), lang,
    );
    if (r.kind === 'needs_contact') return { ...base, reply: ESC[tl].needsContact, source: 'needs_contact' };
    if (r.kind === 'rate_limited') return { ...base, reply: ESC[tl].rateLimited, source: 'rate_limited' };
    const conv = r.conv;
    const escalation = {
      conversationId: String(conv._id), shortCode: conv.shortCode as string, status: conv.status as string,
      messageId: r.kind === 'escalated' ? r.messageId : '', ...(r.kind === 'escalated' && r.guestToken ? { guestToken: r.guestToken } : {}),
    };
    const notice = r.kind === 'escalated' && !r.created ? ESC[tl].added : ESC[tl].sent;
    return { ...base, reply: notice, source: 'escalated', conversationId: escalation.conversationId, escalation: { ...escalation, notice } };
  }

  async handle(input: ChatInput): Promise<ChatReply> {
    const cfg = await this.config.getChatbotConfig();
    const list = input.audience === 'seller' ? cfg.sellerQuestions : cfg.buyerQuestions;
    const site: ChatLang = input.lang === 'ur' ? 'ur' : 'en';
    const text = String(input.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const rateKey = `chat:${input.userId || input.ip || 'anon'}`;

    if (!cfg.enabled) {
      return { reply: site === 'ur' ? DISABLED_UR : DISABLED_EN, quickReplies: [], actions: [{ label: CONTACT_LABEL[site], to: '/contact-us' }], source: 'fallback', lang: site };
    }

    let lang = detectLanguage(text, site);
    let query = text;

    // (a) greetings / small talk
    const g = detectGreeting(text);
    if (g) {
      if (!g.rest) {
        const gl: ChatLang = isCuratedLang(g.lang) ? g.lang : site;
        return {
          reply: greetingReplyFor(text, g, { replyLang: site, welcomeEn: cfg.welcomeText, welcomeUr: cfg.welcomeTextUr }),
          quickReplies: g.kinds.some(k => KINDS_WITH_CHIPS.includes(k)) ? this.chips(list, gl) : [],
          actions: [], source: 'greeting', lang: g.lang,
        };
      }
      query = g.rest; lang = detectLanguage(g.rest, g.lang);
    }

    const surface: ChatLang = isCuratedLang(lang) ? lang : site;
    const aiOn = await this.aiOn(cfg);

    // (b) FAQ matcher. Non-curated languages are translated to English first (AI only).
    let matchText = query;
    let translatedQuestion = false;
    if (!isCuratedLang(lang) && aiOn) {
      try { matchText = await this.translator.toEnglish(query, rateKey); translatedQuestion = true; } catch (e) { this.logger.warn(`chat question translation failed: ${(e as Error).message}`); }
    }
    const res = matchFaq(matchText, list);
    if (res.best && res.confident) {
      const { text: reply, notice } = await this.localize(res.best.qa, lang, aiOn, rateKey, !!input.langNoticeShown);
      return { reply, quickReplies: this.chips(list, surface), actions: [], source: 'faq', lang, ...(notice ? { notice } : {}) };
    }

    // (c) default: a human answers. The question goes to the admin chat inbox (the AI help-bot is skipped).
    if (!cfg.useAiFallback) return this.escalateReply(input, list, lang, surface);

    // (c') optional AI fallback (admin toggle `useAiFallback`), grounded in the platform Q&A + admin FAQs
    if (aiOn && (isCuratedLang(lang) || translatedQuestion)) {
      try {
        const ans = await this.help.answerForChat({
          audience: input.audience, question: matchText, extra: list.map(q => ({ question: q.q, answer: q.a })),
          replyLanguage: lang === 'ur-latn' ? 'Roman Urdu (Urdu written in Latin letters)' : lang === 'ur' ? 'Urdu' : lang === 'en' ? 'English' : lang,
          rateKey, userId: input.userId ?? null,
        });
        if (ans) return { reply: ans, quickReplies: this.chips(list, surface), actions: [], source: 'ai', lang };
      } catch (e) { this.logger.warn(`chat AI step skipped: ${(e as Error).message}`); }
    }

    // AI off or empty: an ambiguous but plausible FAQ is still better than nothing.
    if (res.best && res.best.score >= 1.2) {
      const { text: reply, notice } = await this.localize(res.best.qa, lang, aiOn, rateKey, !!input.langNoticeShown);
      return { reply, quickReplies: this.chips(list, surface), actions: [], source: 'faq', lang, ...(notice ? { notice } : {}) };
    }

    // (d) friendly fallback
    return this.fallback(cfg, list, lang, surface);
  }
}
