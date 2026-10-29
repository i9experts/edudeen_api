import { dueReminderOffset } from './live-class.util';
import { pktLabel } from '../products/product-schedule-notify.util';

describe('dueReminderOffset', () => {
  const now = new Date('2026-10-30T10:00:00Z');
  const at = (min: number) => new Date(now.getTime() + min * 60000);

  it('picks the smallest offset that still covers the minutes left', () => {
    expect(dueReminderOffset(at(60), now)).toEqual({ offset: 60, minutesLeft: 60 });
    expect(dueReminderOffset(at(59), now)?.offset).toBe(60);
    expect(dueReminderOffset(at(30), now)?.offset).toBe(30);
    expect(dueReminderOffset(at(16), now)?.offset).toBe(30);
    expect(dueReminderOffset(at(15), now)?.offset).toBe(15);
    expect(dueReminderOffset(at(5), now)?.offset).toBe(5);
    expect(dueReminderOffset(at(1), now)).toEqual({ offset: 5, minutesLeft: 1 });
  });

  it('sends nothing too early, after the start, or for bad dates', () => {
    expect(dueReminderOffset(at(61), now)).toBeNull();
    expect(dueReminderOffset(at(0), now)).toBeNull();
    expect(dueReminderOffset(at(-5), now)).toBeNull();
    expect(dueReminderOffset('nope', now)).toBeNull();
  });
});

describe('pktLabel', () => {
  it('shows Pakistan time (UTC+5)', () => {
    expect(pktLabel('2026-10-30T10:00:00Z')).toContain('3:00');
    expect(pktLabel('2026-10-30T10:00:00Z')).toContain('Pakistan time');
    expect(pktLabel(null)).toBe('');
  });
});
