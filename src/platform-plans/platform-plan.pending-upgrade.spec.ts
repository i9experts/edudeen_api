/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
import { SellerPlatformSubscriptionsService } from './seller-platform-subscriptions.service';

const PAID = { _id: 'plan-business', name: 'Business', isFree: false, monthlyPriceUSD: 49, yearlyPriceUSD: 490, stripeProductId: 'prod_1', stripeMonthlyPriceId: 'price_m', save: jest.fn() };
const FREE = { _id: 'plan-free', name: 'Free', isFree: true };

function build(gatewayStatus: 'active' | 'incomplete') {
  const sub: any = {
    _id: 'sub-1', storeId: 'store-1', sellerId: 'seller-1', platformPlanId: 'plan-free', billingInterval: 'monthly', amountUSD: 0,
    status: 'active', paymentProvider: 'manual', providerSubscriptionId: null, stripeCustomerId: null, pendingPlanChange: null,
    creditBalanceUSD: 0, totalPaidUSD: 0, planHistory: [], failedPaymentAttempts: 0,
    currentPeriodStart: new Date(Date.now() - 10 * 86400_000), currentPeriodEnd: new Date(Date.now() + 20 * 86400_000),
    cancelAtPeriodEnd: false, save: jest.fn().mockResolvedValue(undefined),
  };
  const planModel: any = {
    // findById is awaited directly in changePlan but chained with .lean() in the webhook handler
    findById: jest.fn().mockImplementation((id: string) => {
      const plan = id === 'plan-free' ? FREE : PAID;
      return Object.assign(Promise.resolve(plan), { lean: () => Promise.resolve(plan) });
    }),
    findOne: jest.fn().mockImplementation(async (filter: any) => (filter?.isFree ? FREE : PAID)),
  };
  const subModel: any = { findOne: jest.fn().mockResolvedValue(sub) };
  const invoiceModel: any = { exists: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ _id: 'inv-1' }) };
  const repos: any = {
    platformPlanModel: planModel, sellerPlatformSubscriptionModel: subModel, platformPlanInvoiceModel: invoiceModel,
    sellerModel: { findById: jest.fn().mockResolvedValue({ stripeCustomerId: 'cus_1', email: 'a@b.co', name: 'S', save: jest.fn() }) },
    storeModel: {}, platformPlanPaymentAttemptModel: { create: jest.fn(), countDocuments: jest.fn().mockResolvedValue(0) },
    subscriptionCounterModel: { findOneAndUpdate: jest.fn().mockResolvedValue({ seq: 1 }) },
  };
  const gateway: any = {
    isProviderDrivenBilling: true,
    createProviderSubscription: jest.fn().mockResolvedValue({ providerSubscriptionId: 'sub_stripe_new', status: gatewayStatus, clientSecret: gatewayStatus === 'active' ? undefined : 'cs_1' }),
    cancelProviderSubscription: jest.fn().mockResolvedValue(undefined),
  };
  const svc: any = new SellerPlatformSubscriptionsService({ repositories: repos } as any, gateway, { log: jest.fn() } as any, {} as any, {} as any);
  jest.spyOn(svc, 'verifyStoreOwnership').mockResolvedValue({});
  jest.spyOn(svc, 'syncFeaturedBadge').mockResolvedValue(undefined);
  return { svc, sub, gateway, invoiceModel };
}

describe('Platform plan first paid purchase (Stripe)', () => {
  it('does NOT grant the paid plan while payment is unconfirmed — entitlements keep following the current plan', async () => {
    const { svc, sub } = build('incomplete');
    const res: any = await svc.changePlan('seller-1', 'store-1', { platformPlanId: 'plan-business', billingInterval: 'monthly' });
    expect(res.data.requiresAction).toBe(true);
    expect(sub.platformPlanId).toBe('plan-free'); // <- the exploit: abandoning the payment sheet used to leave this on Business
    expect(sub.amountUSD).toBe(0);
    expect(sub.providerSubscriptionId).toBeNull();
    expect(sub.pendingPlanChange).toMatchObject({ platformPlanId: 'plan-business', providerSubscriptionId: 'sub_stripe_new' });
  });

  it('applies the plan only when Stripe reports the invoice paid', async () => {
    const { svc, sub } = build('incomplete');
    await svc.changePlan('seller-1', 'store-1', { platformPlanId: 'plan-business', billingInterval: 'monthly' });
    await svc.handleInvoicePaymentSucceeded({ id: 'in_1', subscription: 'sub_stripe_new', amount_paid: 4900, billing_reason: 'subscription_create', lines: { data: [] } });
    expect(sub.platformPlanId).toBe('plan-business');
    expect(sub.amountUSD).toBe(49);
    expect(sub.providerSubscriptionId).toBe('sub_stripe_new');
    expect(sub.paymentProvider).toBe('stripe');
    expect(sub.pendingPlanChange).toBeNull();
    expect(sub.status).toBe('active');
    expect(sub.planHistory).toHaveLength(1);
  });

  it('a failed FIRST payment leaves the store on its current plan and is not treated as dunning', async () => {
    const { svc, sub } = build('incomplete');
    await svc.changePlan('seller-1', 'store-1', { platformPlanId: 'plan-business', billingInterval: 'monthly' });
    const dunning = jest.spyOn(svc, 'applyDunningFailure');
    await svc.handleInvoicePaymentFailed({ id: 'in_1', subscription: 'sub_stripe_new', amount_due: 4900 });
    expect(dunning).not.toHaveBeenCalled();
    expect(sub.platformPlanId).toBe('plan-free');
  });

  it('starting a second upgrade cancels the abandoned first Stripe subscription (no orphan billing)', async () => {
    const { svc, sub, gateway } = build('incomplete');
    await svc.changePlan('seller-1', 'store-1', { platformPlanId: 'plan-business', billingInterval: 'monthly' });
    gateway.createProviderSubscription.mockResolvedValue({ providerSubscriptionId: 'sub_stripe_second', status: 'incomplete', clientSecret: 'cs_2' });
    await svc.changePlan('seller-1', 'store-1', { platformPlanId: 'plan-business', billingInterval: 'monthly' });
    expect(gateway.cancelProviderSubscription).toHaveBeenCalledWith('sub_stripe_new');
    expect(sub.pendingPlanChange.providerSubscriptionId).toBe('sub_stripe_second');
  });

  it('when Stripe already collected payment (saved card) the plan applies immediately, as before', async () => {
    const { svc, sub } = build('active');
    await svc.changePlan('seller-1', 'store-1', { platformPlanId: 'plan-business', billingInterval: 'monthly' });
    expect(sub.platformPlanId).toBe('plan-business');
    expect(sub.providerSubscriptionId).toBe('sub_stripe_new');
    expect(sub.pendingPlanChange).toBeNull();
  });
});

describe('downgradeToFree stops Stripe billing', () => {
  it('cancels the provider subscription when dunning/cancellation lands the store on the free plan', async () => {
    const { svc, sub, gateway } = build('active');
    sub.providerSubscriptionId = 'sub_live';
    await svc.downgradeToFree(sub);
    expect(gateway.cancelProviderSubscription).toHaveBeenCalledWith('sub_live');
    expect(sub.providerSubscriptionId).toBeNull();
    expect(sub.platformPlanId).toBe('plan-free');
  });
});
