import { creditPlayed, lessonLengthSeconds, playedEnough } from './course.util';

describe('audio/video completion needs 90% credited play time', () => {
  it('uses the teacher length, accepts a shorter real length down to half, ignores nonsense', () => {
    expect(lessonLengthSeconds(5, null)).toBe(300);
    expect(lessonLengthSeconds(5, 250)).toBe(250);
    expect(lessonLengthSeconds(5, 20)).toBe(300); // forged tiny duration is ignored
    expect(lessonLengthSeconds(null, 120)).toBe(120);
    expect(lessonLengthSeconds(null, null)).toBeNull();
  });

  it('credit is capped by real elapsed time', () => {
    const t0 = 1_000_000;
    const first = creditPlayed(undefined, 30, t0);
    expect(first).toBe(15); // first report: at most 15s
    const prev = { seconds: first, durationSeconds: null, lastAt: new Date(t0) };
    expect(creditPlayed(prev, 30, t0 + 1000)).toBe(15 + 3); // 1s elapsed (+2s tolerance)
    expect(creditPlayed(prev, 30, t0 + 40_000)).toBe(15 + 30); // per-report cap 30
    expect(creditPlayed(prev, -5, t0 + 40_000)).toBe(15);
  });

  it('playedEnough: 90% of the length, never when unknown', () => {
    expect(playedEnough({ seconds: 270, durationSeconds: null, lastAt: null }, 5)).toBe(true);
    expect(playedEnough({ seconds: 269, durationSeconds: null, lastAt: null }, 5)).toBe(false);
    expect(playedEnough({ seconds: 500, durationSeconds: null, lastAt: null }, null)).toBe(false);
    expect(playedEnough({ seconds: 110, durationSeconds: 120, lastAt: null }, null)).toBe(true);
    expect(playedEnough(undefined, 5)).toBe(false);
  });
});
