import { createCipheriv } from 'crypto';
import {
  DEFAULT_HTTP_POST,
  type EnvLike, type HostedPaymentProvider, type HostedPaymentRequest, type HostedRedirect, type HttpPost, type VerifiedCallback,
} from './payment-provider.types';

const STAGING_CHECKOUT = 'https://easypaystg.easypaisa.com.pk/easypay/Index.jsf';
const LIVE_CHECKOUT = 'https://easypay.easypaisa.com.pk/easypay/Index.jsf';
const STAGING_INQUIRY = 'https://easypaystg.easypaisa.com.pk/easypay-service/rest/v4/inquire-transaction';
const LIVE_INQUIRY = 'https://easypay.easypaisa.com.pk/easypay-service/rest/v4/inquire-transaction';

const pad = (n: number) => String(n).padStart(2, '0');
/** `yyyyMMdd HHmmss` (Pakistan time) as Easypay expects for expiryDate. */
export function easypaisaExpiry(d: Date): string {
  const p = new Date(d.getTime() + 5 * 3600_000);
  return `${p.getUTCFullYear()}${pad(p.getUTCMonth() + 1)}${pad(p.getUTCDate())} ${pad(p.getUTCHours())}${pad(p.getUTCMinutes())}${pad(p.getUTCSeconds())}`;
}

/** merchantHashedReq: AES-128-ECB (key = merchant hash key) of the alphabetically sorted `k=v&...` string, base64. */
export function easypaisaHashedRequest(fields: Record<string, string>, hashKey: string): string {
  const str = Object.keys(fields).sort().filter((k) => fields[k] !== '').map((k) => `${k}=${fields[k]}`).join('&');
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(hashKey, 'utf8'), null);
  return Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]).toString('base64');
}

/**
 * Easypaisa (Easypay) hosted checkout. The browser redirect back to us is NOT signed, so
 * `verifyCallback` never trusts it: it asks Easypay's inquiry API (server to server) whether
 * the order is really PAID and for how much.
 * Env: EASYPAISA_STORE_ID, EASYPAISA_HASH_KEY (16 chars), EASYPAISA_ACCOUNT_NUM,
 * EASYPAISA_USERNAME, EASYPAISA_PASSWORD, EASYPAISA_ENV=sandbox|live,
 * EASYPAISA_CHECKOUT_URL / EASYPAISA_INQUIRY_URL (optional overrides).
 * TODO(owner): confirm field names/endpoints against the signed merchant integration guide.
 */
export class EasypaisaProvider implements HostedPaymentProvider {
  readonly id = 'easypaisa' as const;
  readonly label = 'Easypaisa';

  constructor(private readonly env: EnvLike, private readonly httpPost: HttpPost = DEFAULT_HTTP_POST) {}

  private g(k: string) { return (this.env[k] ?? '').trim(); }

  isConfigured(): boolean {
    if (this.g('EASYPAISA_ENABLED').toLowerCase() === 'false') return false;
    return !!(this.g('EASYPAISA_STORE_ID') && this.g('EASYPAISA_HASH_KEY') && this.g('EASYPAISA_ACCOUNT_NUM') && this.g('EASYPAISA_USERNAME') && this.g('EASYPAISA_PASSWORD'));
  }

  supportsCurrency(currency: string): boolean {
    return currency?.toUpperCase() === 'PKR';
  }

  private get live() { return (this.g('EASYPAISA_ENV') || 'sandbox').toLowerCase() === 'live'; }

  buildRedirect(req: HostedPaymentRequest): HostedRedirect {
    if (!this.isConfigured()) throw new Error('Easypaisa is not configured');
    const now = req.now ?? new Date();
    const fields: Record<string, string> = {
      storeId: this.g('EASYPAISA_STORE_ID'),
      amount: (req.amountMinor / 100).toFixed(1),
      postBackURL: req.returnUrl,
      orderRefNum: req.txnRef,
      expiryDate: easypaisaExpiry(new Date(now.getTime() + 60 * 60_000)),
      autoRedirect: '1',
      paymentMethod: 'InitialRequest',
      emailAddr: req.buyerEmail ?? '',
      mobileNum: req.buyerPhone ?? '',
    };
    const hashed = easypaisaHashedRequest(fields, this.g('EASYPAISA_HASH_KEY'));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== '') out[k] = v;
    out.merchantHashedReq = hashed;
    return { method: 'GET', url: this.g('EASYPAISA_CHECKOUT_URL') || (this.live ? LIVE_CHECKOUT : STAGING_CHECKOUT), fields: out };
  }

  async verifyCallback(payload: Record<string, any>): Promise<VerifiedCallback> {
    const bad = (reason: string): VerifiedCallback => ({ valid: false, success: false, txnRef: null, amountMinor: null, providerRef: null, reason });
    if (!this.isConfigured()) return bad('not_configured');
    const txnRef = String(payload?.orderRefNumber ?? payload?.orderRefNum ?? payload?.orderId ?? '').trim();
    if (!txnRef) return bad('missing_order_ref');
    try {
      const res = await this.httpPost(this.g('EASYPAISA_INQUIRY_URL') || (this.live ? LIVE_INQUIRY : STAGING_INQUIRY), {
        headers: {
          'Content-Type': 'application/json',
          Credentials: Buffer.from(`${this.g('EASYPAISA_USERNAME')}:${this.g('EASYPAISA_PASSWORD')}`).toString('base64'),
        },
        body: JSON.stringify({ orderId: txnRef, storeId: this.g('EASYPAISA_STORE_ID'), accountNum: this.g('EASYPAISA_ACCOUNT_NUM') }),
      });
      if (res.status !== 200) return bad(`inquiry_http_${res.status}`);
      const j = await res.json();
      const amount = Number(j?.transactionAmount);
      return {
        valid: String(j?.orderId ?? txnRef) === txnRef,
        success: String(j?.responseCode) === '0000' && String(j?.transactionStatus ?? '').toUpperCase() === 'PAID',
        txnRef,
        amountMinor: Number.isFinite(amount) ? Math.round(amount * 100) : null,
        providerRef: String(j?.transactionId ?? '') || null,
        reason: String(j?.responseDesc ?? j?.transactionStatus ?? ''),
      };
    } catch (e: any) {
      return bad(`inquiry_failed:${e?.message ?? 'error'}`);
    }
  }
}
