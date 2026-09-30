/* eslint-disable prettier/prettier */
import {
  IPaymentGateway, ChargeResult, CreateProviderSubResult, ChargeContext,
  CreateCustomerResult, SetupIntentResult, BillingPortalResult, CheckoutSessionResult, RefundResult,
} from './payment-gateway.interface';

/**
 * ManualPaymentProvider — mock/simulation provider.
 *
 * Always returns success so the full billing flow can be exercised end-to-end
 * without a real payment gateway. Used for local development, CI, and any
 * deployment where PAYMENT_PROVIDER is unset or explicitly 'manual'. Every
 * "provider object" it returns is a fake id — no external call is ever made.
 */
export class ManualPaymentProvider implements IPaymentGateway {
  private fakeId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  async chargeSubscription(subscriptionId: string, amountUSD: number, _context?: ChargeContext): Promise<ChargeResult> {
    const providerChargeId = this.fakeId('manual_chg');
    console.log(`[ManualPayment] Simulated charge: $${amountUSD.toFixed(2)} USD | sub=${subscriptionId} | chargeId=${providerChargeId}`);
    return { success: true, providerChargeId, paymentMethodType: 'manual', currency: 'usd' };
  }

  async createProviderSubscription(
    subscriptionId: string,
    planName: string,
    amountUSD: number,
    interval: string,
    _context?: ChargeContext,
  ): Promise<CreateProviderSubResult> {
    const providerSubscriptionId = this.fakeId('manual_sub');
    console.log(`[ManualPayment] Simulated subscription: ${planName} $${amountUSD.toFixed(2)}/${interval} | sub=${subscriptionId} | provId=${providerSubscriptionId}`);
    return { providerSubscriptionId, status: 'active' };
  }

  async cancelProviderSubscription(providerSubscriptionId: string): Promise<void> {
    console.log(`[ManualPayment] Simulated cancellation: provId=${providerSubscriptionId}`);
  }

  async scheduleProviderCancellation(providerSubscriptionId: string): Promise<void> {
    console.log(`[ManualPayment] Simulated schedule-cancellation: provId=${providerSubscriptionId}`);
  }

  async unscheduleProviderCancellation(providerSubscriptionId: string): Promise<void> {
    console.log(`[ManualPayment] Simulated unschedule-cancellation: provId=${providerSubscriptionId}`);
  }

  async getOrCreateCustomer(customerId: string, email: string, _name: string): Promise<CreateCustomerResult> {
    return { providerCustomerId: `manual_cus_${customerId}` };
  }

  async createSetupIntent(providerCustomerId: string): Promise<SetupIntentResult> {
    return { clientSecret: this.fakeId('manual_seti_secret'), setupIntentId: this.fakeId('manual_seti') };
  }

  async createBillingPortalSession(providerCustomerId: string, returnUrl: string): Promise<BillingPortalResult> {
    // No real portal exists for the manual provider — send the buyer straight back.
    return { url: returnUrl };
  }

  async createCheckoutSession(): Promise<CheckoutSessionResult> {
    return { url: '', sessionId: this.fakeId('manual_cs') };
  }

  async refund(providerChargeId: string, amountUSD: number): Promise<RefundResult> {
    console.log(`[ManualPayment] Simulated refund: $${amountUSD.toFixed(2)} USD | chargeId=${providerChargeId}`);
    return { success: true, providerRefundId: this.fakeId('manual_re') };
  }

  async updateProviderSubscriptionPrice(): Promise<{ latestInvoiceId?: string }> {
    return {};
  }

  async getOrCreatePrice(params: { planId: string }): Promise<{ providerProductId: string; providerPriceId: string }> {
    return { providerProductId: `manual_prod_${params.planId}`, providerPriceId: `manual_price_${params.planId}` };
  }
}
