/** Pure helpers for the seller "usually replies within..." statistic. */

export const RESPONSE_WINDOW_DAYS = 30;
export const MIN_REPLIED_CONVERSATIONS = 3;

export interface StatMessage { senderRole: string; at: Date | string | number }

const ts = (v: StatMessage['at']) => new Date(v).getTime();

/**
 * Minutes the seller took to answer the FIRST buyer inquiry of one conversation, or null when no buyer
 * inquiry in the given (time-ordered) messages was answered. An inquiry is a buyer message that is not
 * preceded by another buyer message since the last seller message; admin/other senders are ignored.
 */
export function firstReplyMinutes(messages: StatMessage[]): number | null {
  const sorted = messages
    .filter((m) => m.senderRole === 'user' || m.senderRole === 'seller')
    .sort((a, b) => ts(a.at) - ts(b.at));
  let inquiryAt: number | null = null;
  for (const m of sorted) {
    if (m.senderRole === 'user') {
      if (inquiryAt === null) inquiryAt = ts(m.at);
    } else if (inquiryAt !== null) {
      return Math.max(0, (ts(m.at) - inquiryAt) / 60_000);
    }
  }
  return null;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** One value per replied conversation -> stats, or null when there are fewer than 3 (no invented numbers). */
export function buildResponseStats(replyMinutes: number[], now = new Date()) {
  if (replyMinutes.length < MIN_REPLIED_CONVERSATIONS) return null;
  return { medianReplyMinutes: Math.round(median(replyMinutes)), sampleSize: replyMinutes.length, updatedAt: now };
}
