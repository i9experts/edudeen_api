/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { AiService } from '../ai-studio/core/ai.service';
import { ChatLang, LANG_NAMES } from './chatbot.lang';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1500;

/** The URLs inside markdown links and every number - a translation is rejected when these change. */
export function protectedTokens(text: string): string[] {
  const links = [...text.matchAll(/\]\(([^)\s]*)\)/g)].map(m => m[1]);
  const nums = [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map(m => m[0]);
  return [...links, ...nums].sort();
}

/** Pure: did the translation keep every link URL and (Latin-digit) number of the source? */
export function translationKeepsFacts(source: string, translated: string): boolean {
  const norm = (s: string) => s.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const want = protectedTokens(source);
  const got = protectedTokens(norm(translated));
  const gotLinks = new Set([...translated.matchAll(/\]\(([^)\s]*)\)/g)].map(m => m[1]));
  for (const link of [...source.matchAll(/\]\(([^)\s]*)\)/g)].map(m => m[1])) if (!gotLinks.has(link)) return false;
  const pool = [...got];
  for (const n of want) { const i = pool.indexOf(n); if (i < 0) return false; pool.splice(i, 1); }
  return true;
}

/**
 * Translates curated chat answers / visitor questions with the existing AiService (feature `help_bot`, so the admin kill switch and
 * rate limits apply). Results are cached in memory for a day per (text, language) - repeat questions cost nothing.
 */
@Injectable()
export class ChatTranslator {
  private readonly cache = new Map<string, { v: string; exp: number }>();
  constructor(private readonly ai: AiService) {}

  private key(text: string, lang: string) { return `${lang}:${createHash('sha1').update(text).digest('hex')}`; }
  private get(k: string): string | null {
    const e = this.cache.get(k);
    if (!e) return null;
    if (e.exp < Date.now()) { this.cache.delete(k); return null; }
    return e.v;
  }
  private put(k: string, v: string) {
    if (this.cache.size >= MAX_ENTRIES) { const first = this.cache.keys().next().value; if (first) this.cache.delete(first); }
    this.cache.set(k, { v, exp: Date.now() + DAY_MS });
  }
  cacheSize() { return this.cache.size; }

  /** Translate a curated English answer into `lang`. Throws when AI fails or the result lost a link/number. */
  async translateAnswer(english: string, lang: ChatLang, rateKey: string): Promise<string> {
    const k = this.key(english, lang);
    const hit = this.get(k);
    if (hit) return hit;
    const out = await this.ai.generate({
      feature: 'help_bot', tier: 'fast', rateKey, maxTokens: 700,
      system: `Translate the chat answer into ${LANG_NAMES[lang]}. Keep every markdown link exactly as written (do not change the URL inside the parentheses), keep **bold** markers, line breaks and all numbers. Keep product and feature names (Edudeen, Edudeen Premium, My Library, Download, Marketing, Finance) as they are. Output ONLY the translation.`,
      messages: [{ role: 'user', content: english }],
    });
    const text = out.text.trim();
    if (!text || !translationKeepsFacts(english, text)) throw new Error('translation rejected');
    this.put(k, text);
    return text;
  }

  /** Translate a visitor's question to English so it can be matched against the curated list. */
  async toEnglish(question: string, rateKey: string): Promise<string> {
    const k = this.key(question, 'to-en');
    const hit = this.get(k);
    if (hit) return hit;
    const out = await this.ai.generate({
      feature: 'help_bot', tier: 'fast', rateKey, maxTokens: 120,
      system: 'Translate the user message into English. It is a question to an online education marketplace help desk. Output ONLY the English translation, nothing else.',
      messages: [{ role: 'user', content: question.slice(0, 400) }],
    });
    const text = out.text.trim().slice(0, 400);
    if (!text) throw new Error('empty translation');
    this.put(k, text);
    return text;
  }
}
