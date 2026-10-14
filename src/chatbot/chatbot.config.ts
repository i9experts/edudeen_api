/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { ChatbotConfig, ChatQA, DEFAULT_CHATBOT } from './chatbot.defaults';

export const CHATBOT_LIMITS = { maxQuestions: 30, q: 150, a: 1500, text: 600 } as const;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Reject links that are not internal (/path) or https. Markdown-lite [label](url) only. */
function checkLinks(text: string, field: string) {
  for (const m of text.matchAll(/\]\(([^)\s]*)\)/g)) {
    if (!/^(\/(?!\/)\S*|https:\/\/\S+)$/i.test(m[1])) throw new BadRequestException(`${field}: links must start with / or https://`);
  }
}

function sanitizeList(v: unknown, field: string): ChatQA[] {
  if (!Array.isArray(v)) throw new BadRequestException(`${field} must be a list`);
  if (v.length > CHATBOT_LIMITS.maxQuestions) throw new BadRequestException(`${field}: at most ${CHATBOT_LIMITS.maxQuestions} questions`);
  const seen = new Set<string>();
  return v.map((raw: any, i: number) => {
    const q = str(raw?.q, CHATBOT_LIMITS.q); const a = str(raw?.a, CHATBOT_LIMITS.a);
    if (!q || !a) throw new BadRequestException(`${field} #${i + 1}: question and answer are required`);
    checkLinks(a, `${field} #${i + 1} answer`);
    const qUr = str(raw?.qUr, CHATBOT_LIMITS.q); const aUr = str(raw?.aUr, CHATBOT_LIMITS.a);
    const qRu = str(raw?.qRu, CHATBOT_LIMITS.q); const aRu = str(raw?.aRu, CHATBOT_LIMITS.a);
    if (aUr) checkLinks(aUr, `${field} #${i + 1} Urdu answer`);
    if (aRu) checkLinks(aRu, `${field} #${i + 1} Roman Urdu answer`);
    let id = str(raw?.id, 60).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id || seen.has(id)) id = `${field.startsWith('buyer') ? 'b' : 's'}${Date.now().toString(36)}${i}`;
    seen.add(id);
    const out: ChatQA = { id, q, a };
    if (qUr) out.qUr = qUr; if (aUr) out.aUr = aUr;
    if (qRu) out.qRu = qRu; if (aRu) out.aRu = aRu;
    return out;
  });
}

export interface ChatbotUpdate { set: Record<string, unknown>; unset: Record<string, ''> }

/**
 * Sanitiser for PlatformConfig.chatbot (admin write). Only known keys survive; a key left out keeps its stored value;
 * `null` clears a key (the built-in default is used again); an empty question list also means "use the defaults".
 */
export function sanitizeChatbot(body: Record<string, unknown> | null | undefined): ChatbotUpdate {
  const src = body && typeof body === 'object' ? body : {};
  const set: Record<string, unknown> = {}; const unset: Record<string, ''> = {};
  for (const key of ['enabled', 'aiEnabled'] as const) {
    if (src[key] === undefined) continue;
    if (src[key] === null) { unset[`chatbot.${key}`] = ''; continue; }
    if (typeof src[key] !== 'boolean') throw new BadRequestException(`${key} must be true or false`);
    set[`chatbot.${key}`] = src[key];
  }
  for (const key of ['buyerQuestions', 'sellerQuestions'] as const) {
    if (src[key] === undefined) continue;
    if (src[key] === null) { unset[`chatbot.${key}`] = ''; continue; }
    set[`chatbot.${key}`] = sanitizeList(src[key], key === 'buyerQuestions' ? 'buyerQuestions' : 'sellerQuestions');
  }
  for (const key of ['welcomeText', 'welcomeTextUr', 'fallbackText', 'fallbackTextUr'] as const) {
    if (src[key] === undefined) continue;
    const v = str(src[key], CHATBOT_LIMITS.text);
    if (src[key] === null || !v) { unset[`chatbot.${key}`] = ''; continue; }
    checkLinks(v, key);
    set[`chatbot.${key}`] = v;
  }
  if (!Object.keys(set).length && !Object.keys(unset).length) throw new BadRequestException('Send at least one chatbot setting to update');
  return { set, unset };
}

/** Stored overrides + built-in defaults = what the widget and the endpoint use. */
export function effectiveChatbot(stored: Record<string, any> | null | undefined): ChatbotConfig {
  const s = stored && typeof stored === 'object' ? stored : {};
  const list = (v: unknown, dflt: ChatQA[]) => (Array.isArray(v) && v.length ? (v as ChatQA[]) : dflt);
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_CHATBOT.enabled,
    aiEnabled: typeof s.aiEnabled === 'boolean' ? s.aiEnabled : DEFAULT_CHATBOT.aiEnabled,
    buyerQuestions: list(s.buyerQuestions, DEFAULT_CHATBOT.buyerQuestions),
    sellerQuestions: list(s.sellerQuestions, DEFAULT_CHATBOT.sellerQuestions),
    welcomeText: str(s.welcomeText, CHATBOT_LIMITS.text) || DEFAULT_CHATBOT.welcomeText,
    welcomeTextUr: str(s.welcomeTextUr, CHATBOT_LIMITS.text) || DEFAULT_CHATBOT.welcomeTextUr,
    fallbackText: str(s.fallbackText, CHATBOT_LIMITS.text) || DEFAULT_CHATBOT.fallbackText,
    fallbackTextUr: str(s.fallbackTextUr, CHATBOT_LIMITS.text) || DEFAULT_CHATBOT.fallbackTextUr,
  };
}
