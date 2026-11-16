/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { AdminMarketplaceService } from './admin-marketplace.service';
import {
  applyNeedsReview, listingReviewReasons, NEEDS_REVIEW_FLAG, reasonsSignature, singleImageWarning, titleClassConflict, titleTypeConflict,
} from '../products/product-quality.util';

const ID = '64b0000000000000000000a1';
const STORE = '64b0000000000000000000c1';
const meta = { adminId: 'admin1', ip: '1.2.3.4' };

describe('needs_review rules (same as the seller wizard warnings)', () => {
  it('"Class 5 book" with class 7 warns; Class 5 inside 4-5 does not', () => {
    expect(titleClassConflict('Class 5 book', 'class-7', 'class-7')).toMatch(/Title says Class 5 but suitable classes are Class 7/);
    expect(titleClassConflict('Class 5 Science Guide', 'class-4', 'class-5')).toBeNull(); // overlap = sensible
    expect(titleClassConflict('Class 5 Science Guide', 'class-5', 'class-5')).toBeNull();
  });
  it('title says course but the product is Physical', () => {
    expect(titleTypeConflict('Complete Math Course for Class 4', 'physical')).toMatch(/Physical/);
    expect(titleTypeConflict('Complete Math Course for Class 4', 'digital')).toBeNull();
    expect(titleTypeConflict('Class 4 Maths Workbook', 'physical')).toBeNull();
  });
  it('exactly one image warns; 0 (blocked elsewhere) and 3 do not', () => {
    expect(singleImageWarning(1)).toMatch(/Only 1 image/);
    expect(singleImageWarning(3)).toBeNull();
    expect(singleImageWarning(0)).toBeNull();
  });
  it('flag only when reasons exist; other flags are kept; an approved set of reasons is not flagged again', () => {
    const reasons = listingReviewReasons({ title: 'Class 5 book about maths', type: 'physical', imageCount: 1, classFrom: 'class-7', classTo: 'class-7' });
    expect(reasons.length).toBe(2);
    const first = applyNeedsReview(['contact_info'], reasons);
    expect(first.flagged).toBe(true);
    expect(first.flags).toEqual(['contact_info', NEEDS_REVIEW_FLAG]);
    // admin approved exactly these reasons -> a later seller save does not re-flag them
    const again = applyNeedsReview(first.flags, reasons, reasonsSignature(reasons));
    expect(again.flagged).toBe(false);
    expect(again.flags).toEqual(['contact_info']);
    // a NEW reason is flagged again
    const worse = applyNeedsReview([], [...reasons, 'something else'], reasonsSignature(reasons));
    expect(worse.flagged).toBe(true);
    // a clean listing drops the flag
    expect(applyNeedsReview([NEEDS_REVIEW_FLAG], []).flags).toEqual([]);
  });
});

function make(product: any, opts: { logOk?: boolean; updated?: any } = {}) {
  const productModel: any = {
    findOne: jest.fn(() => Promise.resolve(product)),
    findOneAndUpdate: jest.fn().mockResolvedValue(opts.updated === undefined ? { ...product, flags: [] } : opts.updated),
    updateOne: jest.fn().mockResolvedValue({}),
    find: jest.fn(() => ({ sort: () => ({ skip: () => ({ limit: () => Promise.resolve([product]) }) }) })),
    countDocuments: jest.fn().mockResolvedValue(1),
  };
  const log = jest.fn().mockResolvedValue(opts.logOk === false ? false : true);
  const notify = jest.fn().mockResolvedValue(undefined);
  const repos: any = {
    productModel,
    sellerModel: { find: jest.fn().mockResolvedValue([]) },
    storeModel: { find: jest.fn().mockResolvedValue([]) },
    reportModel: { find: jest.fn().mockResolvedValue([]) },
    productVariantModel: { aggregate: jest.fn().mockResolvedValue([]) },
  };
  const svc = new AdminMarketplaceService({ repositories: repos } as any, { log } as any, { notify } as any, {} as any, {} as any, {} as any);
  return { svc, productModel, log, notify };
}

