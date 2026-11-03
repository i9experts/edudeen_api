/* eslint-disable prettier/prettier */

export interface ChargeResult {
  success: boolean;
  providerChargeId: string;
  failureReason?: string;
  /** Provider decline code (e.g. Stripe's `card_declined`, `insufficient_funds`) — null/absent for the manual provider. */
  failureCode?: string;
  /** e.g. 'card', 'manual' — used for revenue-by-payment-method reporting. */
  paymentMethodType?: string;
  /** True when the charge needs additional customer action (3DS/SCA) before it can resolve — caller must NOT treat this as a final failure. */
  requiresAction?: boolean;
  /** PaymentIntent client_secret for the frontend to complete a `requiresAction` charge. */
  clientSecret?: string;
  currency?: string;
}

export interface CreateProviderSubResult {
  providerSubscriptionId: string;
  /** Present when the first invoice's payment needs frontend confirmation (Stripe `default_incomplete` flow). */
  clientSecret?: string;
  /** Provider-side subscription status snapshot at creation time (e.g. 'active', 'incomplete'). */
  status?: string;
}

export interface CreateCustomerResult {
  providerCustomerId: string;
}

export interface SetupIntentResult {
  clientSecret: string;
  setupIntentId: string;
}

export interface BillingPortalResult {
  url: string;
}

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
}

export interface RefundResult {
  success: boolean;
  providerRefundId?: string;
  failureReason?: string;
}

export interface ChargeContext {
  /** Provider customer id (e.g. Stripe `cus_...`) — required for any real off-session charge. */
  providerCustomerId?: string | null;
  /** Provider price id (e.g. Stripe `price_...`) — required to create a provider-native subscription. */
  providerPriceId?: string | null;
  /** Client-supplied idempotency key, forwarded to the provider so a network-retried request can never double-charge/double-create. */
  idempotencyKey?: string;
  /** Free-form metadata attached to the provider-side object for support/reconciliation. */
  metadata?: Record<string, string>;
  /** createProviderSubscription only: charge the customer's saved default card right away
   *  instead of leaving the first invoice for the frontend to confirm. If the bank asks
   *  for 3-D Secure, the result still carries a clientSecret for the frontend to finish. */
  chargeSavedCard?: boolean;
}

/**
 * IPaymentGateway — implement this interface for any payment provider.
 *
 * Current providers:
 *  - ManualPaymentProvider — simulation, always succeeds, moves no real money.
 *  - StripePaymentProvider — production Stripe integration (Customers, Prices,
 *    Subscriptions, PaymentIntents, SetupIntents, Checkout, Billing Portal).
 *
 * Selected via PAYMENT_PROVIDER env var — no call-site changes required to swap.
 */
export interface IPaymentGateway {
  chargeSubscription(
    subscriptionId: string,
    amountUSD: number,
    context?: ChargeContext,
  ): Promise<ChargeResult>;

  createProviderSubscription(
    subscriptionId: string,
    planName: string,
    amountUSD: number,
    interval: string,
    context?: ChargeContext,
  ): Promise<CreateProviderSubResult>;

  cancelProviderSubscription(providerSubscriptionId: string): Promise<void>;

  /** Marks the provider subscription to stop at the end of the current paid period (Stripe: `cancel_at_period_end: true`) instead of ending access immediately. */
  scheduleProviderCancellation(providerSubscriptionId: string): Promise<void>;

  /** Undoes a still-pending `scheduleProviderCancellation` — the subscription keeps renewing normally. */
  unscheduleProviderCancellation(providerSubscriptionId: string): Promise<void>;

  /** Idempotent from the caller's perspective as long as the caller passes a stable idempotencyKey. */
  getOrCreateCustomer(customerId: string, email: string, name: string): Promise<CreateCustomerResult>;

  /** For collecting/updating a card without an immediate charge (buyer's "add payment method" flow). */
  createSetupIntent(providerCustomerId: string): Promise<SetupIntentResult>;

  /** Stripe-hosted self-service portal — buyer manages payment methods / views invoices without any custom UI. */
  createBillingPortalSession(providerCustomerId: string, returnUrl: string): Promise<BillingPortalResult>;

  /** Hosted Checkout — simplest, most PCI-safe path for a new subscription; SCA/3DS handled entirely by Stripe. */
  createCheckoutSession(params: {
    providerCustomerId: string;
    providerPriceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }): Promise<CheckoutSessionResult>;

  refund(providerChargeId: string, amountUSD: number, reason?: string, idempotencyKey?: string): Promise<RefundResult>;

  /** Swaps the price on an already-running provider subscription (upgrade/downgrade), with provider-native proration. */
  updateProviderSubscriptionPrice(
    providerSubscriptionId: string,
    newProviderPriceId: string,
    prorationBehavior: 'create_prorations' | 'none' | 'always_invoice',
  ): Promise<{ latestInvoiceId?: string }>;

  /** Ensures a catalog Product+Price exists for this plan/interval, creating it if the cached id is missing/stale. */
  getOrCreatePrice(params: {
    planId: string; planName: string; storeId: string;
    amountUSD: number; interval: 'monthly' | 'yearly';
    existingProductId?: string | null; existingPriceId?: string | null;
  }): Promise<{ providerProductId: string; providerPriceId: string }>;
}
