import { createHmac, timingSafeEqual } from 'crypto';
import type { EnvLike, HostedPaymentProvider, HostedPaymentRequest, HostedRedirect, VerifiedCallback } from './payment-provider.types';

const SANDBOX_URL = 'https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform';
const LIVE_URL = 'https://payments.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform';

const pad = (n: number) => String(n).padStart(2, '0');
/** yyyyMMddHHmmss in Pakistan time (UTC+5, no DST), which JazzCash expects. */
export function jazzcashDateTime(d: Date): string {
  const p = new Date(d.getTime() + 5 * 3600_000);
  return `${p.getUTCFullYear()}${pad(p.getUTCMonth() + 1)}${pad(p.getUTCDate())}${pad(p.getUTCHours())}${pad(p.getUTCMinutes())}${pad(p.getUTCSeconds())}`;
}

/**
 * JazzCash secure hash: HMAC-SHA256 (key = integrity salt, uppercase hex) over
 * `salt & value1 & value2 ...` where values are taken in alphabetical key order,
 * skipping empty values and the hash field itself.
 */
export function jazzcashSecureHash(fields: Record<string, any>, salt: string): string {
  const parts = Object.keys(fields)
    .filter((k) => k !== 'pp_SecureHash')
    .sort()
    .map((k) => String(fields[k] ?? ''))
    .filter((v) => v !== '');
  return createHmac('sha256', salt).update([salt, ...parts].join('&')).digest('hex').toUpperCase();
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** JazzCash hosted checkout (page redirection). Env: JAZZCASH_MERCHANT_ID, JAZZCASH_PASSWORD, JAZZCASH_INTEGRITY_SALT, JAZZCASH_ENV=sandbox|live, JAZZCASH_PAYMENT_URL (optional override). */
export class JazzCashProvider implements HostedPaymentProvider {
  readonly id = 'jazzcash' as const;
  readonly label = 'JazzCash';

  constructor(private readonly env: EnvLike) {}

  private get merchantId() { return (this.env.JAZZCASH_MERCHANT_ID ?? '').trim(); }
  private get password() { return (this.env.JAZZCASH_PASSWORD ?? '').trim(); }
  private get salt() { return (this.env.JAZZCASH_INTEGRITY_SALT ?? '').trim(); }

  isConfigured(): boolean {
    if ((this.env.JAZZCASH_ENABLED ?? '').trim().toLowerCase() === 'false') return false;
    return !!(this.merchantId && this.password && this.salt);
  }

  supportsCurrency(currency: string): boolean {
    return currency?.toUpperCase() === 'PKR';
  }

  private get postUrl(): string {
    const override = (this.env.JAZZCASH_PAYMENT_URL ?? '').trim();
    if (override) return override;
    return (this.env.JAZZCASH_ENV ?? 'sandbox').trim().toLowerCase() === 'live' ? LIVE_URL : SANDBOX_URL;
  }

  buildRedirect(req: HostedPaymentRequest): HostedRedirect {
    if (!this.isConfigured()) throw new Error('JazzCash is not configured');
    const now = req.now ?? new Date();
    const fields: Record<string, string> = {
      pp_Version: '1.1',
      pp_TxnType: '',
      pp_Language: 'EN',
      pp_MerchantID: this.merchantId,
      pp_SubMerchantID: '',
      pp_Password: this.password,
      pp_BankID: 'TBANK',
      pp_ProductID: 'RETL',
      pp_TxnRefNo: req.txnRef,
      pp_Amount: String(req.amountMinor),
      pp_TxnCurrency: 'PKR',
      pp_TxnDateTime: jazzcashDateTime(now),
      pp_BillReference: req.txnRef,
      pp_Description: req.description.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 100) || 'Edudeen order',
      pp_TxnExpiryDateTime: jazzcashDateTime(new Date(now.getTime() + 60 * 60_000)),
      pp_ReturnURL: req.returnUrl,
    };
    fields.pp_SecureHash = jazzcashSecureHash(fields, this.salt);
    return { method: 'POST', url: this.postUrl, fields };
  }

  async verifyCallback(payload: Record<string, any>): Promise<VerifiedCallback> {
    const bad = (reason: string): VerifiedCallback => ({ valid: false, success: false, txnRef: null, amountMinor: null, providerRef: null, reason });
    if (!this.isConfigured()) return bad('not_configured');
    const received = String(payload?.pp_SecureHash ?? '');
    if (!received) return bad('missing_signature');
    const expected = jazzcashSecureHash(payload, this.salt);
    if (!safeEqual(received.toUpperCase(), expected)) return bad('bad_signature');
    const amount = Number(payload.pp_Amount);
    return {
      valid: true,
      success: String(payload.pp_ResponseCode) === '000',
      txnRef: String(payload.pp_TxnRefNo ?? '') || null,
      amountMinor: Number.isFinite(amount) ? Math.round(amount) : null,
      providerRef: String(payload.pp_RetreivalReferenceNo ?? payload.pp_RetrievalReferenceNo ?? '') || null,
      reason: String(payload.pp_ResponseMessage ?? ''),
    };
  }
}
