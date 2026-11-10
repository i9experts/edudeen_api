/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RefundRequestService } from './refund-request.service';
import { buildTimeline, cleanRejectReason, requiredPreviousFollowUp } from './return-trail.util';
import { reasonDisplayLabel } from './refund-evidence.util';

const id = (v: string) => ({ toString: () => v });

function build(opts: { status?: string; followUp?: string | null; itemType?: string; ownsStore?: boolean } = {}) {
  const doc: any = {
    _id: 'rr-1', orderId: 'order-1', sellerOrderId: 'so-1', storeId: 'store-1', itemIds: ['item-1'],
    status: opts.status ?? 'approved', followUp: opts.followUp ?? null, requestedByRole: 'user', requestedBy: 'buyer-1',
  };
  const order = { sellerOrders: [{ _id: id('so-1'), items: [{ _id: id('item-1'), type: opts.itemType ?? 'physical' }] }] };
  const model: any = {
    findOne: jest.fn(() => ({ lean: () => Promise.resolve(doc) })),
    // conditional update: only matches the exact previous step, like Mongo would
    findOneAndUpdate: jest.fn(async (filter: any) => (filter.status === doc.status && filter.followUp === (doc.followUp ?? null) ? { ...doc } : null)),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const repos: any = {
    refundRequestModel: model,
    orderModel: { findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(order) }) })) },
    storeModel: { findOne: jest.fn().mockResolvedValue(opts.ownsStore === false ? null : { _id: 'store-1' }) },
  };
  const activity: any = { log: jest.fn().mockResolvedValue(true) };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const svc = new RefundRequestService({ repositories: repos } as any, {} as any, {} as any, {} as any, activity, notifications);
  return { svc, model, activity, notifications };
}

describe('refund request status trail', () => {
  it('item_received after approval: conditional update, trail entry, awaited activity log, no money code touched', async () => {
    const { svc, model, activity } = build();
    await svc.followUp('seller-1', 'seller', 'rr-1', 'item_received', 'Parcel came back');
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', followUp: null }),
      expect.objectContaining({ $push: { history: expect.objectContaining({ status: 'item_received', byRole: 'seller', note: 'Parcel came back' }) } }),
      expect.anything(),
    );
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'refund_item_received' }));
  });

  it('invalid jumps are 400: replacement before the parcel is back, repeating a step, step on an open/rejected request, item_received on a digital item', async () => {
    await expect(build().svc.followUp('seller-1', 'seller', 'rr-1', 'replacement_sent')).rejects.toBeInstanceOf(BadRequestException);
    await expect(build({ followUp: 'item_received' }).svc.followUp('seller-1', 'seller', 'rr-1', 'item_received')).rejects.toBeInstanceOf(BadRequestException);
    await expect(build({ status: 'pending' }).svc.followUp('seller-1', 'seller', 'rr-1', 'item_received')).rejects.toBeInstanceOf(BadRequestException);
    await expect(build({ status: 'rejected' }).svc.followUp('seller-1', 'seller', 'rr-1', 'item_received')).rejects.toBeInstanceOf(BadRequestException);
    await expect(build({ itemType: 'digital' }).svc.followUp('seller-1', 'seller', 'rr-1', 'item_received')).rejects.toBeInstanceOf(BadRequestException);
    await expect(build().svc.followUp('seller-1', 'seller', 'rr-1', 'refunded')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('replacement_sent is allowed after item_received (physical) and straight after approval (digital)', async () => {
    await expect(build({ followUp: 'item_received' }).svc.followUp('seller-1', 'seller', 'rr-1', 'replacement_sent')).resolves.toMatchObject({ success: true });
    await expect(build({ itemType: 'digital' }).svc.followUp('seller-1', 'seller', 'rr-1', 'replacement_sent')).resolves.toMatchObject({ success: true });
  });

  it('a seller of another store gets 403 and nothing is written', async () => {
    const { svc, model } = build({ ownsStore: false });
    await expect(svc.followUp('other-seller', 'seller', 'rr-1', 'item_received')).rejects.toBeInstanceOf(ForbiddenException);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('reject without a real reason (under 10 chars) is a 400 and claims nothing', async () => {
    const { svc, model } = build({ status: 'pending' });
    for (const n of ['', 'no', 'too short', '          ']) {
      await expect(svc.reject('seller-1', 'seller', 'rr-1', n)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('reject with a reason records it in the trail and tells the buyer why', async () => {
    const { svc, model, notifications } = build({ status: 'pending' });
    model.findOneAndUpdate.mockResolvedValue({ _id: 'rr-1', storeId: 'store-1', orderId: 'order-1', requestedBy: 'buyer-1', requestedByRole: 'user' });
    await svc.reject('seller-1', 'seller', 'rr-1', 'Return window has closed');
    expect(model.updateOne).toHaveBeenCalledWith({ _id: 'rr-1' }, { $push: { history: expect.objectContaining({ status: 'rejected', note: 'Return window has closed' }) } });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('Return window has closed') }));
  });
});

describe('trail helpers', () => {
  it('requiredPreviousFollowUp is the exact previous step', () => {
    expect(requiredPreviousFollowUp('item_received', true)).toBeNull();
    expect(requiredPreviousFollowUp('replacement_sent', true)).toBe('item_received');
    expect(requiredPreviousFollowUp('replacement_sent', false)).toBeNull();
    expect(() => requiredPreviousFollowUp('item_received', false)).toThrow(BadRequestException);
    expect(() => requiredPreviousFollowUp('approved', true)).toThrow(BadRequestException);
  });

  it('cleanRejectReason needs 10+ characters after trimming', () => {
    expect(cleanRejectReason('  Used item, not eligible  ')).toBe('Used item, not eligible');
    expect(() => cleanRejectReason('short')).toThrow(BadRequestException);
    expect(() => cleanRejectReason(undefined)).toThrow(BadRequestException);
  });

  it('old free text and legacy codes still DISPLAY as written; current codes get the current label', () => {
    expect(reasonDisplayLabel(null, 'Broken spine')).toBe('Broken spine');
    expect(reasonDisplayLabel('incomplete', 'Incomplete (missing parts or pages)')).toBe('Incomplete (missing parts or pages)');
    expect(reasonDisplayLabel('cant_access_file', '')).toBe("Can't access the digital file");
    expect(reasonDisplayLabel('printing_error', 'x')).toBe('Printing error');
    expect(reasonDisplayLabel('unknown_code', 'text as stored')).toBe('text as stored');
  });

  it('old requests get a timeline from requestedAt / reviewedAt; a late trail still opens with Requested', () => {
    const t = buildTimeline({ requestedAt: new Date('2026-11-01T10:00:00Z'), status: 'approved', reviewedAt: new Date('2026-11-02T10:00:00Z') });
    expect(t.map((e) => e.status)).toEqual(['requested', 'approved']);
    expect(t[1].at).toBe('2026-11-02T10:00:00.000Z');
    const late = buildTimeline({ history: [{ status: 'approved', at: new Date('2026-11-02T10:00:00Z'), byRole: 'seller' }], requestedAt: new Date('2026-11-01T10:00:00Z'), status: 'approved' });
    expect(late.map((e) => e.status)).toEqual(['requested', 'approved']);
  });
});
