import {
  buildDispatchRate, buildResponseRate, buildResponseStats, firstInquiry, firstReplyMinutes, median, publicTrust,
  DISPATCH_HOURS, RESPONSE_RATE_HOURS, TRUST_MIN_SAMPLES, type DispatchPackage, type FirstInquiry,
} from './response-stats.util';

const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0) + min * 60_000);
const H = 60; // minutes per hour

describe('response stats', () => {
  it('measures buyer inquiry -> next seller message', () => {
    expect(firstReplyMinutes([
      { senderRole: 'user', at: t(0) }, { senderRole: 'user', at: t(5) }, { senderRole: 'seller', at: t(30) },
    ])).toBe(30);
  });

  it('ignores admin messages and unsorted input', () => {
    expect(firstReplyMinutes([
      { senderRole: 'seller', at: t(90) }, { senderRole: 'admin', at: t(10) }, { senderRole: 'user', at: t(60) },
    ])).toBe(30);
  });

  it('ignores a seller message that is not a reply, and returns null when unanswered', () => {
    expect(firstReplyMinutes([{ senderRole: 'seller', at: t(0) }, { senderRole: 'user', at: t(10) }])).toBeNull();
    expect(firstReplyMinutes([])).toBeNull();
  });

  it('median handles odd and even counts', () => {
    expect(median([10, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });

  it('one shared minimum of 10 (median reply time included)', () => {
    expect(TRUST_MIN_SAMPLES).toBe(10);
    expect(buildResponseStats([10, 20, 400, 5, 6, 7, 8, 9, 11])).toBeNull(); // 9
    expect(buildResponseStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], t(0))).toEqual({ medianReplyMinutes: 6, sampleSize: 10, updatedAt: t(0) });
  });
});

describe('response rate (answered within 24 h)', () => {
  const now = t(100 * 24 * H); // far after every fixture inquiry
  const answered = (replyHours: number): FirstInquiry => ({ inquiryAt: t(0).getTime(), replyMinutes: replyHours * H });
  const unanswered = (ageHours: number): FirstInquiry => ({ inquiryAt: now.getTime() - ageHours * 3_600_000, replyMinutes: null });

  it('firstInquiry returns the first inquiry with or without a reply', () => {
    expect(firstInquiry([{ senderRole: 'user', at: t(0) }, { senderRole: 'seller', at: t(90) }])).toEqual({ inquiryAt: t(0).getTime(), replyMinutes: 90 });
    expect(firstInquiry([{ senderRole: 'user', at: t(0) }])).toEqual({ inquiryAt: t(0).getTime(), replyMinutes: null });
    expect(firstInquiry([{ senderRole: 'seller', at: t(0) }])).toBeNull();
  });

  it('FIXTURE: 8 inside 24 h + 2 late = 10 inquiries -> 80%', () => {
    const rows = [...Array(8)].map(() => answered(2)).concat([answered(24.5), answered(48)]);
    expect(RESPONSE_RATE_HOURS).toBe(24);
    expect(buildResponseRate(rows, now)).toEqual({ pct: 80, sample: 10 });
  });

  it('exactly 24 h counts as in time', () => {
    const rows = [...Array(10)].map(() => answered(24));
    expect(buildResponseRate(rows, now)).toEqual({ pct: 100, sample: 10 });
  });

  it('an old unanswered inquiry is a miss, a fresh one (< 24 h) is left out', () => {
    const rows = [...Array(9)].map(() => answered(1)).concat([unanswered(30), unanswered(3)]);
    expect(buildResponseRate(rows, now)).toEqual({ pct: 90, sample: 10 }); // 9 hits of 10; the 3 h one is pending
  });

  it('FIXTURE: 9 inquiries -> number hidden', () => {
    const rows = [...Array(9)].map(() => answered(1));
    expect(buildResponseRate(rows, now)).toEqual({ pct: null, sample: 9 });
  });
});

describe('dispatch on time (shipped within 48 h of payment)', () => {
  const now = t(100 * 24 * H);
  const paid = t(0);
  const shipped = (afterHours: number): DispatchPackage => ({ baseAt: paid, shippedAt: new Date(paid.getTime() + afterHours * 3_600_000), cancelled: false });

  it('FIXTURE: 7 on time (incl. exactly 48 h) + 2 late + 1 never shipped = 10 -> 70%', () => {
    expect(DISPATCH_HOURS).toBe(48);
    const pkgs = [...Array(6)].map(() => shipped(10)).concat([shipped(48), shipped(49), shipped(120), { baseAt: paid, shippedAt: null, cancelled: false }]);
    expect(buildDispatchRate(pkgs, now)).toEqual({ pct: 70, sample: 10 });
  });

  it('leaves out cancelled, unpaid and not-yet-late packages', () => {
    const pkgs = [
      ...[...Array(10)].map(() => shipped(5)),
      { baseAt: paid, shippedAt: null, cancelled: true },
      { baseAt: null, shippedAt: null, cancelled: false },
      { baseAt: new Date(now.getTime() - 10 * 3_600_000), shippedAt: null, cancelled: false }, // 10 h old, still has time
    ];
    expect(buildDispatchRate(pkgs, now)).toEqual({ pct: 100, sample: 10 });
  });

  it('FIXTURE: 9 packages -> number hidden', () => {
    expect(buildDispatchRate([...Array(9)].map(() => shipped(1)), now)).toEqual({ pct: null, sample: 9 });
  });
});

describe('publicTrust (what the store page receives)', () => {
  it('hides a number below the minimum even if a stale pct was stored, and passes the city', () => {
    const out = publicTrust({
      trustStats: { responseRate: { pct: 100, sample: 4 }, dispatch: { pct: 90, sample: 12 } },
      shipFrom: { city: ' Lahore ' },
    });
    expect(out.responseRate).toEqual({ pct: null, sample: 4 });
    expect(out.dispatch).toEqual({ pct: 90, sample: 12 });
    expect(out.city).toBe('Lahore');
  });

  it('no cached stats yet -> everything null / 0', () => {
    const out = publicTrust({ trustStats: null, shipFrom: null });
    expect(out.responseRate).toEqual({ pct: null, sample: 0 });
    expect(out.dispatch).toEqual({ pct: null, sample: 0 });
    expect(out.city).toBeNull();
  });
});
