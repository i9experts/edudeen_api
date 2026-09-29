/* eslint-disable prettier/prettier */
import { RatingService } from './rating.service';

const lean = (v: any) => ({ select: () => ({ lean: () => Promise.resolve(v) }) });

describe('RatingService — verified purchase', () => {
  const build = (orders: any[]) => {
    const r: any = {
      orderModel: { find: jest.fn().mockReturnValue(lean(orders)) },
      productModel: { findOne: jest.fn().mockResolvedValue({ _id: 'p1', storeId: null }) },
      ratingModel: { findOne: jest.fn().mockResolvedValue(null) },
    };
    return new RatingService({ repositories: r } as any, {} as any);
  };
  const check = (svc: any) => svc.checkVerifiedPurchase('u1', 'p1', null, undefined);
  const order = (item: any, isPaid = true) => ({ isPaid, sellerOrders: [{ items: [{ productId: 'p1', ...item }] }] });

  it('counts a paid digital purchase (status stays pending)', async () => {
    await expect(check(build([order({ type: 'digital', status: 'pending' })]))).resolves.toBe(true);
  });
  it('does not count an unpaid digital order', async () => {
    await expect(check(build([order({ type: 'digital', status: 'pending' }, false)]))).resolves.toBe(false);
  });
  it('does not count a refunded digital item', async () => {
    await expect(check(build([order({ type: 'digital', status: 'refunded' })]))).resolves.toBe(false);
  });
  it('requires delivery for physical items', async () => {
    await expect(check(build([order({ type: 'physical', status: 'shipped' })]))).resolves.toBe(false);
    await expect(check(build([order({ type: 'physical', status: 'delivered' })]))).resolves.toBe(true);
  });
  it('rejects a review from a non-buyer', async () => {
    await expect(build([]).addReview('u1', { productId: 'p1', rating: 1, comment: 'x' } as any))
      .rejects.toThrow(/purchased/);
  });
});
