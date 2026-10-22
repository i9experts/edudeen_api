/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- mock-heavy test */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RatingService } from './rating.service';

function make(review: any) {
  const ratingModel: any = {
    findOne: jest.fn().mockResolvedValue(review),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  };
  const storeModel: any = { findOne: jest.fn().mockResolvedValue({ _id: 's1' }) };
  const log = jest.fn();
  const svc: any = new RatingService({ repositories: { ratingModel, storeModel } } as any, {} as any, { log } as any);
  svc.recalcProductRating = jest.fn();
  svc.recalcStoreRating = jest.fn();
  return { svc, ratingModel, log };
}
const review = { _id: 'r1', storeId: 's1', productId: 'p1', rating: 4, isFlagged: false };

describe('Phase 4/A: review moderation', () => {
  it('a seller cannot remove a review (admin only) - nothing is deleted', async () => {
    const { svc, ratingModel } = make(review);
    await expect(svc.moderateDeleteReview('seller-1', 'seller', 'r1')).rejects.toThrow(ForbiddenException);
    expect(ratingModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('an admin removes it, ratings are recalculated and the action is logged', async () => {
    const { svc, ratingModel, log } = make(review);
    await svc.moderateDeleteReview('admin-1', 'admin', 'r1');
    expect(ratingModel.findByIdAndUpdate).toHaveBeenCalledWith('r1', { isDelete: true });
    expect(svc.recalcProductRating).toHaveBeenCalledWith('p1');
    expect(svc.recalcStoreRating).toHaveBeenCalledWith('s1');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'review_removed', actorId: 'admin-1', actorRole: 'admin', targetId: 'r1' }));
  });

  it('the delete route is admin-only', () => {
    const roles = Reflect.getMetadata('roles', Object.getOwnPropertyDescriptor(require('./rating.controller').RatingController.prototype, 'moderateDeleteReview')!.value);
    expect(roles).toEqual(['admin']);
  });

  it('a seller flag records who flagged and is logged; a second flag loses atomically', async () => {
    const { svc, ratingModel, log } = make(review);
    await svc.flagReview('seller-1', 'seller', 'r1');
    expect(ratingModel.updateOne).toHaveBeenCalledWith({ _id: 'r1', isDelete: false, isFlagged: { $ne: true } }, { isFlagged: true, flaggedByRole: 'seller' });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'review_flagged' }));
    ratingModel.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(svc.flagReview('seller-1', 'seller', 'r1')).rejects.toThrow(BadRequestException);
  });

  it('an admin flag is stored as admin-flagged', async () => {
    const { svc, ratingModel } = make(review);
    await svc.flagReview('admin-1', 'admin', 'r1');
    expect(ratingModel.updateOne.mock.calls[0][1]).toEqual({ isFlagged: true, flaggedByRole: 'admin' });
  });

  it('a seller cannot unflag an admin-flagged review', async () => {
    const { svc, ratingModel } = make({ ...review, isFlagged: true, flaggedByRole: 'admin' });
    await expect(svc.unflagReview('seller-1', 'seller', 'r1')).rejects.toThrow(ForbiddenException);
    expect(ratingModel.updateOne).not.toHaveBeenCalled();
  });

  it('a seller can unflag their own flag (guarded so it can never touch an admin flag), an admin can unflag any', async () => {
    const own = make({ ...review, isFlagged: true, flaggedByRole: 'seller' });
    await own.svc.unflagReview('seller-1', 'seller', 'r1');
    expect(own.ratingModel.updateOne.mock.calls[0][0]).toMatchObject({ isFlagged: true, flaggedByRole: { $ne: 'admin' } });
    const admin = make({ ...review, isFlagged: true, flaggedByRole: 'admin' });
    await admin.svc.unflagReview('admin-1', 'admin', 'r1');
    expect(admin.ratingModel.updateOne.mock.calls[0][0]).toEqual({ _id: 'r1', isDelete: false, isFlagged: true });
    expect(admin.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'review_unflagged' }));
  });

  it('old flags without flaggedByRole count as seller flags', async () => {
    const { svc } = make({ ...review, isFlagged: true });
    await expect(svc.unflagReview('seller-1', 'seller', 'r1')).resolves.toMatchObject({ success: true });
  });
});