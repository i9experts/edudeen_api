/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.service';

const pkg = (storeId: string, sellerId: string, over: any = {}) => ({
  storeId,
  sellerId,
  status: 'shipped',
  fulfillmentType: 'physical',
  fulfillmentMode: 'seller',
  isPaid: false,
  subtotal: 1000,
  shippingFee: 200,
  codAmount: 1200,
  items: [{ status: 'shipped' }],
  ...over,
});

function build(packages: any[], orderOver: any = {}) {
  const order: any = {
    _id: 'order-1',
    orderNumber: 'ORD-1',
    userId: 'buyer-1',
    isPaid: false,
    paymentType: 'cash_on_delivery',
    orderStatus: 'partially_shipped',
    sellerOrders: packages,
    ...orderOver,
  };
  const orderModel: any = {
    findOne: jest.fn().mockResolvedValue(order),
    // Applies the $set like the DB would (only `sellerOrders.N.field` paths), so the roll-up re-read sees it.
    findOneAndUpdate: jest.fn().mockImplementation(async (_f: any, u: any) => {
      for (const [path, value] of Object.entries(u.$set ?? {})) {
        const m = /^sellerOrders\.(\d+)\.(\w+)$/.exec(path);
        if (m) order.sellerOrders[Number(m[1])][m[2]] = value;
      }
      return order;
    }),
    findById: jest.fn(() => ({ lean: () => Promise.resolve(order) })),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const finance: any = { recordSaleDurable: jest.fn().mockResolvedValue({ creditStatus: 'credited' }) };
  const svc = new OrdersService(
    { repositories: { orderModel, storeModel: {} } } as any,
    {} as any,
    {} as any,
    {} as any,
    finance,
    { log: jest.fn() } as any,
    { awardPurchasePoints: jest.fn() } as any,
    { notify: jest.fn().mockResolvedValue(undefined) } as any,
    {} as any,
    {} as any,
  );
  return { svc, orderModel, finance, order };
}

describe('markPaid on a multi-seller COD order (per package)', () => {
  it('needs a storeId', async () => {
    const { svc } = build([pkg('A', 'sa'), pkg('B', 'sb')]);
    await expect(svc.markPaid('order-1', { userId: 'sa', role: 'seller' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a seller confirms only their own package and only that store is credited', async () => {
    const { svc, finance, orderModel } = build([pkg('A', 'sa'), pkg('B', 'sb')]);
    await expect(svc.markPaid('order-1', { userId: 'sb', role: 'seller' }, 'A')).rejects.toBeInstanceOf(ForbiddenException);
    expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();

    const res: any = await svc.markPaid('order-1', { userId: 'sa', role: 'seller' }, 'A');
    expect(res.success).toBe(true);
    expect(finance.recordSaleDurable).toHaveBeenCalledTimes(1);
    expect(finance.recordSaleDurable.mock.calls[0][0].storeId).toBe('A');
    const set = orderModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set['sellerOrders.0.isPaid']).toBe(true);
    expect(set['sellerOrders.1.isPaid']).toBeUndefined();
  });

  it('the order stays partially paid until every live package is paid', async () => {
    const { svc, orderModel } = build([pkg('A', 'sa'), pkg('B', 'sb')]);
    const res: any = await svc.markPaid('order-1', { userId: 'sa', role: 'seller' }, 'A');
    expect(res.orderPaid).toBe(false);
    expect(orderModel.updateOne.mock.calls[0][1]).toEqual({ $set: { paymentStatus: 'partially_paid' } });

    orderModel.updateOne.mockClear();
    const res2: any = await svc.markPaid('order-1', { userId: 'sb', role: 'seller' }, 'B');
    expect(res2.orderPaid).toBe(true);
    expect(orderModel.updateOne.mock.calls[0][1].$set).toMatchObject({ isPaid: true, paymentStatus: 'paid', orderStatus: 'completed' });
  });

  it('a cancelled sibling does not block the order from becoming paid', async () => {
    const { svc, orderModel } = build([pkg('A', 'sa'), pkg('B', 'sb', { status: 'cancelled' })]);
    const res: any = await svc.markPaid('order-1', { userId: 'sa', role: 'seller' }, 'A');
    expect(res.orderPaid).toBe(true);
    expect(orderModel.updateOne.mock.calls[0][1].$set).toMatchObject({ isPaid: true, paymentStatus: 'paid' });
  });

  it('refuses a package that is already paid, cancelled, or not yet shipped (seller)', async () => {
    const paid = build([pkg('A', 'sa', { isPaid: true }), pkg('B', 'sb')]);
    await expect(paid.svc.markPaid('order-1', { userId: 'sa', role: 'seller' }, 'A')).rejects.toThrow(/already marked as paid/);
    const cancelled = build([pkg('A', 'sa', { status: 'cancelled' }), pkg('B', 'sb')]);
    await expect(cancelled.svc.markPaid('order-1', { userId: 'sa', role: 'seller' }, 'A')).rejects.toThrow(/cancelled/);
    const pending = build([pkg('A', 'sa', { status: 'pending' }), pkg('B', 'sb')]);
    await expect(pending.svc.markPaid('order-1', { userId: 'sa', role: 'seller' }, 'A')).rejects.toThrow(/shipped or delivered/);
  });

  it('an Edudeen-fulfilled package is confirmed by an admin only', async () => {
    const { svc, orderModel } = build([pkg('A', 'sa', { fulfillmentMode: 'platform' }), pkg('B', 'sb')]);
    await expect(svc.markPaid('order-1', { userId: 'sa', role: 'seller' }, 'A')).rejects.toThrow(/Edudeen team/);
    expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    await expect(svc.markPaid('order-1', { userId: 'admin-1', role: 'admin' }, 'A')).resolves.toBeDefined();
  });

  it("a package whose cash goes to Edudeen's courier (codCollector 'platform') is admin-only even though the seller ships it", async () => {
    const { svc, orderModel, finance } = build([pkg('A', 'sa', { codCollector: 'platform' }), pkg('B', 'sb', { codCollector: 'seller' })]);
    await expect(svc.markPaid('order-1', { userId: 'sa', role: 'seller' }, 'A')).rejects.toThrow(/Payment on Edudeen-collected orders is confirmed by the Edudeen team/);
    expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    // the seller-collected sibling is still the seller's to confirm
    await expect(svc.markPaid('order-1', { userId: 'sb', role: 'seller' }, 'B')).resolves.toBeDefined();
    expect(finance.recordSaleDurable.mock.calls[0][0]).toMatchObject({ storeId: 'B', fulfillmentMode: 'seller' });
    // admin confirms the Edudeen-collected one: finance is told the cash side is the platform's
    await expect(svc.markPaid('order-1', { userId: 'admin-1', role: 'admin' }, 'A')).resolves.toBeDefined();
    expect(finance.recordSaleDurable.mock.calls[1][0]).toMatchObject({ storeId: 'A', fulfillmentMode: 'platform' });
  });

  it('single-package order with an Edudeen-collected package: the seller cannot mark it paid, admin can', async () => {
    const { svc } = build([pkg('A', 'sa', { codCollector: 'platform' })]);
    await expect(svc.markPaid('order-1', { userId: 'sa', role: 'seller' })).rejects.toThrow(/Edudeen-collected/);
    await expect(svc.markPaid('order-1', { userId: 'admin-1', role: 'admin' })).resolves.toBeDefined();
  });

  it('an old order without codCollector falls back to fulfillmentMode (seller -> seller may confirm)', async () => {
    const { svc } = build([pkg('A', 'sa', { codCollector: undefined }), pkg('B', 'sb')]);
    await expect(svc.markPaid('order-1', { userId: 'sa', role: 'seller' }, 'A')).resolves.toBeDefined();
  });

  it('a lost atomic claim (double click) credits nothing', async () => {
    const { svc, orderModel, finance } = build([pkg('A', 'sa'), pkg('B', 'sb')]);
    orderModel.findOneAndUpdate.mockResolvedValue(null);
    await expect(svc.markPaid('order-1', { userId: 'sa', role: 'seller' }, 'A')).rejects.toThrow(/already marked as paid/);
    expect(finance.recordSaleDurable).not.toHaveBeenCalled();
  });

  it('a single-seller COD order keeps the old whole-order behaviour (storeId not needed)', async () => {
    const { svc, orderModel } = build([pkg('A', 'sa')]);
    await svc.markPaid('order-1', { userId: 'sa', role: 'seller' });
    expect(orderModel.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ isPaid: true, paymentStatus: 'paid' });
  });
});
