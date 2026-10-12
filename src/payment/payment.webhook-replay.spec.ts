/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { PaymentService } from './payment.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

const item = (storeId: string, n: number) => ({
  productId: `p${n}`,
  variantId: `v${n}`,
  storeId,
  type: 'digital',
  name: `Item ${n}`,
  quantity: 1,
  price: 25,
  totalPrice: 25,
  currency: 'PKR',
});

function setup() {
  const tx: any = {
    _id: 'tx1',
    userId: 'u1',
    checkoutId: 'c1',
    stripePaymentIntentId: 'pi_1',
    status: 'pending',
    amount: 50,
    paymentScope: 'full',
    orderIds: [],
  };
  const checkout: any = {
    _id: 'c1',
    userId: 'u1',
    status: 'pending',
    currency: 'PKR',
    totalAmount: 50,
    fxSnapshots: [],
    items: [item('A', 1), item('B', 2)],
  };
  const paymentTransactionModel: any = {
    // atomic claim, like Mongo's findOneAndUpdate on the status field
    findOneAndUpdate: jest.fn(async (filter: any, update: any) => {
      if (!filter.status.$in.includes(tx.status)) return null;
      Object.assign(tx, update);
      return tx;
    }),
    findOne: jest.fn(async () => tx),
    findByIdAndUpdate: jest.fn(async (_id: string, u: any) => {
      Object.assign(tx, u);
      return tx;
    }),
  };
  const checkoutModel: any = {
    findOne: jest.fn(async () => checkout),
    findByIdAndUpdate: jest.fn(async (_id: string, u: any) => {
      Object.assign(checkout, u);
      return checkout;
    }),
  };
  const seenEvents = new Set<string>();
  const stripeWebhookEventModel: any = {
    create: jest.fn(async ({ eventId }: any) => {
      if (seenEvents.has(eventId))
        throw Object.assign(new Error('dup'), { code: 11000 });
      seenEvents.add(eventId);
    }),
    deleteOne: jest.fn(),
  };
  const repos: any = {
    paymentTransactionModel,
    checkoutModel,
    stripeWebhookEventModel,
    orderModel: {},
    addressModel: {},
    cartModel: {},
  };
  const svc: any = Object.create(PaymentService.prototype);
  Object.assign(svc, {
    databaseService: { repositories: repos },
    exchangeRateService: new ExchangeRateService(
      {} as any,
      {} as any,
      {} as any,
    ),
    activityLogService: { log: jest.fn() },
    configService: { get: jest.fn(() => 'whsec_test') },
    isLiveMode: false,
  });
  svc.createOrder = jest.fn(async () => [
    { _id: 'o-digital-A' },
    { _id: 'o-digital-B' },
  ]);
  svc.removeCheckedOutItemsFromCart = jest.fn().mockResolvedValue(undefined);
  return { svc, tx, checkout, repos };
}
const pi = { id: 'pi_1', amount: 5000, currency: 'pkr' };

describe('Stripe payment_intent.succeeded — replay and concurrency', () => {
  it('the webhook and the client-polling fallback finalizing at the same moment create the orders exactly once', async () => {
    const { svc } = setup();
    const results = await Promise.all([
      svc.finalizePaymentIntent(pi),
      svc.finalizePaymentIntent(pi),
      svc.finalizePaymentIntent(pi),
    ]);
    expect(svc.createOrder).toHaveBeenCalledTimes(1);
    expect(svc.removeCheckedOutItemsFromCart).toHaveBeenCalledTimes(1);
    expect(results.filter(Boolean)).toHaveLength(3); // every caller gets an answer, only one did the work
  });

  it('a replay after completion returns the stored order ids and does nothing', async () => {
    const { svc, tx } = setup();
    await svc.finalizePaymentIntent(pi);
    tx.orderIds = ['o-digital-A', 'o-digital-B'];
    const again = await svc.finalizePaymentIntent(pi);
    expect(again).toEqual({ orderIds: ['o-digital-A', 'o-digital-B'] });
    expect(svc.createOrder).toHaveBeenCalledTimes(1);
  });

  it('a redelivered Stripe event id is dropped before any processing', async () => {
    const { svc } = setup();
    const event = {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: pi },
    };
    svc.assertStripeConfigured = jest.fn(() => ({
      webhooks: { constructEvent: jest.fn(() => event) },
    }));
    svc.finalizePaymentIntent = jest.fn().mockResolvedValue({ orderIds: [] });
    await svc.stripeWebhook(Buffer.from('{}'), 'sig');
    await svc.stripeWebhook(Buffer.from('{}'), 'sig');
    await svc.stripeWebhook(Buffer.from('{}'), 'sig');
    expect(svc.finalizePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('a charge whose amount differs from the checkout total creates no order and is flagged for review', async () => {
    const { svc, repos } = setup();
    await expect(
      svc.finalizePaymentIntent({ ...pi, amount: 4000 }),
    ).rejects.toThrow(/mismatch/);
    expect(svc.createOrder).not.toHaveBeenCalled();
    expect(
      repos.paymentTransactionModel.findByIdAndUpdate,
    ).toHaveBeenCalledWith('tx1', { status: 'pending', paidAt: null }); // claim released
  });
});
