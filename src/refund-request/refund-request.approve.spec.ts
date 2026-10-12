/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { RefundRequestService } from './refund-request.service';

const ORDER_ID = 'order-1';
const SO_ID = 'so-1';

function build(
  orderOverrides: any = {},
  soOverrides: any = {},
  fxThrows = false,
) {
  const item = {
    _id: { toString: () => 'item-1' },
    name: 'Worksheet',
    type: 'digital',
    status: 'completed',
    totalPrice: 20,
    refundedAmount: 0,
  };
  const sellerOrder = {
    _id: { toString: () => SO_ID },
    storeId: 'store-1',
    sellerId: 'seller-1',
    settlementCurrency: 'USD',
    items: [item],
    ...soOverrides,
  };
  const order = {
    _id: { toString: () => ORDER_ID },
    orderNumber: 'ORD-1',
    currency: 'USD',
    isPaid: true,
    paymentType: 'cash_on_delivery',
    fxSnapshots: [],
    sellerOrders: [sellerOrder],
    ...orderOverrides,
  };
  const model: any = {
    findOne: jest
      .fn()
      .mockReturnValue({
        lean: jest.fn().mockResolvedValue({ storeId: 'store-1' }),
      }),
    findOneAndUpdate: jest
      .fn()
      .mockResolvedValue({
        _id: 'req-1',
        orderId: ORDER_ID,
        sellerOrderId: SO_ID,
        itemIds: ['item-1'],
      }),
    updateOne: jest.fn().mockResolvedValue({}),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  };
  const liveOrder: any = {
    sellerOrders: [{ ...sellerOrder, items: [{ ...item }] }],
    save: jest.fn(),
  };
  const repos: any = {
    orderModel: {
      findOne: jest.fn().mockResolvedValue(order),
      findById: jest.fn().mockResolvedValue(liveOrder),
    },
    storeModel: {
      findOne: jest
        .fn()
        .mockResolvedValue({ _id: 'store-1', sellerId: 'seller-1' }),
      findById: jest
        .fn()
        .mockResolvedValue({ _id: 'store-1', sellerId: 'seller-1' }),
    },
    productVariantModel: { updateOne: jest.fn() },
    paymentTransactionModel: { findOne: jest.fn() },
    refundRequestModel: model,
  };
  const finance: any = { recordRefund: jest.fn().mockResolvedValue(undefined) };
  // The services now go through recordRefundForSellerOrder; for non-COD orders it is exactly recordRefund.
  finance.recordRefundForSellerOrder = jest.fn((a: any) =>
    finance.recordRefund(
      a.storeId,
      a.sellerId,
      a.orderId,
      a.sellerDebitAmount,
      a.actorId,
      a.actorRole,
      {
        description: a.description,
        targetType: a.targetType,
        currency: a.currency,
      },
    ),
  );
  const fx: any = {
    convertWithSnapshots: jest.fn((a: number) => {
      if (fxThrows) throw new Error('missing fx snapshot');
      return a;
    }),
  };
  const activity: any = { log: jest.fn().mockResolvedValue(undefined) };
  const svc: any = new RefundRequestService(
    { repositories: repos } as any,
    finance,
    { restoreGiftCardForItems: jest.fn().mockResolvedValue(undefined) } as any,
    fx,
    activity,
  );
  return { svc, model, finance, liveOrder };
}

