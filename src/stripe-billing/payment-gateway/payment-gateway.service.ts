/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IPaymentGateway, ChargeResult, CreateProviderSubResult, ChargeContext,
  CreateCustomerResult, SetupIntentResult, BillingPortalResult, CheckoutSessionResult, RefundResult,
} from './payment-gateway.interface';
import { ManualPaymentProvider } from './manual-payment.provider';
import { StripePaymentProvider } from './stripe-payment.provider';

/**
 * PaymentGatewayService — Stripe is the single production payment provider.
 *
 * PAYMENT_PROVIDER=stripe  → StripePaymentProvider (default — real Stripe;
 *   test vs. live mode is controlled entirely by which STRIPE_SECRET_KEY
 *   value is configured, sk_test_... vs sk_live_..., never by code).
 * PAYMENT_PROVIDER=manual  → ManualPaymentProvider, a no-op stub that moves
 *   no real money — kept ONLY as an explicit local-dev/CI opt-in (refuses to
 *   start under NODE_ENV=production) so tests never need live Stripe
 *   credentials; it is not a second real payment provider.
 */
@Injectable()
export class PaymentGatewayService implements IPaymentGateway, OnModuleInit {
  private readonly logger = new Logger(PaymentGatewayService.name);
  private readonly provider: IPaymentGateway;
  readonly providerName: 'manual' | 'stripe';

  constructor(private readonly config: ConfigService) {
    this.providerName = (config.get<string>('PAYMENT_PROVIDER') as 'manual' | 'stripe') ?? 'stripe';

    if (this.providerName === 'manual' && config.get<string>('NODE_ENV') === 'production') {
      throw new Error('PAYMENT_PROVIDER=manual is not allowed in production — Stripe is the only supported production payment provider. Set PAYMENT_PROVIDER=stripe (or leave it unset) with a real STRIPE_SECRET_KEY.');
    }

    if (this.providerName === 'stripe') {
      const secretKey = config.get<string>('STRIPE_SECRET_KEY');
      if (!secretKey) {
        throw new Error('PAYMENT_PROVIDER=stripe requires STRIPE_SECRET_KEY to be set in the environment');
      }
      this.provider = new StripePaymentProvider(secretKey);
    } else {
      this.provider = new ManualPaymentProvider();
    }
  }

  onModuleInit() {
    this.logger.log(`Subscription billing running on payment provider: "${this.providerName}"`);
    if (this.providerName === 'manual') {
      this.logger.warn('PAYMENT_PROVIDER=manual — no real money will move. This is a dev/CI-only stub; production always requires PAYMENT_PROVIDER=stripe.');
    }
  }

  /** True when the active provider bills subscriptions itself via its own async webhook-driven cycle (Stripe), as opposed to our own cron actively charging (manual). */
  get isProviderDrivenBilling(): boolean {
    return this.providerName === 'stripe';
  }

  /** Exposes the raw Stripe client for webhook signature verification — undefined for the manual provider. */
  get stripeClient() {
    return this.provider instanceof StripePaymentProvider ? this.provider.client : undefined;
  }

  chargeSubscription(subscriptionId: string, amountUSD: number, context?: ChargeContext): Promise<ChargeResult> {
    return this.provider.chargeSubscription(subscriptionId, amountUSD, context);
  }

  createProviderSubscription(
    subscriptionId: string,
    planName: string,
    amountUSD: number,
    interval: string,
    context?: ChargeContext,
  ): Promise<CreateProviderSubResult> {
    return this.provider.createProviderSubscription(subscriptionId, planName, amountUSD, interval, context);
  }

  cancelProviderSubscription(providerSubscriptionId: string): Promise<void> {
    return this.provider.cancelProviderSubscription(providerSubscriptionId);
  }

  scheduleProviderCancellation(providerSubscriptionId: string): Promise<void> {
    return this.provider.scheduleProviderCancellation(providerSubscriptionId);
  }

  unscheduleProviderCancellation(providerSubscriptionId: string): Promise<void> {
    return this.provider.unscheduleProviderCancellation(providerSubscriptionId);
  }

  getOrCreateCustomer(customerId: string, email: string, name: string): Promise<CreateCustomerResult> {
    return this.provider.getOrCreateCustomer(customerId, email, name);
  }

  createSetupIntent(providerCustomerId: string): Promise<SetupIntentResult> {
    return this.provider.createSetupIntent(providerCustomerId);
  }

  createBillingPortalSession(providerCustomerId: string, returnUrl: string): Promise<BillingPortalResult> {
    return this.provider.createBillingPortalSession(providerCustomerId, returnUrl);
  }

  createCheckoutSession(params: {
    providerCustomerId: string; providerPriceId: string; successUrl: string; cancelUrl: string; metadata?: Record<string, string>;
  }): Promise<CheckoutSessionResult> {
    return this.provider.createCheckoutSession(params);
  }

  refund(providerChargeId: string, amountUSD: number, reason?: string, idempotencyKey?: string): Promise<RefundResult> {
    return this.provider.refund(providerChargeId, amountUSD, reason, idempotencyKey);
  }

  updateProviderSubscriptionPrice(
    providerSubscriptionId: string,
    newProviderPriceId: string,
    prorationBehavior: 'create_prorations' | 'none' | 'always_invoice',
  ): Promise<{ latestInvoiceId?: string }> {
    return this.provider.updateProviderSubscriptionPrice(providerSubscriptionId, newProviderPriceId, prorationBehavior);
  }

  getOrCreatePrice(params: {
    planId: string; planName: string; storeId: string;
    amountUSD: number; interval: 'monthly' | 'yearly';
    existingProductId?: string | null; existingPriceId?: string | null;
  }): Promise<{ providerProductId: string; providerPriceId: string }> {
    return this.provider.getOrCreatePrice(params);
  }
}
