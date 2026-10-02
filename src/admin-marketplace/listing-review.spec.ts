/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { ConflictException } from '@nestjs/common';
import { AdminMarketplaceService } from './admin-marketplace.service';

const ID = '64b0000000000000000000a1';
const meta = { adminId: 'admin1' };

function make(product: any, updated: any = product) {
  const productModel = {
    findOne: jest.fn().mockResolvedValue(product),
    findOneAndUpdate: jest.fn().mockResolvedValue(updated),
  };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const svc = new AdminMarketplaceService(
    { repositories: { productModel } } as any,
    { log: jest.fn() } as any,
    notifications as any,
    {} as any,
    {} as any,
  );
  return { svc, productModel, notifications };
}

describe('Admin listing review', () => {
  it('approving a pending listing makes it live, records the approval and tells the seller', async () => {
    const pending = { _id: ID, name: 'Grade 3 Maths Pack', status: 'pending_review', sellerId: 'sel1', storeId: 's1', scheduledAt: null };
    const { svc, productModel, notifications } = make(pending, { ...pending, status: 'active' });
    const res: any = await svc.approveListing(ID, undefined, meta);

    expect(productModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ID, isDelete: false, status: 'pending_review' },
      { $set: expect.objectContaining({ status: 'active', approvedAt: expect.any(Date), reviewNote: null }) },
      { returnDocument: 'after' },
    );
    expect(res.data.status).toBe('active');
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'sel1', type: 'listing_approved' }));
  });

  it('a listing scheduled for later stays scheduled after approval', async () => {
    const later = new Date(Date.now() + 3 * 86_400_000);
    const pending = { _id: ID, name: 'Eid Activity Book', status: 'pending_review', sellerId: 'sel1', storeId: 's1', scheduledAt: later };
    const { svc, productModel } = make(pending, { ...pending, status: 'scheduled' });
    const res: any = await svc.approveListing(ID, undefined, meta);
    expect(productModel.findOneAndUpdate.mock.calls[0][1].$set.status).toBe('scheduled');
    expect(res.data.status).toBe('scheduled');
  });

  it('rejecting stores the reason for the seller and only works on a pending listing', async () => {
    const pending = { _id: ID, name: 'Quran Qaida', status: 'pending_review', sellerId: 'sel1', storeId: 's1' };
    const { svc, productModel, notifications } = make(pending, { ...pending, status: 'rejected' });
    await svc.rejectListing(ID, 'Please add the grade level and a clear cover.', meta);
    expect(productModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ID, isDelete: false, status: 'pending_review' },
      { $set: expect.objectContaining({ status: 'rejected', reviewNote: 'Please add the grade level and a clear cover.' }) },
      { returnDocument: 'after' },
    );
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'listing_rejected' }));
  });

  it('refuses to approve a listing that is already live', async () => {
    const { svc } = make({ _id: ID, name: 'x', status: 'active' });
    await expect(svc.approveListing(ID, undefined, meta)).rejects.toBeInstanceOf(ConflictException);
  });
});
