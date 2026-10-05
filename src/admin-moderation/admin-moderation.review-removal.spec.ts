/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
/* eslint-disable prettier/prettier */
import { AdminModerationService } from './admin-moderation.service';

const REPORT = '64f0c0ffee0c0ffee0c0ff01';
const REVIEW = '64f0c0ffee0c0ffee0c0ff02';
const meta = { adminId: 'admin-1' };

describe('AdminModerationService — removing a reported review', () => {
  const build = (review: any, aggregate: any = jest.fn().mockResolvedValue([{ sum: 8, count: 2 }])) => {
    const reportModel: any = {
      findOneAndUpdate: jest.fn().mockResolvedValue({ targetType: 'review', targetId: REVIEW, status: 'pending' }),
      exists: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    const ratingModel: any = {
      updateOne: jest.fn().mockResolvedValue({}),
      findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(review) })),
      aggregate,
    };
    const productModel: any = { findByIdAndUpdate: jest.fn().mockResolvedValue({}) };
    const storeModel: any = { findByIdAndUpdate: jest.fn().mockResolvedValue({}) };
    const svc = new AdminModerationService(
      { repositories: { reportModel, ratingModel, productModel, storeModel } } as any,
      { log: jest.fn() } as any,
    );
    return { svc, reportModel, ratingModel, productModel, storeModel };
  };

  it('hides the review and recomputes the product and store averages', async () => {
    const { svc, ratingModel, productModel, storeModel } = build({ productId: 'p1', storeId: 's1', rating: 5 });
    await svc.remove(REPORT, meta);
    expect(ratingModel.updateOne).toHaveBeenCalledWith({ _id: REVIEW }, { $set: { isDelete: true } });
    expect(productModel.findByIdAndUpdate).toHaveBeenCalledWith('p1', { ratingSum: 8, averageRating: 4, totalRatings: 2 });
    expect(storeModel.findByIdAndUpdate).toHaveBeenCalledWith('s1', { averageRating: 4, reviewCount: 2 });
  });

  it('a failed recompute does not roll the report back (the review is already hidden)', async () => {
    const { svc, reportModel } = build({ productId: 'p1', storeId: 's1', rating: 5 }, jest.fn().mockRejectedValue(new Error('boom')));
    await expect(svc.remove(REPORT, meta)).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(reportModel.updateOne).not.toHaveBeenCalled();
  });

  it('skips the recompute for a comment-only review (no star rating)', async () => {
    const { svc, productModel } = build({ productId: 'p1', storeId: 's1', rating: null });
    await svc.remove(REPORT, meta);
    expect(productModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
