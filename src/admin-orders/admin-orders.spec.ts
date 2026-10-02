/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { NotFoundException } from '@nestjs/common';
import { AdminOrdersService } from './admin-orders.service';

const chain = (v: any) => ({ select: () => ({ limit: () => ({ lean: () => Promise.resolve(v) }), lean: () => Promise.resolve(v) }), lean: () => Promise.resolve(v) });

function make(orders: any[] = []) {
  const orderModel: any = {
    find: jest.fn(() => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve(orders) }) }) }) })),
    countDocuments: jest.fn().mockResolvedValue(orders.length),
    aggregate: jest.fn().mockResolvedValue([{ _id: 'paid', count: orders.length }]),
    findOne: jest.fn(() => ({ lean: () => Promise.resolve(orders[0] ?? null) })),
  };
  const userModel: any = {
    find: jest.fn(() => chain([{ _id: 'u1', name: 'Sara Khan', email: 'sara@mail.com' }])),
    findById: jest.fn(() => chain({ _id: 'u1', name: 'Sara Khan', email: 'sara@mail.com', phone: '0300' })),
  };
  const storeModel: any = { find: jest.fn(() => chain([{ _id: 's1', name: 'Uzair Book Center', slug: 'uzair' }])) };
  const svc = new AdminOrdersService({ repositories: { orderModel, userModel, storeModel } } as any);
  return { svc, orderModel, userModel };
}

const ORDER = {
  _id: '64b0000000000000000000c1', orderNumber: 'ED-1042', userId: 'u1', createdAt: new Date(), currency: 'PKR',
  totalAmount: 1150, paymentType: 'cash_on_delivery', paymentStatus: 'paid', orderStatus: 'processing',
  sellerOrders: [{ _id: 'so1', storeId: 's1', status: 'processing', fulfillmentType: 'physical', items: [{ quantity: 2 }] }],
};

describe('Admin orders console', () => {
  it('one search box matches order number or buyer, and combines with the filters', async () => {
    const { svc, orderModel, userModel } = make([ORDER]);
    const res: any = await svc.list({ q: 'sara', paymentStatus: 'paid', page: 1, limit: 20 } as any);

    expect(userModel.find).toHaveBeenCalledWith({ $or: [{ email: /sara/i }, { name: /sara/i }, { phone: /sara/i }] });
    const filter = orderModel.find.mock.calls[0][0];
    expect(filter.paymentStatus).toBe('paid');
    expect(filter.$or).toEqual(expect.arrayContaining([{ orderNumber: /sara/i }, { userId: { $in: ['u1'] } }]));
    expect(res.data.items[0]).toEqual(expect.objectContaining({
      orderNumber: 'ED-1042', buyer: expect.objectContaining({ name: 'Sara Khan' }),
      stores: [{ id: 's1', name: 'Uzair Book Center', status: 'processing' }], itemCount: 2,
    }));
  });

  it('order detail names the buyer and every store', async () => {
    const { svc } = make([ORDER]);
    const res: any = await svc.detail(ORDER._id);
    expect(res.data.buyer.email).toBe('sara@mail.com');
    expect(res.data.sellerOrders[0].storeName).toBe('Uzair Book Center');
  });

  it('404s for an unknown order', async () => {
    const { svc } = make([]);
    await expect(svc.detail('64b0000000000000000000c9')).rejects.toBeInstanceOf(NotFoundException);
  });
});
