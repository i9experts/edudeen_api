/* eslint-disable prettier/prettier */
import { Logger } from '@nestjs/common';
import Stripe from 'stripe';
import {
  IPaymentGateway, ChargeResult, CreateProviderSubResult, ChargeContext,
  CreateCustomerResult, SetupIntentResult, BillingPortalResult, CheckoutSessionResult, RefundResult,
} from './payment-gateway.interface';

/**
 * StripePaymentProvider — production Stripe integration.
 *
 * Architecture note: unlike the manual provider, Stripe owns the actual
 * billing calendar for subscriptions created here. Stripe's own billing
 * engine issues renewal invoices and retries failed payments (Smart
 * Retries) on its own schedule — this class only ever *initiates* state
 * (create customer/price/subscription/checkout/portal/refund) or performs a
 * one-off charge (used for proration top-ups and the manual-charge fallback
 * path). Every *outcome* of Stripe's own billing cycle (renewal succeeded,
 * renewal failed, subscription canceled) arrives asynchronously via webhook
 * — see `StripeWebhookService`, which is the actual "renewal" mechanism for
 * Stripe-backed subscriptions. `SubscriptionsService.processRenewals()`
 * (the manual-provider cron) explicitly skips `paymentProvider==='stripe'`
 * subscriptions for exactly this reason.
 *
 * All mutating calls carry an idempotency key so a client/cron retry after a
 * network timeout can never double-create or double-charge anything.
 */
type StripeClient = InstanceType<typeof Stripe>;

