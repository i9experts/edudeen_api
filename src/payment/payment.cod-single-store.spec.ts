/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';

const physical = (storeId: string, n: number) => ({
  type: 'physical',
  storeId,
  variantId: `v${n}`,
  quantity: 1,
  name: `Book ${n}`,
  totalPrice: 10,
  currency: 'USD',
});
const digital = (storeId: string, n: number) => ({
  type: 'digital',
  storeId,
  variantId: `v${n}`,
  quantity: 1,
  name: `Course ${n}`,
  totalPrice: 10,
  currency: 'USD',
});

function makeService(items: any[]) {
  const checkout: any = {
    _id: 'c1',
    userId: 'u1',
    status: 'pending',
    expiredAt: null,
    currency: 'USD',
    totalAmount: 50,
    orderPlacementStartedAt: null,
    fxSnapshots: [],
    items,
  };
  const repos: any = {
    checkoutModel: {
      findOne: jest.fn().mockImplementation(async () => ({ ...checkout })),
      findOneAndUpdate: jest
        .fn()
        .mockImplementation(async () => ({ ...checkout })),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({}),
    },
    storeModel: {
      find: jest
        .fn()
        .mockReturnValue({
          select: jest
            .fn()
            .mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
        }),
    },
    productVariantModel: {
      findOne: jest
        .fn()
        .mockResolvedValue({ stock: 10, unlimitedStock: false }),
    },
    paymentTransactionModel: {
      create: jest.fn().mockResolvedValue({}),
      findOne: jest.fn().mockResolvedValue(null),
    },
    orderModel: {},
    addressModel: {},
    cartModel: {},
  };
  const svc: any = new PaymentService(
    { repositories: repos } as any,
    {} as any,
    { get: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { log: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
  );
  svc.createOrder = jest.fn().mockResolvedValue([{ _id: 'o1' }]);
  svc.removeCheckedOutItemsFromCart = jest.fn().mockResolvedValue(undefined);
  svc.formatOrder = jest.fn((o) => o);
  svc.assertStripeConfigured = jest.fn(() => {
    throw new Error('reached Stripe'); // anything past the COD checks surfaces here
  });
  return { svc, repos };
}

describe('Cash on Delivery requires all physical items from ONE store (enforced server-side)', () => {
  it('codPayment: physical items from two stores are rejected and nothing is placed', async () => {
    const { svc } = makeService([physical('A', 1), physical('B', 2)]);
    await expect(svc.codPayment('u1', { checkoutId: 'c1' })).rejects.toThrow(
      /only available when all physical items are from one store/,
    );
    await expect(
      svc.codPayment('u1', { checkoutId: 'c1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.createOrder).not.toHaveBeenCalled();
  });

  it('codPayment: several items from a single store still work (regression)', async () => {
    const { svc } = makeService([physical('A', 1), physical('A', 2)]);
    await expect(
      svc.codPayment('u1', { checkoutId: 'c1' }),
    ).resolves.toBeDefined();
    expect(svc.createOrder).toHaveBeenCalledTimes(1);
  });

  it("initiatePayment 'split': physical items from two stores are rejected before any Stripe call", async () => {
    // assertStripeConfigured is the first call in initiatePayment; make it harmless so the split check is reachable
    const { svc } = makeService([
      physical('A', 1),
      physical('B', 2),
      digital('C', 3),
    ]);
    svc.assertStripeConfigured = jest.fn(() => ({}));
    await expect(
      svc.initiatePayment('u1', { checkoutId: 'c1', paymentMode: 'split' }),
    ).rejects.toThrow(
      /only available when all physical items are from one store/,
    );
  });

  it("initiatePayment 'split': a single physical store plus digital passes the COD check (and is not rejected for it)", async () => {
    const { svc } = makeService([physical('A', 1), digital('C', 3)]);
    svc.assertStripeConfigured = jest.fn(() => ({}));
    const err: any = await svc
      .initiatePayment('u1', { checkoutId: 'c1', paymentMode: 'split' })
      .catch((e: any) => e);
    expect(String(err?.message)).not.toMatch(
      /only available when all physical items are from one store/,
    );
  });

  it("initiatePayment 'full' (pay everything online) is allowed for a multi-store physical cart", async () => {
    const { svc } = makeService([physical('A', 1), physical('B', 2)]);
    svc.assertStripeConfigured = jest.fn(() => ({}));
    const err: any = await svc
      .initiatePayment('u1', { checkoutId: 'c1', paymentMode: 'full' })
      .catch((e: any) => e);
    expect(String(err?.message)).not.toMatch(/Cash on Delivery/);
  });
});
