/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { jazzcashSecureHash } from './providers/jazzcash.provider';

const ENV = { JAZZCASH_MERCHANT_ID: 'MC1', JAZZCASH_PASSWORD: 'pw', JAZZCASH_INTEGRITY_SALT: 'salt', API_PUBLIC_URL: 'https://api.test' };

function makeService(txStatus = 'pending') {
  const checkout: any = { _id: 'c1', userId: 'u1', status: 'payment_pending', currency: 'PKR', totalAmount: 1250, expiredAt: null, fxSnapshots: [], items: [{ type: 'digital', storeId: 's1', variantId: 'v1', quantity: 1, name: 'Book' }] };
  const tx: any = { _id: 't1', userId: 'u1', checkoutId: 'c1', paymentType: 'jazzcash', providerTxnRef: 'T1', status: txStatus, orderIds: txStatus === 'completed' ? ['o1'] : [] };
  const paymentTransactionModel: any = {
    findOne: jest.fn((f: any) => { const r = f.providerTxnRef === 'T1' ? tx : null; return Object.assign(Promise.resolve(r), { lean: () => Promise.resolve(r) }); }),
    findOneAndUpdate: jest.fn(async (f: any, u: any) => {
      if (f.providerTxnRef === 'T1' && f.status.$in.includes(tx.status)) { Object.assign(tx, u); return tx; }
      return null;
    }),
    findByIdAndUpdate: jest.fn(async (_id: any, u: any) => { Object.assign(tx, u); return tx; }),
    updateOne: jest.fn(async (_f: any, u: any) => { Object.assign(tx, u); return {}; }),
    updateMany: jest.fn(), create: jest.fn(), exists: jest.fn(),
  };
  const checkoutModel: any = { findOne: jest.fn().mockResolvedValue(checkout), findByIdAndUpdate: jest.fn().mockResolvedValue({}) };
  const repos: any = { paymentTransactionModel, checkoutModel, orderModel: {}, addressModel: {}, cartModel: {} };
  const activity = { log: jest.fn() };
  const svc: any = new PaymentService({ repositories: repos } as any, {} as any, { get: jest.fn() } as any, {} as any, {} as any, {} as any, { convertWithSnapshots: (n: number) => n } as any, activity as any, {} as any, {} as any, {} as any);
  svc.createOrder = jest.fn().mockResolvedValue([{ _id: { toString: () => 'o1' } }]);
  svc.removeCheckedOutItemsFromCart = jest.fn().mockResolvedValue(undefined);
  return { svc, tx, activity, checkout };
}

const signed = (over: Record<string, string> = {}) => {
  const p: Record<string, string> = { pp_TxnRefNo: 'T1', pp_Amount: '125000', pp_ResponseCode: '000', ...over };
  p.pp_SecureHash = jazzcashSecureHash(p, 'salt');
  return p;
};

describe('hosted (JazzCash) payment', () => {
  it('refuses to start when the provider is not configured', async () => {
    const { svc } = makeService();
    await expect(svc.startHostedPayment('u1', 'c1', 'jazzcash', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a verified, matching callback places the order exactly once (idempotent)', async () => {
    const { svc, tx } = makeService();
    const out = await svc.handleHostedCallback('jazzcash', signed(), ENV);
    expect(out).toEqual({ outcome: 'success', checkoutId: 'c1' });
    expect(svc.createOrder).toHaveBeenCalledTimes(1);
    expect(svc.createOrder.mock.calls[0][4]).toEqual({ paymentType: 'jazzcash', isPaid: true });
    expect(tx.status).toBe('completed');
    await svc.handleHostedCallback('jazzcash', signed(), ENV);
    expect(svc.createOrder).toHaveBeenCalledTimes(1);
  });

  it('a forged callback never creates an order', async () => {
    const { svc } = makeService();
    const forged = { ...signed(), pp_Amount: '1' };
    expect((await svc.handleHostedCallback('jazzcash', forged, ENV)).outcome).toBe('invalid');
    expect(svc.createOrder).not.toHaveBeenCalled();
  });

  it('a declined payment marks the attempt failed and creates nothing', async () => {
    const { svc, tx } = makeService();
    expect((await svc.handleHostedCallback('jazzcash', signed({ pp_ResponseCode: '124' }), ENV)).outcome).toBe('failed');
    expect(tx.status).toBe('failed');
    expect(svc.createOrder).not.toHaveBeenCalled();
  });

  it('an amount that does not match the checkout total is held for review, no order', async () => {
    const { svc, activity, tx } = makeService();
    await expect(svc.handleHostedCallback('jazzcash', signed({ pp_Amount: '100' }), ENV)).rejects.toThrow(/mismatch/);
    expect(svc.createOrder).not.toHaveBeenCalled();
    expect(tx.status).toBe('pending');
    expect(activity.log).toHaveBeenCalled();
  });
});