describe('RefundRequestService.approve', () => {
  it('debits the seller and marks items refunded for a paid order', async () => {
    const { svc, finance, liveOrder } = build();
    const res = await svc.approve('admin-1', 'admin', 'req-1');
    expect(finance.recordRefund).toHaveBeenCalledWith(
      'store-1',
      'seller-1',
      ORDER_ID,
      20,
      'admin-1',
      'admin',
      expect.objectContaining({ currency: 'USD' }),
    );
    expect(liveOrder.sellerOrders[0].items[0].status).toBe('refunded');
    expect(res.data.buyerRefundAmount).toBe(20);
  });

  it('a FREE order can be refunded: no money moves (no seller debit), but the item is marked refunded so digital access is revoked', async () => {
    const { svc, finance, liveOrder } = build(
      { paymentType: 'free' },
      {
        items: [
          {
            _id: { toString: () => 'item-1' },
            name: 'Free worksheet',
            type: 'digital',
            status: 'completed',
            totalPrice: 0,
            refundedAmount: 0,
          },
        ],
      },
    );
    liveOrder.sellerOrders[0].items[0].totalPrice = 0;
    const res = await svc.approve('admin-1', 'admin', 'req-1');
    expect(finance.recordRefund).not.toHaveBeenCalled();
    expect(finance.recordRefundForSellerOrder).not.toHaveBeenCalled();
    expect(liveOrder.sellerOrders[0].items[0].status).toBe('refunded');
    expect(res.data.buyerRefundAmount).toBe(0);
    expect(res.data.stripeRefundId).toBeNull();
  });

  it('but a PAID order with nothing left to refund is still refused', async () => {
    const { svc } = build(
      {},
      {
        items: [
          {
            _id: { toString: () => 'item-1' },
            name: 'W',
            type: 'digital',
            status: 'completed',
            totalPrice: 20,
            refundedAmount: 20,
          },
        ],
      },
    );
    await expect(svc.approve('admin-1', 'admin', 'req-1')).rejects.toThrow(
      /Nothing left to refund/,
    );
  });

  it('refuses to refund (or debit a seller for) an UNPAID order, and releases the claim', async () => {
    const { svc, model, finance } = build({ isPaid: false });
    await expect(svc.approve('admin-1', 'admin', 'req-1')).rejects.toThrow(
      /not been paid/,
    );
    expect(finance.recordRefund).not.toHaveBeenCalled();
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: 'req-1', status: 'approved' },
      { $set: expect.objectContaining({ status: 'pending' }) },
    );
  });

  it('a failure before the ledger debit returns the request to pending instead of stranding it approved', async () => {
    const { svc, model, finance } = build({}, {}, true);
    await expect(svc.approve('admin-1', 'admin', 'req-1')).rejects.toThrow(
      'missing fx snapshot',
    );
    expect(finance.recordRefund).not.toHaveBeenCalled();
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: 'req-1', status: 'approved' },
      { $set: expect.objectContaining({ status: 'pending' }) },
    );
  });

  it('a failed ledger debit also releases the claim', async () => {
    const { svc, model, finance } = build();
    finance.recordRefund.mockRejectedValue(new Error('txn aborted'));
    await expect(svc.approve('admin-1', 'admin', 'req-1')).rejects.toThrow(
      'txn aborted',
    );
    expect(model.updateOne).toHaveBeenCalled();
  });

  it('rejects items that were refunded or cancelled after the request was filed', async () => {
    const { svc, finance } = build(
      {},
      {
        items: [
          {
            _id: { toString: () => 'item-1' },
            name: 'X',
            type: 'digital',
            status: 'refunded',
            totalPrice: 20,
            refundedAmount: 20,
          },
        ],
      },
    );
    await expect(
      svc.approve('admin-1', 'admin', 'req-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(finance.recordRefund).not.toHaveBeenCalled();
  });

  it('caps the refund at what is still refundable (already partly refunded item)', async () => {
    const { svc, finance } = build(
      {},
      {
        items: [
          {
            _id: { toString: () => 'item-1' },
            name: 'X',
            type: 'digital',
            status: 'completed',
            totalPrice: 20,
            refundedAmount: 15,
          },
        ],
      },
    );
    const res = await svc.approve('admin-1', 'admin', 'req-1');
    expect(res.data.buyerRefundAmount).toBe(5);
    expect(finance.recordRefund.mock.calls[0][3]).toBe(5);
  });

  it('a second approve that loses the atomic claim refunds nothing', async () => {
    const { svc, model, finance } = build();
    model.findOneAndUpdate.mockResolvedValue(null);
    await expect(svc.approve('admin-1', 'admin', 'req-1')).rejects.toThrow(
      /already reviewed/,
    );
    expect(finance.recordRefund).not.toHaveBeenCalled();
  });
});
