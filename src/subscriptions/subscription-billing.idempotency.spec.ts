/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
import { SubscriptionsService } from './subscriptions.service';
import { SellerPlatformSubscriptionsService } from '../platform-plans/seller-platform-subscriptions.service';

const due = new Date('2026-10-01T00:00:00Z');

describe('Platform-plan renewal cron — no double charge for one billing period', () => {
  const build = (existingInvoice: any) => {
    const sub: any = {
      _id: 'sub-1', storeId: 'st1', sellerId: 'se1', platformPlanId: 'p1', billingInterval: 'monthly', amountUSD: 49, totalPaidUSD: 0,
      creditBalanceUSD: 0, failedPaymentAttempts: 0, status: 'active', stripeCustomerId: 'cus_1', nextBillingDate: due,
      save: jest.fn().mockResolvedValue(undefined),
    };
    const invoiceModel: any = { findOne: jest.fn().mockResolvedValue(existingInvoice), create: jest.fn().mockResolvedValue({ _id: 'inv-new' }) };
    const subModel: any = { find: jest.fn().mockResolvedValue([sub]) };
    const gateway: any = { chargeSubscription: jest.fn().mockResolvedValue({ success: true, providerChargeId: 'pi_1', paymentMethodType: 'card' }) };
    const repos: any = {
      sellerPlatformSubscriptionModel: subModel, platformPlanInvoiceModel: invoiceModel,
      platformPlanPaymentAttemptModel: { create: jest.fn(), countDocuments: jest.fn().mockResolvedValue(0) },
      subscriptionCounterModel: { findOneAndUpdate: jest.fn().mockResolvedValue({ seq: 1 }) },
    };
    const svc: any = new SellerPlatformSubscriptionsService({ repositories: repos } as any, gateway, { log: jest.fn() } as any, {} as any, {} as any);
    return { svc, sub, gateway, invoiceModel, subModel };
  };

  it('charges with a key derived from the subscription + the due date, and passes the Stripe customer', async () => {
    const { svc, gateway } = build(null);
    await svc.processRenewals();
    expect(gateway.chargeSubscription).toHaveBeenCalledWith('sub-1', 49, { providerCustomerId: 'cus_1', idempotencyKey: `platform_renew_sub-1_${due.getTime()}` });
  });

  it('a retry of the same period (crash after charge, before save) reuses the existing invoice instead of creating another', async () => {
    const { svc, invoiceModel, sub } = build({ _id: 'inv-old' });
    await svc.processRenewals();
    expect(invoiceModel.create).not.toHaveBeenCalled();
    expect(sub.save).toHaveBeenCalled(); // but the subscription state IS finished
  });

  it('only manual-provider subscriptions without a Stripe subscription are picked up by the cron', async () => {
    const { svc, subModel } = build(null);
    await svc.processRenewals();
    expect(subModel.find).toHaveBeenCalledWith(expect.objectContaining({ paymentProvider: 'manual', providerSubscriptionId: null }));
  });
});

describe('Buyer subscription seller-payout crediting', () => {
  const make = (claim: any) => {
    const invoiceModel: any = { findOneAndUpdate: jest.fn().mockResolvedValue(claim), updateOne: jest.fn().mockResolvedValue({}) };
    const finance: any = { recordSubscriptionRevenue: jest.fn().mockResolvedValue(undefined) };
    const svc: any = Object.create(SubscriptionsService.prototype);
    Object.assign(svc, { db: { repositories: { subscriptionInvoiceModel: invoiceModel } }, financeService: finance, platformCommissionRate: 0.1, logger: { error: jest.fn() } });
    Object.defineProperty(svc, 'invoiceModel', { get: () => invoiceModel });
    return { svc, invoiceModel, finance };
  };
  const invoice: any = { _id: 'inv-1', storeId: 's1', sellerId: 'x', amountUSD: 20, invoiceNumber: 'INV-1', payoutCredited: false };

  it('credits once: a caller that loses the atomic flag claim credits nothing', async () => {
    const { svc, finance } = make(null);
    await svc.creditSellerPayout(invoice);
    expect(finance.recordSubscriptionRevenue).not.toHaveBeenCalled();
  });

  it('the winning caller credits the seller share (amount - commission)', async () => {
    const { svc, finance } = make({ _id: 'inv-1' });
    await svc.creditSellerPayout(invoice);
    expect(finance.recordSubscriptionRevenue).toHaveBeenCalledWith('s1', 'x', 'inv-1', 18, 2, expect.any(String));
  });

  it('a ledger failure releases the claim so a later retry can credit (the ledger call is idempotent per invoice)', async () => {
    const { svc, finance, invoiceModel } = make({ _id: 'inv-1' });
    finance.recordSubscriptionRevenue.mockRejectedValue(new Error('txn aborted'));
    await svc.creditSellerPayout(invoice);
    expect(invoiceModel.updateOne).toHaveBeenCalledWith({ _id: 'inv-1' }, { $set: { payoutCredited: false } });
  });
});
