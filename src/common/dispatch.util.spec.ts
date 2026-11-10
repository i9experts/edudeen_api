import { addWorkingDays, dispatchDueAt, parseDispatchDays, resolvePackageDispatchDays, workingCalendarDays, pktWeekday, LEGACY_DISPATCH_HOURS } from './dispatch.util';

// 2026-11-09 is a Monday (Pakistan time). 07:00Z = 12:00 PKT.
const at = (d: string) => new Date(`${d}T07:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('addWorkingDays', () => {
  it('skips Sundays', () => {
    expect(iso(addWorkingDays(at('2026-11-09'), 3))).toBe('2026-11-12'); // Mon +3 = Thu
    expect(iso(addWorkingDays(at('2026-11-13'), 2))).toBe('2026-11-16'); // Fri +2 = Mon (Sat, skip Sun)
    expect(iso(addWorkingDays(at('2026-11-14'), 1))).toBe('2026-11-16'); // Sat +1 = Mon
    expect(iso(addWorkingDays(at('2026-11-15'), 1))).toBe('2026-11-16'); // Sun +1 = Mon
    expect(iso(addWorkingDays(at('2026-11-09'), 6))).toBe('2026-11-16'); // Mon +6 = next Mon
  });
  it('keeps time of day and never lands on Sunday', () => {
    for (let d = 0; d < 14; d++) for (let n = 1; n <= 7; n++) {
      const out = addWorkingDays(new Date(at('2026-11-09').getTime() + d * 86_400_000), n);
      expect(pktWeekday(out.getTime())).not.toBe(0);
      expect((out.getTime() - at('2026-11-09').getTime()) % 86_400_000).toBe(0);
    }
  });
});

describe('closed form used in Mongo == addWorkingDays', () => {
  it('every weekday and N 1..7', () => {
    for (let d = 0; d < 7; d++) for (let n = 1; n <= 7; n++) {
      const base = new Date(at('2026-11-09').getTime() + d * 86_400_000);
      const mongoDow = pktWeekday(base.getTime()) + 1; // $dayOfWeek: Sun = 1
      const expected = Math.round((addWorkingDays(base, n).getTime() - base.getTime()) / 86_400_000);
      expect(workingCalendarDays(mongoDow, n)).toBe(expected);
    }
  });
});

describe('legacy + validation', () => {
  it('no snapshot = base + 48 h exactly', () => {
    const b = at('2026-11-14');
    expect(dispatchDueAt(b, null).getTime()).toBe(b.getTime() + LEGACY_DISPATCH_HOURS * 3_600_000);
    expect(dispatchDueAt(b, undefined).getTime()).toBe(b.getTime() + 48 * 3_600_000);
  });
  it('dispatchDays 3 = +3 working days', () => {
    expect(iso(dispatchDueAt(at('2026-11-09'), 3))).toBe('2026-11-12');
  });
  it('parse: 1..7 only', () => {
    expect([0, 8, 1.5, -1, 'x', NaN].map(parseDispatchDays)).toEqual([null, null, null, null, null, null]);
    expect([1, 7, '3'].map(parseDispatchDays)).toEqual([1, 7, 3]);
  });
  it('package = max override, else store, else 2', () => {
    expect(resolvePackageDispatchDays(2, [null, 5, 3])).toBe(5);
    expect(resolvePackageDispatchDays(4, [null, undefined])).toBe(4);
    expect(resolvePackageDispatchDays(undefined, [])).toBe(2);
    expect(resolvePackageDispatchDays(99, [])).toBe(2);
  });
});
