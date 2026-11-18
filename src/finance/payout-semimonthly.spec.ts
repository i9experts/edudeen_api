/* eslint-disable prettier/prettier */
import { nextPayoutDate, resolveNextPayout, SCHEDULED_FREQUENCIES } from './seller-earnings.util';

// Dates are built with the LOCAL (year, month, day) constructor and checked with local getters, exactly like the
// rule itself, so the suite gives the same answer in any server timezone (run it under TZ=UTC and TZ=Asia/Karachi).
const S = { frequency: 'semimonthly' };
const L = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0);
const parts = (d: Date | null) => (d ? [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()] : null);

describe('semimonthly payout schedule (1st and 15th, chosen by the seller)', () => {
  it('is a known scheduled frequency (monthly stays the default and is untouched)', () => {
    expect(SCHEDULED_FREQUENCIES).toContain('semimonthly');
    expect(SCHEDULED_FREQUENCIES).toContain('monthly');
  });

  it('before the 15th -> the 15th at 09:00', () => {
    expect(parts(nextPayoutDate(S, L(2026, 11, 2, 10)))).toEqual([2026, 11, 15, 9, 0]);
    expect(parts(nextPayoutDate(S, L(2026, 11, 14, 23, 30)))).toEqual([2026, 11, 15, 9, 0]);
  });

  it('after the 15th -> the 1st of next month at 09:00', () => {
    expect(parts(nextPayoutDate(S, L(2026, 11, 16, 8)))).toEqual([2026, 12, 1, 9, 0]);
    expect(parts(nextPayoutDate(S, L(2026, 11, 30, 23, 59)))).toEqual([2026, 12, 1, 9, 0]);
  });

  it('exactly on a payout moment -> the NEXT one (strictly after, never the same instant twice)', () => {
    expect(parts(nextPayoutDate(S, L(2026, 11, 15, 9, 0)))).toEqual([2026, 12, 1, 9, 0]);
    expect(parts(nextPayoutDate(S, L(2026, 11, 1, 9, 0)))).toEqual([2026, 11, 15, 9, 0]);
  });

  it('same day: before 09:00 it is still today, after 09:00 it moves on', () => {
    expect(parts(nextPayoutDate(S, L(2026, 11, 15, 8, 59)))).toEqual([2026, 11, 15, 9, 0]);
    expect(parts(nextPayoutDate(S, L(2026, 11, 15, 9, 1)))).toEqual([2026, 12, 1, 9, 0]);
    expect(parts(nextPayoutDate(S, L(2026, 11, 1, 0, 5)))).toEqual([2026, 11, 1, 9, 0]);
  });

  it('month end and the 31st: Jan 31 -> Feb 1, Mar 31 -> Apr 1, Jul 31 -> Aug 1 (no skipped month, no overflow)', () => {
    expect(parts(nextPayoutDate(S, L(2026, 1, 31, 12)))).toEqual([2026, 2, 1, 9, 0]);
    expect(parts(nextPayoutDate(S, L(2026, 3, 31, 12)))).toEqual([2026, 4, 1, 9, 0]);
    expect(parts(nextPayoutDate(S, L(2026, 7, 31, 23, 59)))).toEqual([2026, 8, 1, 9, 0]);
    expect(parts(nextPayoutDate(S, L(2026, 10, 31, 12)))).toEqual([2026, 11, 1, 9, 0]);
  });

  it('February, normal and leap year', () => {
    expect(parts(nextPayoutDate(S, L(2026, 2, 28, 12)))).toEqual([2026, 3, 1, 9, 0]);
    expect(parts(nextPayoutDate(S, L(2028, 2, 29, 12)))).toEqual([2028, 3, 1, 9, 0]);
    expect(parts(nextPayoutDate(S, L(2026, 2, 10, 12)))).toEqual([2026, 2, 15, 9, 0]);
  });

  it('year end: Dec 31 -> Jan 1 of the next year; Dec 16 -> Jan 1', () => {
    expect(parts(nextPayoutDate(S, L(2026, 12, 31, 23, 59)))).toEqual([2027, 1, 1, 9, 0]);
    expect(parts(nextPayoutDate(S, L(2026, 12, 16, 9, 0)))).toEqual([2027, 1, 1, 9, 0]);
  });

  it('chains forward 1st -> 15th -> 1st for a whole year without drift or a repeated date', () => {
    let d = L(2026, 1, 1, 9, 0);
    const seen: string[] = [];
    for (let i = 0; i < 24; i++) {
      const n = nextPayoutDate(S, d)!;
      expect([1, 15]).toContain(n.getDate());
      expect(n.getHours()).toBe(9);
      expect(n.getTime()).toBeGreaterThan(d.getTime());
      seen.push(n.toDateString());
      d = n;
    }
    expect(new Set(seen).size).toBe(24);
    expect(parts(d)).toEqual([2027, 1, 1, 9, 0]);
  });

  it('timezone: an ISO instant is read in the server clock, same as the monthly rule (09:00 local on the slot day)', () => {
    // Whatever the server zone is, the answer lands on 09:00 local of a 1st or 15th, never on an off-by-one day.
    const from = new Date('2026-11-14T20:30:00Z');
    const next = nextPayoutDate(S, from)!;
    expect(next.getHours()).toBe(9);
    expect([1, 15]).toContain(next.getDate());
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    // and the gap to the instant is never more than one half-month
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(16 * 24 * 3600 * 1000);
  });

  it('resolveNextPayout keeps its rules: nothing payable -> null; clearing release pushes the date to a later slot', () => {
    const from = L(2026, 11, 2, 10);
    expect(resolveNextPayout(S, 0, from)).toBeNull();
    expect(resolveNextPayout(S, -5, from)).toBeNull();
    expect(parts(resolveNextPayout(S, 50, from))).toEqual([2026, 11, 15, 9, 0]);
    expect(parts(resolveNextPayout(S, 50, from, L(2026, 11, 20)))).toEqual([2026, 12, 1, 9, 0]);
  });

  it('monthly / manual behave exactly as before', () => {
    expect(parts(nextPayoutDate({ frequency: 'monthly', dayOfMonth: 1 }, L(2026, 11, 2, 10)))).toEqual([2026, 12, 1, 9, 0]);
    expect(nextPayoutDate({ frequency: 'manual' }, L(2026, 11, 2, 10))).toBeNull();
  });
});
