import { canEditReply, cleanReport, reviewRequestBlock, trustedProgress } from './review-request.util';

const now = new Date('2026-11-11T10:00:00Z');
const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
const base = { packageStatus: 'completed', doneAt: days(3), requestedAt: null, reviewed: false, now };

describe('reviewRequestBlock', () => {
  it('allows a recent completed, unreviewed, unrequested package', () => {
    expect(reviewRequestBlock(base)).toBeNull();
    expect(reviewRequestBlock({ ...base, packageStatus: 'delivered' })).toBeNull();
  });
  it('blocks orders that are not completed', () => {
    for (const s of ['pending', 'processing', 'shipped', 'cancelled', 'refunded'])
      expect(reviewRequestBlock({ ...base, packageStatus: s })).toBe('not_completed');
  });
  it('blocks a second request, reviewed and older than 60 days', () => {
    expect(reviewRequestBlock({ ...base, requestedAt: days(1) })).toBe('already_requested');
    expect(reviewRequestBlock({ ...base, reviewed: true })).toBe('reviewed');
    expect(reviewRequestBlock({ ...base, doneAt: days(61) })).toBe('expired');
    expect(reviewRequestBlock({ ...base, doneAt: days(59) })).toBeNull();
    expect(reviewRequestBlock({ ...base, doneAt: null })).toBe('expired');
  });
});

describe('canEditReply', () => {
  it('is true inside 24 h only', () => {
    expect(canEditReply(new Date(now.getTime() - 23 * 3_600_000), now)).toBe(true);
    expect(canEditReply(new Date(now.getTime() - 25 * 3_600_000), now)).toBe(false);
    expect(canEditReply(null, now)).toBe(false);
  });
});

describe('cleanReport', () => {
  it('validates reason and text', () => {
    expect(cleanReport('spam', '')).toEqual({ code: 'spam', text: null });
    expect(typeof cleanReport('nope', '')).toBe('string');
    expect(typeof cleanReport('other', 'hi')).toBe('string');
    expect(typeof cleanReport('spam', 'x'.repeat(301))).toBe('string');
    expect(cleanReport('other', '  not   about it ')).toEqual({ code: 'other', text: 'not about it' });
  });
});

describe('trustedProgress', () => {
  it('needs every target', () => {
    expect(trustedProgress({ avgRating: 4.8, reviews: 12, responseRatePct: 96, avgReplyHours: 10 }).qualifies).toBe(true);
    const low = trustedProgress({ avgRating: 4.6, reviews: 12, responseRatePct: 96, avgReplyHours: 10 });
    expect(low.qualifies).toBe(false);
    expect(low.items.find(i => i.key === 'avgRating')!.met).toBe(false);
    expect(trustedProgress({ avgRating: 0, reviews: 0, responseRatePct: 0, avgReplyHours: null }).qualifies).toBe(false);
  });
});