const flagged = { _id: ID, name: 'Class 5 book', sellerId: 'sel1', storeId: STORE, status: 'active', flags: [NEEDS_REVIEW_FLAG], qualityReasons: ['Title says Class 5 but suitable classes are Class 7.'], isDelete: false };

describe('Admin "Needs review" listings', () => {
  it('the filter finds flagged products (and shows why); the status stays what it was', async () => {
    const { svc, productModel } = make(flagged);
    const res: any = await svc.getListings({ status: 'needs_review', page: 1, limit: 20 } as any);
    expect(productModel.find.mock.calls[0][0]).toMatchObject({ isDelete: false, flags: NEEDS_REVIEW_FLAG });
    expect(res.data.items[0]).toMatchObject({ id: ID, status: 'active', flags: [NEEDS_REVIEW_FLAG], qualityReasons: flagged.qualityReasons });
  });

  it('Approve clears the flag (status untouched), remembers the reasons and writes an awaited audit entry', async () => {
    const { svc, productModel, log } = make(flagged);
    const res: any = await svc.approveQuality(ID, meta);
    const [filter, update] = productModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: ID, isDelete: false, flags: NEEDS_REVIEW_FLAG });
    expect(update.$pull).toEqual({ flags: NEEDS_REVIEW_FLAG });
    expect(update.$set).toMatchObject({ qualityReasons: [], qualityApprovedSig: reasonsSignature(flagged.qualityReasons), qualityFixRequest: null });
    expect(update.$set.status).toBeUndefined(); // never changes the status
    expect(res.success).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ category: 'products', action: 'listing_quality_approved', actorId: 'admin1', targetId: ID }));
  });

  it('Approve is undone when the audit entry cannot be written', async () => {
    const { svc, productModel } = make(flagged, { logOk: false });
    await expect(svc.approveQuality(ID, meta)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(productModel.updateOne).toHaveBeenCalledWith({ _id: ID }, expect.objectContaining({ $addToSet: { flags: NEEDS_REVIEW_FLAG } }));
  });

  it('Approve / ask-fix on a listing that is not flagged is a 409', async () => {
    const { svc } = make({ ...flagged, flags: [] });
    await expect(svc.approveQuality(ID, meta)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.askSellerToFix(ID, 'Please fix the class range.', meta)).rejects.toBeInstanceOf(ConflictException);
  });

  it('Ask seller to fix needs a note, notifies the seller, keeps the flag and writes an awaited audit entry', async () => {
    const { svc, productModel, log, notify } = make(flagged);
    await expect(svc.askSellerToFix(ID, 'short', meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.askSellerToFix(ID, '   ', meta)).rejects.toBeInstanceOf(BadRequestException);
    expect(notify).not.toHaveBeenCalled();

    await svc.askSellerToFix(ID, 'The title says Class 5 but the classes are 7-8. Please check.', meta);
    const update = productModel.findOneAndUpdate.mock.calls[0][1];
    expect(update.$pull).toBeUndefined(); // flag stays until the seller fixes it
    expect(update.$set.qualityFixRequest).toMatchObject({ note: expect.stringContaining('Class 5'), by: 'admin1' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'sel1', type: 'listing_fix_requested', data: expect.objectContaining({ link: `/store/${STORE}/products/edit/${ID}` }) }));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'listing_quality_fix_requested', targetId: ID, metadata: expect.objectContaining({ note: expect.any(String) }) }));
  });

  it('Ask seller to fix is undone (and the seller not told) when the audit entry cannot be written', async () => {
    const { svc, productModel, notify } = make(flagged, { logOk: false });
    await expect(svc.askSellerToFix(ID, 'Please correct the class range.', meta)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(productModel.updateOne).toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
