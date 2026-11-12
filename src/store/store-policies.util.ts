import { BadRequestException } from '@nestjs/common';

export const SHIPPING_NOTE_MAX = 500;
export const FAQ_MAX_ITEMS = 8;
export const FAQ_Q_MAX = 150;
export const FAQ_A_MAX = 500;

/** Plain text only: tags/angle brackets removed, whitespace collapsed (new lines kept in answers as single spaces). */
export function cleanPlainText(v: string): string {
  return v.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();
}

/** Shipping note: null / '' clears it. */
export function cleanShippingNote(v: unknown): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > SHIPPING_NOTE_MAX) {
    throw new BadRequestException(`shippingNote must be text of at most ${SHIPPING_NOTE_MAX} characters`);
  }
  return cleanPlainText(v) || null;
}

/** FAQ list: null / [] clears it. Rows with both fields blank are dropped; a half-filled row is an error. */
export function cleanFaqs(v: unknown): Array<{ q: string; a: string }> {
  if (v === null) return [];
  if (!Array.isArray(v)) throw new BadRequestException('faqs must be a list');
  if (v.length > FAQ_MAX_ITEMS) throw new BadRequestException(`You can add at most ${FAQ_MAX_ITEMS} FAQs`);
  const out: Array<{ q: string; a: string }> = [];
  for (const row of v) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new BadRequestException('Each FAQ needs a question and an answer');
    const { q, a } = row as { q?: unknown; a?: unknown };
    if ((q !== undefined && typeof q !== 'string') || (a !== undefined && typeof a !== 'string')) {
      throw new BadRequestException('Each FAQ needs a question and an answer');
    }
    if ((q ?? '').length > FAQ_Q_MAX) throw new BadRequestException(`A question can be at most ${FAQ_Q_MAX} characters`);
    if ((a ?? '').length > FAQ_A_MAX) throw new BadRequestException(`An answer can be at most ${FAQ_A_MAX} characters`);
    const cq = cleanPlainText(q ?? '');
    const ca = cleanPlainText(a ?? '');
    if (!cq && !ca) continue;
    if (!cq || !ca) throw new BadRequestException('Each FAQ needs both a question and an answer');
    out.push({ q: cq, a: ca });
  }
  return out;
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

/**
 * Accepts only YouTube / Vimeo links. Returns the canonical watch URL (the only thing ever stored) or null.
 * Anything else (other hosts, embed code, HTML, javascript:) returns null.
 */
export function parseIntroVideo(raw: unknown): { provider: 'youtube' | 'vimeo'; id: string; url: string } | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') {
    const id = parts[0];
    return id && YT_ID.test(id) ? yt(id) : null;
  }
  if (YT_HOSTS.has(host)) {
    let id: string | undefined;
    if (parts[0] === 'watch') id = u.searchParams.get('v') ?? undefined;
    else if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1];
    return id && YT_ID.test(id) ? yt(id) : null;
  }
  if (host === 'vimeo.com' || host === 'www.vimeo.com') {
    const id = [...parts].reverse().find((p) => /^\d{5,12}$/.test(p));
    return id ? vimeo(id) : null;
  }
  if (host === 'player.vimeo.com' && parts[0] === 'video' && /^\d{5,12}$/.test(parts[1] ?? '')) return vimeo(parts[1]);
  return null;
}

const yt = (id: string) => ({ provider: 'youtube' as const, id, url: `https://www.youtube.com/watch?v=${id}` });
const vimeo = (id: string) => ({ provider: 'vimeo' as const, id, url: `https://vimeo.com/${id}` });

/** null / '' clears; otherwise a valid YouTube/Vimeo link or a 400. */
export function cleanIntroVideoUrl(v: unknown): string | null {
  if (v === null || v === '') return null;
  const p = parseIntroVideo(v);
  if (!p) throw new BadRequestException('Use a YouTube or Vimeo video link (for example https://www.youtube.com/watch?v=...).');
  return p.url;
}
