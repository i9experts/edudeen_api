import { accessDaysAt, nextAccessDaysLog } from './course.util';

describe('course access window per purchase', () => {
  const day = 86400000;

  it('no log = the current length', () => {
    expect(accessDaysAt({ accessDays: 30 }, new Date())).toBe(30);
    expect(accessDaysAt({ accessDays: null }, new Date())).toBeNull();
  });

  it('first change keeps the old length for everyone who already bought', () => {
    const t0 = new Date('2026-01-01');
    const log = nextAccessDaysLog({ accessDays: 30, accessDaysLog: [] }, 90, new Date('2026-03-01'))!;
    const course = { accessDays: 90, accessDaysLog: log };
    expect(accessDaysAt(course, t0)).toBe(30);
    expect(accessDaysAt(course, new Date('2026-02-28'))).toBe(30);
    expect(accessDaysAt(course, new Date('2026-03-02'))).toBe(90);
  });

  it('several changes: each purchase uses the length in force that day', () => {
    let course: any = { accessDays: 30, accessDaysLog: [] };
    for (const [d, at] of [[60, '2026-02-01'], [null, '2026-04-01'], [7, '2026-06-01']] as const) {
      course = { accessDays: d, accessDaysLog: nextAccessDaysLog(course, d, new Date(at)) };
    }
    expect(accessDaysAt(course, new Date('2026-01-15'))).toBe(30);
    expect(accessDaysAt(course, new Date('2026-03-01'))).toBe(60);
    expect(accessDaysAt(course, new Date('2026-05-01'))).toBeNull();
    expect(accessDaysAt(course, new Date('2026-07-01'))).toBe(7);
    expect(new Date('2026-07-01').getTime() + 7 * day).toBeGreaterThan(0);
  });

  it('saving the same length leaves the log alone; a brand-new course gets a single entry', () => {
    expect(nextAccessDaysLog({ accessDays: 30, accessDaysLog: [] }, 30)).toBeNull();
    const fresh = nextAccessDaysLog(null, 14, new Date('2026-05-01'))!;
    expect(fresh).toHaveLength(1);
    expect(accessDaysAt({ accessDays: 14, accessDaysLog: fresh }, new Date('2026-05-02'))).toBe(14);
  });
});
