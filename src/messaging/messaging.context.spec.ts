import 'reflect-metadata';
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { ForbiddenException } from '@nestjs/common';
import { MessagingService } from './messaging.service';

const OID = (n: number) => `64f0c0ffee0c0ffee0c0ff${String(n).padStart(2, '0')}`;
const BUYER = OID(1), SELLER = OID(2), STORE = OID(4), CONV = OID(7), PROD = OID(8), ORD = OID(9);

const chain = (rows: any) => {
  const c: any = { select: () => c, sort: () => c, limit: () => c, lean: async () => rows };
  return c;
};

function build(owner = SELLER) {
  const orders = [
    { _id: ORD, orderNumber: 'ED-1', createdAt: new Date(), isFreeClaim: false, sellerOrders: [{ storeId: STORE, status: 'shipped' }] },
    { _id: OID(10), orderNumber: 'ED-2', createdAt: new Date(), isFreeClaim: true, sellerOrders: [{ storeId: STORE, status: 'delivered' }] },
    { _id: OID(11), orderNumber: 'ED-3', createdAt: new Date(), isFreeClaim: false, sellerOrders: [{ storeId: OID(5) }, { storeId: STORE, status: 'cancelled' }] },
  ];
  const repos: any = {
    conversationModel: { findById: jest.fn().mockResolvedValue({ _id: CONV, buyerId: BUYER, storeId: STORE, sellerId: SELLER, contextProductId: PROD, contextOrderId: ORD }) },
    storeModel: { findById: jest.fn(() => chain({ sellerId: owner, baseCurrency: 'PKR' })) },
    orderModel: { find: jest.fn(() => chain(orders)) },
    userModel: { findById: jest.fn(() => chain({ createdAt: new Date('2025-01-01'), email: 'x@y.z', phone: '0300' })) },
    productModel: { findOne: jest.fn(() => chain({ _id: PROD, name: 'Maths', slug: 'maths', images: ['i.jpg'], status: 'active' })) },
    productVariantModel: { find: jest.fn(() => chain([{ price: 500 }])) },
  };
  const svc: any = new MessagingService({ repositories: repos } as any, {} as any, {} as any, {} as any);
  return { svc, repos };
}

describe('getSellerConversationContext', () => {
  it('another seller gets 403 and nothing is read', async () => {
    const { svc, repos } = build(OID(99));
    await expect(svc.getSellerConversationContext(SELLER, CONV)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repos.orderModel.find).not.toHaveBeenCalled();
  });

  it('is scoped to this store + buyer, counts only paid-type non-cancelled non-free packages, shows cancelled apart', async () => {
    const { svc, repos } = build();
    const r = await svc.getSellerConversationContext(SELLER, CONV);
    const f = repos.orderModel.find.mock.calls[0][0];
    expect(f.userId).toBe(BUYER);
    expect(f['sellerOrders.storeId']).toBe(STORE);
    expect(repos.productModel.findOne.mock.calls[0][0].storeId).toBe(STORE);
    expect(r.stats.totalOrders).toBe(1);
    expect(r.recentOrders.find((o: any) => o.number === 'ED-3').status).toBe('cancelled');
    expect(r.order.number).toBe('ED-1');
    expect(r.product.price).toBe(500);
    expect(repos.orderModel.find).toHaveBeenCalledTimes(1);
  });

  it('never returns the buyer e-mail, phone or address', async () => {
    const { svc } = build();
    const json = JSON.stringify(await svc.getSellerConversationContext(SELLER, CONV));
    for (const k of ['email', 'phone', 'address', 'x@y.z', '0300']) expect(json).not.toContain(k);
  });
});
