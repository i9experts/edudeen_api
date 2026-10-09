/**
 * Hosted (redirect) payment providers for the Pakistani rails.
 * Adapters are env-driven; with no credentials they report `isConfigured() === false`
 * and the checkout simply does not offer them. Nothing here fakes a success: an order
 * is only placed after `verifyCallback` returns `valid && success`.
 */
export type HostedProviderId = 'jazzcash' | 'easypaisa';

export interface HostedPaymentRequest {
  /** Our unique reference for this attempt (stored on the PaymentTransaction). */
  txnRef: string;
  /** Amount in minor units (paisa). */
  amountMinor: number;
  currency: string;
  description: string;
  buyerEmail?: string | null;
  buyerPhone?: string | null;
  /** Absolute URL the gateway sends the buyer back to (our callback endpoint). */
  returnUrl: string;
  /** Injectable clock for tests. */
  now?: Date;
}

/** What the browser must do to reach the hosted page (auto-submitted form or redirect). */
export interface HostedRedirect {
  method: 'GET' | 'POST';
  url: string;
  fields: Record<string, string>;
}

export interface VerifiedCallback {
  /** Signature / server-side confirmation checked out. */
  valid: boolean;
  /** Gateway says the money was captured (only meaningful when valid). */
  success: boolean;
  txnRef: string | null;
  amountMinor: number | null;
  providerRef: string | null;
  reason?: string;
}

/** Minimal HTTP seam so adapters can be unit-tested with a mock (no real calls). */
export type HttpPost = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<{ status: number; json: () => Promise<any> }>;

export interface HostedPaymentProvider {
  readonly id: HostedProviderId;
  readonly label: string;
  isConfigured(): boolean;
  supportsCurrency(currency: string): boolean;
  buildRedirect(req: HostedPaymentRequest): HostedRedirect;
  verifyCallback(payload: Record<string, any>): Promise<VerifiedCallback>;
}

export type EnvLike = Record<string, string | undefined>;

export const DEFAULT_HTTP_POST: HttpPost = async (url, init) => {
  const res = await fetch(url, { method: 'POST', headers: init.headers, body: init.body });
  return { status: res.status, json: () => res.json() };
};
