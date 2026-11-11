/* eslint-disable prettier/prettier */
/** Pure rules for "ask the buyer for a review" (kept apart so jest can pin them without a database). */

export const REVIEW_REQUEST_WINDOW_DAYS = 60;
export const REVIEW_REQUEST_MAX_PER_SEND = 20;
export const DONE_PACKAGE_STATUSES = ['delivered', 'completed'];

export type ReviewRequestBlock = 'not_completed' | 'expired' | 'already_requested' | 'reviewed';

export interface ReviewRequestFacts {
  packageStatus: string | null | undefined;
  /** When the package was delivered / completed (falls back to the order's last update). */
  doneAt: Date | string | null | undefined;
  requestedAt: Date | string | null | undefined;
  /** Buyer already reviewed every product of this package they can review. */
  reviewed: boolean;
  now?: Date;
}

export function reviewRequestBlock(f: ReviewRequestFacts): ReviewRequestBlock | null {
  if (!DONE_PACKAGE_STATUSES.includes(String(f.packageStatus))) return 'not_completed';
  if (f.requestedAt) return 'already_requested';
  if (f.reviewed) return 'reviewed';
  const now = (f.now ?? new Date()).getTime();
  const done = f.doneAt ? new Date(f.doneAt).getTime() : NaN;
  if (!Number.isFinite(done) || now - done > REVIEW_REQUEST_WINDOW_DAYS * 86_400_000) return 'expired';
  return null;
}

export const REVIEW_REQUEST_REASON_TEXT: Record<ReviewRequestBlock, string> = {
  not_completed: 'The order is not completed yet',
  expired: `Older than ${REVIEW_REQUEST_WINDOW_DAYS} days`,
  already_requested: 'A review was already requested',
  reviewed: 'The buyer already reviewed this order',
};

/** A reply can be edited for 24 hours after it was posted (admin is exempt). */
export const REPLY_EDIT_WINDOW_MS = 24 * 3_600_000;
export function canEditReply(replyCreatedAt: Date | string | null | undefined, now = new Date()): boolean {
  if (!replyCreatedAt) return false;
  const t = new Date(replyCreatedAt).getTime();
  return Number.isFinite(t) && now.getTime() - t <= REPLY_EDIT_WINDOW_MS;
}

/** Seller's reasons for reporting a review. `other` needs text. */
export const REPORT_REASONS: Record<string, string> = {
  abusive: 'Abusive language',
  off_topic: 'Not about the product',
  personal_info: 'Contains personal information',
  spam: 'Spam',
  wrong_product: 'Wrong product',
  other: 'Other',
};
export const REPORT_TEXT_MAX = 300;

export function cleanReport(codeRaw: unknown, textRaw: unknown): { code: string; text: string | null } | string {
  const code = String(codeRaw ?? '');
  if (!REPORT_REASONS[code]) return 'Choose a valid reason';
  const text = typeof textRaw === 'string' ? textRaw.replace(/\s+/g, ' ').trim() : '';
  if (text.length > REPORT_TEXT_MAX) return `Details can be at most ${REPORT_TEXT_MAX} characters`;
  if (code === 'other' && text.length < 5) return 'Please describe the problem (at least 5 characters)';
  return { code, text: text || null };
}

/** Trusted-seller targets (progress card). Targets are constants so the owner can tune them in one place. */
export const TRUSTED_TARGETS = { avgRating: 4.7, responseRatePct: 95, replyWithinHours: 48, minReviews: 10 };

export interface TrustedInput { avgRating: number; reviews: number; responseRatePct: number; avgReplyHours: number | null }
export function trustedProgress(i: TrustedInput) {
  const t = TRUSTED_TARGETS;
  const items = [
    { key: 'avgRating', label: 'Average rating', value: i.avgRating, target: t.avgRating, met: i.reviews > 0 && i.avgRating >= t.avgRating },
    { key: 'responseRate', label: 'Response rate', value: i.responseRatePct, target: t.responseRatePct, met: i.reviews > 0 && i.responseRatePct >= t.responseRatePct },
    { key: 'replyTime', label: 'Reply time (hours)', value: i.avgReplyHours, target: t.replyWithinHours, met: i.avgReplyHours != null && i.avgReplyHours <= t.replyWithinHours },
    { key: 'minReviews', label: 'Reviews', value: i.reviews, target: t.minReviews, met: i.reviews >= t.minReviews },
  ];
  return { items, qualifies: items.every(x => x.met) };
}
