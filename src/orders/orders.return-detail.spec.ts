/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';

const OID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ITEM = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const DIGI = 'cccccccccccccccccccccccc';
const SO = 'dddddddddddddddddddddddd';
const RR = 'eeeeeeeeeeeeeeeeeeeeeeee';
const STORE = '111111111111111111111111';
const lean = (v: any) => ({ lean: () => Promise.resolve(v) });

function build(opts: { owns?: boolean; item?: any; refund?: any } = {}) {
  const item = { _id: ITEM, name: 'Book', type: 'physical', quantity: 1, totalPrice: 500, refundedAmount: 0, returnStatus: 'requested', returnReason: 'Torn cover', returnRequestedAt: new Date('2026-11-01T10:00:00Z'), ...opts.item };
  const digital = { _id: DIGI, name: 'Worksheet pack', type: 'digital', quantity: 1, totalPrice: 300, refundedAmount: 300, downloadCount: 3, returnStatus: 'none' };
  const order = { _id: OID, orderNumber: 'ORD-9', userId: 'ffffffffffffffffffffffff', currency: 'PKR', sellerOrders: [{ _id: SO, storeId: STORE, items: [item, digital] }] };
  const orderModel: any = {
    findOne: jest.fn(() => lean(order)),
    findOneAndUpdate: jest.fn(async (f: any) => (f[`sellerOrders.0.items.0.returnFollowUp`] === (item.returnFollowUp ?? null) ? order : null)),
  };
  const refund = opts.refund === undefined ? null : { _id: RR, orderId: OID, sellerOrderId: SO, storeId: STORE, itemIds: [DIGI], status: 'approved', reason: 'File will not open', requestedByRole: 'user', createdAt: new Date('2026-11-01T10:00:00Z'), reviewedAt: new Date('2026-11-01T12:00:00Z'), ...opts.refund };
  const repos: any = {
    orderModel,
    storeModel: { findOne: jest.fn().mockResolvedValue(opts.owns === false ? null : { _id: STORE }) },
    userModel: { findById: jest.fn(() => ({ select: () => lean({ name: 'Ayesha' }) })) },
    refundRequestModel: { findOne: jest.fn(() => lean(refund)) },
  };
  const activity: any = { log: jest.fn().mockResolvedValue(true) };
  const svc = new OrdersService({ repositories: repos } as any, {} as any, {} as any, {} as any, {} as any, activity, {} as any, { notify: jest.fn() } as any, {} as any, {} as any);
  return { svc, orderModel, activity };
}

describe('seller return detail (drawer)', () => {
  it('another seller gets 403', async () => {
    const { svc } = build({ owns: false });
    await expect(svc.getSellerReturnDetail('other', STORE, 'return', `${OID}:${ITEM}`)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('bad ids / source are 400, a request of another store is 404', async () => {
    const { svc } = build({ refund: { storeId: '999999999999999999999999' } });
    await expect(svc.getSellerReturnDetail('s', STORE, 'nope', RR)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.getSellerReturnDetail('s', STORE, 'return', 'not-an-id')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.getSellerReturnDetail('s', STORE, 'refund', RR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('OLD return (free text, no history): reason shown as written, timeline rebuilt, review allowed', async () => {
    const { svc } = build();
    const res: any = await svc.getSellerReturnDetail('s', STORE, 'return', `${OID}:${ITEM}`);
    expect(res.data).toMatchObject({ source: 'return', reasonCode: null, reasonLabel: 'Torn cover', status: 'open', refunded: false, buyer: 'Ayesha' });
    expect(res.data.timeline.map((t: any) => t.status)).toEqual(['requested']);
    expect(res.data.actions).toMatchObject({ canReview: true, canMarkReceived: false });
  });

  it('refund request on a digital item: "Downloaded" counter comes from the item, refunded derives from refundedAmount, follow-up actions follow the state', async () => {
    const { svc } = build({ refund: {} });
    const res: any = await svc.getSellerReturnDetail('s', STORE, 'refund', RR);
    expect(res.data.items[0]).toMatchObject({ type: 'digital', downloadCount: 3 });
    expect(res.data).toMatchObject({ refunded: true, refundedAmount: 300, status: 'approved' });
    expect(res.data.actions).toMatchObject({ canMarkReceived: false, canMarkReplacementSent: true });
  });
});

describe('item return follow-up (order path)', () => {
  const approved = { returnStatus: 'approved' };
  it('item_received then replacement_sent, each only from the exact previous step', async () => {
    const a = build({ item: approved });
    await expect(a.svc.returnFollowUp('s', OID, { storeId: STORE, itemId: ITEM, step: 'item_received', note: 'ok' })).resolves.toMatchObject({ success: true });
    expect(a.orderModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ 'sellerOrders.0.items.0.returnStatus': 'approved', 'sellerOrders.0.items.0.returnFollowUp': null }),
      expect.objectContaining({ $push: { 'sellerOrders.0.items.0.returnHistory': expect.objectContaining({ status: 'item_received' }) } }),
    );
    expect(a.activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'return_item_received' }));
    // replacement straight after approval on a physical item = invalid jump
    await expect(build({ item: approved }).svc.returnFollowUp('s', OID, { storeId: STORE, itemId: ITEM, step: 'replacement_sent' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a lost race (item already moved on) is a 400, a non-approved return is a 400, another seller is 403', async () => {
    await expect(build({ item: { ...approved, returnFollowUp: 'item_received' } }).svc.returnFollowUp('s', OID, { storeId: STORE, itemId: ITEM, step: 'item_received' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(build().svc.returnFollowUp('s', OID, { storeId: STORE, itemId: ITEM, step: 'item_received' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(build({ owns: false, item: approved }).svc.returnFollowUp('x', OID, { storeId: STORE, itemId: ITEM, step: 'item_received' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
