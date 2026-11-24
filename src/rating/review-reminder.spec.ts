import { ReviewReminderService } from './review-reminder.service';
import { reviewReminderDue } from './review-request.util';
import { customersSay, starPercentages } from './review-insights.util';
import { isBestsellerBadge, pickSeriesRows } from '../products/bestseller.util';
import { cleanLearningMeta } from '../products/product-input.util';

const NOW = new Date('2026-06-30T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('reviewReminderDue', () => {
  const base = { packageStatus: 'delivered', doneAt: daysAgo(3), requestedAt: null, reviewed: false, now: NOW };
  it('is due 3+ days after delivery, not before', () => {
    expect(reviewReminderDue(base)).toBe(true);
    expect(reviewReminderDue({ ...base, doneAt: daysAgo(2) })).toBe(false);
  });
  it('never when already requested, reviewed, not delivered or older than 60 days', () => {
    expect(reviewReminderDue({ ...base, requestedAt: daysAgo(1) })).toBe(false);
    expect(reviewReminderDue({ ...base, reviewed: true })).toBe(false);
    expect(reviewReminderDue({ ...base, packageStatus: 'shipped' })).toBe(false);
    expect(reviewReminderDue({ ...base, doneAt: daysAgo(61) })).toBe(false);
  });
});

/** Tiny in-memory order store: updateOne only wins while reviewRequestedAt is still null. */
function fixture(sellerOrders: any[]) {
  const order: any = { _id: 'o1', orderNumber: 'ORD-1', userId: '64b000000000000000000001', sellerOrders };
  const notify = jest.fn().mockResolvedValue(undefined);
  const orderModel = {
    find: () => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [order] }) }) }) }),
    updateOne: jest.fn(async (_f: any, u: any) => {
      const so = order.sellerOrders[0];
      if (so.reviewRequestedAt) return { modifiedCount: 0 };
      so.reviewRequestedAt = u.$set['sellerOrders.$.reviewRequestedAt'];
      return { modifiedCount: 1 };
    }),
  };
  const ratingModel = { find: () => ({ select: () => ({ lean: async () => [] }) }) };
  const storeModel = { findById: () => ({ select: () => ({ lean: async () => ({ name: 'Kids Press' }) }) }) };
  const svc = new ReviewReminderService({ repositories: { orderModel, ratingModel, storeModel } } as any, {} as any, { notify } as any);
  return { svc, notify, order };
}

describe('ReviewReminderService.run', () => {
  const so = () => ({ _id: 'p1', storeId: 's1', status: 'delivered', deliveredAt: daysAgo(4), reviewRequestedAt: null, items: [{ productId: 'a1', name: 'Maths 1' }] });

  it('sends once and a second run sends nothing', async () => {
    const { svc, notify } = fixture([so()]);
    expect(await svc.run(NOW)).toEqual({ checked: 1, reminded: 1 });
    expect(await svc.run(NOW)).toEqual({ checked: 0, reminded: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not send when the seller already requested a review', async () => {
    const { svc, notify } = fixture([{ ...so(), reviewRequestedAt: daysAgo(1) }]);
    await svc.run(NOW);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not send inside the first 3 days', async () => {
    const { svc, notify } = fixture([{ ...so(), deliveredAt: daysAgo(1) }]);
    await svc.run(NOW);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('starPercentages', () => {
  it('always sums to exactly 100', () => {
    for (const b of [{ '5': 1, '4': 1, '3': 1 } as Record<string, number>, { '5': 7, '4': 2, '3': 1, '2': 1, '1': 1 }, { '5': 1, '4': 1, '3': 1, '2': 1, '1': 1 }, { '5': 3 }]) {
      expect(Object.values(starPercentages(b)).reduce((s, n) => s + n, 0)).toBe(100);
    }
  });
  it('is all zero with no reviews', () => {
    expect(Object.values(starPercentages({})).every(n => n === 0)).toBe(true);
  });
});

describe('customersSay', () => {
  const c = ['Clear and easy to follow', 'Very clear explanations', 'Good practice questions', 'Lots of practice', 'ok'];
  it('needs at least 5 reviews', () => {
    expect(customersSay(c, 4)).toBeNull();
    expect(customersSay(c, 5)?.themes.map(t => t.key)).toEqual(expect.arrayContaining(['clear', 'practice']));
  });
  it('is null when no theme repeats', () => {
    expect(customersSay(['a', 'b', 'c', 'd', 'e'], 5)).toBeNull();
  });
});

describe('bestseller badge and series', () => {
  it('needs the top list AND 10+ sold', () => {
    expect(isBestsellerBadge('p', 10, ['p'])).toBe(true);
    expect(isBestsellerBadge('p', 9, ['p'])).toBe(false);
    expect(isBestsellerBadge('p', 50, ['x'])).toBe(false);
  });
  it('series rows are ordered and capped at 8', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ _id: i, seriesOrder: 12 - i, name: `b${i}` }));
    const out = pickSeriesRows(rows);
    expect(out).toHaveLength(8);
    expect(out[0].seriesOrder).toBe(1);
  });
  it('series input is optional and validated', () => {
    expect('series' in cleanLearningMeta({})).toBe(false);
    expect(cleanLearningMeta({ series: '  Maths  Workbook ', seriesOrder: 2 })).toEqual({ series: 'Maths Workbook', seriesOrder: 2 });
    expect(() => cleanLearningMeta({ seriesOrder: 0 })).toThrow();
    expect(() => cleanLearningMeta({ series: 'x'.repeat(81) })).toThrow();
  });
});