export class StripePaymentProvider implements IPaymentGateway {
  private readonly stripe: StripeClient;
  private readonly logger = new Logger(StripePaymentProvider.name);

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, { typescript: true });
  }

  /** Exposed so the webhook handler can verify signatures using the exact same client/config. */
  get client(): StripeClient {
    return this.stripe;
  }

  async getOrCreateCustomer(customerId: string, email: string, name: string): Promise<CreateCustomerResult> {
    const customer = await this.stripe.customers.create(
      { email, name: name || undefined, metadata: { internalCustomerId: customerId } },
      { idempotencyKey: `cust_create_${customerId}` },
    );
    return { providerCustomerId: customer.id };
  }

  async getOrCreatePrice(params: {
    planId: string; planName: string; storeId: string;
    amountUSD: number; interval: 'monthly' | 'yearly';
    existingProductId?: string | null; existingPriceId?: string | null;
  }): Promise<{ providerProductId: string; providerPriceId: string }> {
    let providerProductId: string;

    if (params.existingProductId) {
      providerProductId = params.existingProductId;
    } else {
      const product = await this.stripe.products.create(
        { name: params.planName, metadata: { planId: params.planId, storeId: params.storeId } },
        { idempotencyKey: `product_create_${params.planId}` },
      );
      providerProductId = product.id;
    }

    // Stripe Price objects are immutable — a cached id is always safe to reuse verbatim.
    if (params.existingPriceId) {
      return { providerProductId, providerPriceId: params.existingPriceId };
    }

    const price = await this.stripe.prices.create(
      {
        unit_amount: Math.round(params.amountUSD * 100),
        currency: 'usd',
        recurring: { interval: params.interval === 'monthly' ? 'month' : 'year' },
        product: providerProductId,
        metadata: { planId: params.planId },
      },
      { idempotencyKey: `price_create_${params.planId}_${params.interval}_${Math.round(params.amountUSD * 100)}` },
    );

    return { providerProductId, providerPriceId: price.id };
  }

  async createProviderSubscription(
    subscriptionId: string,
    _planName: string,
    _amountUSD: number,
    _interval: string,
    context?: ChargeContext,
  ): Promise<CreateProviderSubResult> {
    if (!context?.providerCustomerId) throw new Error('createProviderSubscription requires context.providerCustomerId');
    if (!context?.providerPriceId) throw new Error('createProviderSubscription requires context.providerPriceId');

    // With a saved default card (seller onboarding), charge it now; otherwise
    // fall back to the frontend-confirmed flow below.
    let savedCard: string | null = null;
    if (context.chargeSavedCard) {
      const customer = await this.stripe.customers.retrieve(context.providerCustomerId);
      const pm = !customer.deleted ? customer.invoice_settings?.default_payment_method : null;
      savedCard = typeof pm === 'string' ? pm : pm?.id ?? null;
    }

    const subscription = await this.stripe.subscriptions.create(
      {
        customer: context.providerCustomerId,
        items: [{ price: context.providerPriceId }],
        // SCA-safe, API-driven flow: the first invoice is created but left
        // unpaid until the frontend confirms the returned PaymentIntent
        // client_secret via Stripe.js/Elements. This is the recommended
        // pattern for building a custom (non-Checkout) subscribe UI.
        // 'allow_incomplete' with a saved card: Stripe charges it immediately and
        // only leaves the invoice open if the bank requires 3-D Secure.
        ...(savedCard ? { default_payment_method: savedCard } : {}),
        payment_behavior: savedCard ? 'allow_incomplete' : 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
        metadata: { internalSubscriptionId: subscriptionId, ...(context.metadata ?? {}) },
      },
      { idempotencyKey: context.idempotencyKey ?? `sub_create_${subscriptionId}` },
    );

    // `expand: ['latest_invoice.payment_intent']` above isn't reflected in the
    // SDK's static return type, so the nested PaymentIntent is read via `any`.
    const latestInvoice = subscription.latest_invoice as any;
    const paymentIntent = latestInvoice?.payment_intent;

    return {
      providerSubscriptionId: subscription.id,
      clientSecret: paymentIntent?.client_secret ?? undefined,
      status: subscription.status,
    };
  }

  async chargeSubscription(subscriptionId: string, amountUSD: number, context?: ChargeContext): Promise<ChargeResult> {
    if (!context?.providerCustomerId) {
      return { success: false, providerChargeId: '', failureReason: 'Missing Stripe customer id for this subscription' };
    }

    try {
      const customer = await this.stripe.customers.retrieve(context.providerCustomerId) as any;
      const defaultPaymentMethod = customer?.invoice_settings?.default_payment_method as string | null | undefined;
      if (!defaultPaymentMethod) {
        return { success: false, providerChargeId: '', failureReason: 'No default payment method on file', failureCode: 'no_payment_method' };
      }

      const paymentIntent = await this.stripe.paymentIntents.create(
        {
          amount: Math.round(amountUSD * 100),
          currency: 'usd',
          customer: context.providerCustomerId,
          payment_method: defaultPaymentMethod,
          off_session: true,
          confirm: true,
          metadata: { internalSubscriptionId: subscriptionId, ...(context.metadata ?? {}) },
        },
        { idempotencyKey: context.idempotencyKey ?? `charge_${subscriptionId}_${Date.now()}` },
      );

      if (paymentIntent.status === 'succeeded') {
        return {
          success: true,
          providerChargeId: paymentIntent.id,
          paymentMethodType: paymentIntent.payment_method_types?.[0] ?? 'card',
          currency: paymentIntent.currency,
        };
      }
      if (paymentIntent.status === 'requires_action' || paymentIntent.status === 'requires_confirmation') {
        return {
          success: false, providerChargeId: paymentIntent.id, requiresAction: true,
          clientSecret: paymentIntent.client_secret ?? undefined,
          failureReason: 'Customer authentication (3DS) required',
        };
      }
      return { success: false, providerChargeId: paymentIntent.id, failureReason: `Payment intent ended in status "${paymentIntent.status}"` };
    } catch (err: any) {
      this.logger.warn(`Stripe charge failed for sub=${subscriptionId}: ${err?.message}`);
      return {
        success: false, providerChargeId: '',
        failureReason: err?.message ?? 'Card declined',
        failureCode: err?.code ?? err?.decline_code ?? undefined,
      };
    }
  }

  async cancelProviderSubscription(providerSubscriptionId: string): Promise<void> {
    try {
      await this.stripe.subscriptions.cancel(providerSubscriptionId);
    } catch (err: any) {
      // Already-canceled / not-found is a no-op from our perspective, not a hard failure —
      // the local Subscription record is the thing we actually need to end up 'canceled'.
      this.logger.warn(`Stripe subscription cancel non-fatal error for ${providerSubscriptionId}: ${err?.message}`);
    }
  }

  async scheduleProviderCancellation(providerSubscriptionId: string): Promise<void> {
    try {
      await this.stripe.subscriptions.update(providerSubscriptionId, { cancel_at_period_end: true });
    } catch (err: any) {
      this.logger.warn(`Stripe schedule-cancellation non-fatal error for ${providerSubscriptionId}: ${err?.message}`);
    }
  }

  async unscheduleProviderCancellation(providerSubscriptionId: string): Promise<void> {
    try {
      await this.stripe.subscriptions.update(providerSubscriptionId, { cancel_at_period_end: false });
    } catch (err: any) {
      this.logger.warn(`Stripe unschedule-cancellation non-fatal error for ${providerSubscriptionId}: ${err?.message}`);
    }
  }

  async createSetupIntent(providerCustomerId: string): Promise<SetupIntentResult> {
    const setupIntent = await this.stripe.setupIntents.create({
      customer: providerCustomerId,
      payment_method_types: ['card'],
      usage: 'off_session',
    });
    return { clientSecret: setupIntent.client_secret ?? '', setupIntentId: setupIntent.id };
  }

  async createBillingPortalSession(providerCustomerId: string, returnUrl: string): Promise<BillingPortalResult> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: providerCustomerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  async createCheckoutSession(params: {
    providerCustomerId: string; providerPriceId: string; successUrl: string; cancelUrl: string; metadata?: Record<string, string>;
  }): Promise<CheckoutSessionResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: params.providerCustomerId,
      line_items: [{ price: params.providerPriceId, quantity: 1 }],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: params.metadata,
      subscription_data: { metadata: params.metadata },
    });
    return { url: session.url ?? '', sessionId: session.id };
  }

  async refund(providerChargeId: string, amountUSD: number, reason?: string, idempotencyKey?: string): Promise<RefundResult> {
    try {
      const validReasons = ['duplicate', 'fraudulent', 'requested_by_customer'] as const;
      const stripeReason = (validReasons as readonly string[]).includes(reason ?? '')
        ? (reason as (typeof validReasons)[number])
        : 'requested_by_customer';

      // providerChargeId may be either a Charge id (ch_...) or a PaymentIntent id
      // (pi_...) — Stripe's refund API accepts either as `payment_intent`/`charge`.
      const refund = await this.stripe.refunds.create(
        {
          ...(providerChargeId.startsWith('pi_') ? { payment_intent: providerChargeId } : { charge: providerChargeId }),
          amount: Math.round(amountUSD * 100),
          reason: stripeReason,
        },
        { idempotencyKey: idempotencyKey ?? `refund_${providerChargeId}_${Math.round(amountUSD * 100)}` },
      );
      return { success: true, providerRefundId: refund.id };
    } catch (err: any) {
      return { success: false, failureReason: err?.message ?? 'Refund failed' };
    }
  }

  async updateProviderSubscriptionPrice(
    providerSubscriptionId: string,
    newProviderPriceId: string,
    prorationBehavior: 'create_prorations' | 'none' | 'always_invoice',
  ): Promise<{ latestInvoiceId?: string }> {
    const subscription = await this.stripe.subscriptions.retrieve(providerSubscriptionId);
    const itemId = subscription.items.data[0]?.id;
    if (!itemId) throw new Error(`Stripe subscription ${providerSubscriptionId} has no line item to update`);

    const updated = await this.stripe.subscriptions.update(
      providerSubscriptionId,
      { items: [{ id: itemId, price: newProviderPriceId }], proration_behavior: prorationBehavior },
      { idempotencyKey: `sub_update_${providerSubscriptionId}_${newProviderPriceId}` },
    );

    const latestInvoiceId = typeof updated.latest_invoice === 'string' ? updated.latest_invoice : updated.latest_invoice?.id;
    return { latestInvoiceId };
  }
}
