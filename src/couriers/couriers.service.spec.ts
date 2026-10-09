/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- mock-heavy tests */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CouriersService } from './couriers.service';

const baseOrder = (over: any = {}) => ({
  _id: 'o1', orderNumber: 'ORD-1', currency: 'PKR', paymentType: 'cash_on_delivery', isPaid: false, totalAmount: 1750,
  shippingAddress: { recipientName: 'Ali', phoneNumber: '03001234567', addressLine1: 'H1', addressLine2: null, city: 'Lahore' },
  sellerOrders: [{ storeId: 's1', sellerId: 'sel1', fulfillmentType: 'physical', status: 'pending', subtotal: 1500, items: [{ name: 'Book', quantity: 2 }], trackingEvents: [] }],
  ...over,
});

function make(order: any, ownsStore = true) {
  const orderModel: any = {
    findOne: jest.fn().mockResolvedValue(order),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const storeModel: any = { findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(ownsStore ? { _id: 's1' } : null) }) })) };
  const orders: any = { updateSellerOrderStatus: jest.fn().mockResolvedValue({}) };
  const svc = new CouriersService({ repositories: { orderModel, storeModel } } as any, orders);
  return { svc, orderModel, orders };
}

describe('CouriersService', () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD, POSTEX_API_TOKEN: 'tok', POSTEX_WEBHOOK_SECRET: 'whsec' }; });
  afterEach(() => { process.env = OLD; });

  it('refuses an unconfigured courier and a store the seller does not own', async () => {
    const { svc } = make(baseOrder());
    await expect(svc.createShipment('sel1', { orderId: 'o1', storeId: 's1', courier: 'leopards' })).rejects.toBeInstanceOf(BadRequestException);
    const other = make(baseOrder(), false);
    await expect(other.svc.createShipment('sel1', { orderId: 'o1', storeId: 's1', courier: 'postex' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('books with the courier, collects the COD total, and stores tracking (status unchanged)', async () => {
    const { svc, orderModel } = make(baseOrder());
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({ status: 200, json: async () => ({ statusCode: '200', dist: { trackingNumber: 'PX1' } }) } as any);
    const res = await svc.createShipment('sel1', { orderId: 'o1', storeId: 's1', courier: 'postex' });
    expect(res.data).toMatchObject({ trackingNumber: 'PX1', codAmount: 1750 });
    const update = orderModel.updateOne.mock.calls[0][1];
    expect(update.$set['sellerOrders.0.tracking']).toMatchObject({ carrier: 'PostEx', trackingNumber: 'PX1' });
    expect(update.$set['sellerOrders.0.status']).toBeUndefined();
    fetchMock.mockRestore();
  });

  it('webhook needs the shared secret', async () => {
    const { svc } = make(baseOrder());
    await expect(svc.handleWebhook('postex', undefined, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.handleWebhook('postex', 'wrong', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('webhook with no secret configured is disabled', async () => {
    delete process.env.POSTEX_WEBHOOK_SECRET;
    const { svc } = make(baseOrder());
    await expect(svc.handleWebhook('postex', 'x', {})).rejects.toThrow('Webhook not enabled');
  });

  it('a delivered event is added to the timeline and moves the order forward', async () => {
    const order = baseOrder();
    (order.sellerOrders[0] as any).shipment = { courier: 'postex', trackingNumber: 'PX1' };
    (order.sellerOrders[0] as any).tracking = { carrier: 'PostEx', trackingNumber: 'PX1' };
    const { svc, orderModel, orders } = make(order);
    const out = await svc.handleWebhook('postex', 'whsec', { trackingNumber: 'PX1', status: 'Delivered', date: '2026-01-02T10:00:00Z' });
    expect(out.data.applied).toBe(1);
    expect(orderModel.updateOne.mock.calls[0][1].$push['sellerOrders.0.trackingEvents']).toMatchObject({ status: 'delivered', source: 'postex' });
    expect(orders.updateSellerOrderStatus.mock.calls.map((c: any) => c[1].status)).toEqual(['shipped', 'delivered']);
  });

  it('ignores duplicate events and unknown tracking numbers', async () => {
    const order = baseOrder();
    (order.sellerOrders[0] as any).shipment = { courier: 'postex', trackingNumber: 'PX1' };
    (order.sellerOrders[0] as any).trackingEvents = [{ status: 'in_transit', at: new Date('2026-01-02T10:00:00Z') }];
    const { svc, orderModel } = make(order);
    expect((await svc.handleWebhook('postex', 'whsec', { trackingNumber: 'PX1', status: 'In transit', date: '2026-01-02T10:00:00Z' })).data.applied).toBe(0);
    expect(orderModel.updateOne).not.toHaveBeenCalled();
    const none = make(null);
    expect((await none.svc.handleWebhook('postex', 'whsec', { trackingNumber: 'NOPE', status: 'Delivered' })).data.applied).toBe(0);
  });
});
