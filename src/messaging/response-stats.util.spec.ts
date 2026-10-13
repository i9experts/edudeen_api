import { buildResponseStats, firstReplyMinutes, median } from './response-stats.util';

const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0) + min * 60_000);

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

  it('needs at least 3 replied conversations', () => {
    expect(buildResponseStats([10, 20])).toBeNull();
    expect(buildResponseStats([10, 20, 400], t(0))).toEqual({ medianReplyMinutes: 20, sampleSize: 3, updatedAt: t(0) });
  });
});
