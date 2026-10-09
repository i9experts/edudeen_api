import { createHmac } from 'crypto';
import { JazzCashProvider, jazzcashSecureHash } from './jazzcash.provider';
import { EasypaisaProvider, easypaisaHashedRequest } from './easypaisa.provider';
import { configuredHostedProviderIds } from './hosted-providers.registry';

const jcEnv = { JAZZCASH_MERCHANT_ID: 'MC1', JAZZCASH_PASSWORD: 'pw', JAZZCASH_INTEGRITY_SALT: 'salt123' };
const epEnv = {
  EASYPAISA_STORE_ID: '99', EASYPAISA_HASH_KEY: '1234567890ABCDEF', EASYPAISA_ACCOUNT_NUM: 'A1',
  EASYPAISA_USERNAME: 'u', EASYPAISA_PASSWORD: 'p',
};

describe('configuration gating', () => {
  it('nothing is offered without credentials', () => {
    expect(configuredHostedProviderIds('PKR', {})).toEqual([]);
    expect(new JazzCashProvider({}).isConfigured()).toBe(false);
    expect(new EasypaisaProvider({}).isConfigured()).toBe(false);
  });
  it('offers configured providers only for PKR', () => {
    expect(configuredHostedProviderIds('PKR', { ...jcEnv, ...epEnv })).toEqual(['jazzcash', 'easypaisa']);
    expect(configuredHostedProviderIds('USD', { ...jcEnv, ...epEnv })).toEqual([]);
  });
  it('can be switched off explicitly', () => {
    expect(configuredHostedProviderIds('PKR', { ...jcEnv, JAZZCASH_ENABLED: 'false' })).toEqual([]);
  });
});

describe('JazzCash', () => {
  const p = new JazzCashProvider(jcEnv);

  it('secure hash = HMAC-SHA256(salt, salt&sorted non-empty values), uppercase', () => {
    const expected = createHmac('sha256', 'salt123').update('salt123&10000&MC1').digest('hex').toUpperCase();
    expect(jazzcashSecureHash({ pp_MerchantID: 'MC1', pp_Amount: '10000', pp_Empty: '' }, 'salt123')).toBe(expected);
  });

  it('builds a signed POST form in paisa', () => {
    const r = p.buildRedirect({ txnRef: 'T1', amountMinor: 125000, currency: 'PKR', description: 'Order #1', returnUrl: 'https://api/cb', now: new Date('2026-01-01T00:00:00Z') });
    expect(r.method).toBe('POST');
    expect(r.url).toContain('sandbox.jazzcash.com.pk');
    expect(r.fields.pp_Amount).toBe('125000');
    expect(r.fields.pp_TxnDateTime).toBe('20260101050000');
    expect(r.fields.pp_SecureHash).toBe(jazzcashSecureHash(r.fields, 'salt123'));
  });

  it('accepts a correctly signed success callback', async () => {
    const payload: Record<string, string> = { pp_TxnRefNo: 'T1', pp_Amount: '125000', pp_ResponseCode: '000', pp_ResponseMessage: 'OK' };
    payload.pp_SecureHash = jazzcashSecureHash(payload, 'salt123');
    expect(await p.verifyCallback(payload)).toMatchObject({ valid: true, success: true, txnRef: 'T1', amountMinor: 125000 });
  });

  it('valid but unsuccessful when the gateway declines', async () => {
    const payload: Record<string, string> = { pp_TxnRefNo: 'T1', pp_Amount: '125000', pp_ResponseCode: '124' };
    payload.pp_SecureHash = jazzcashSecureHash(payload, 'salt123');
    expect(await p.verifyCallback(payload)).toMatchObject({ valid: true, success: false });
  });

  it('rejects a tampered or unsigned callback (never fakes success)', async () => {
    const payload: Record<string, string> = { pp_TxnRefNo: 'T1', pp_Amount: '125000', pp_ResponseCode: '000' };
    payload.pp_SecureHash = jazzcashSecureHash(payload, 'salt123');
    expect((await p.verifyCallback({ ...payload, pp_Amount: '1' })).valid).toBe(false);
    expect((await p.verifyCallback({ ...payload, pp_SecureHash: '' })).valid).toBe(false);
    expect((await p.verifyCallback({ ...payload, pp_ResponseCode: '000', pp_SecureHash: 'AA' })).success).toBe(false);
  });
});

describe('Easypaisa', () => {
  it('builds a hashed checkout request', () => {
    const p = new EasypaisaProvider(epEnv);
    const r = p.buildRedirect({ txnRef: 'EP1', amountMinor: 50000, currency: 'PKR', description: 'x', returnUrl: 'https://api/cb', now: new Date('2026-01-01T00:00:00Z') });
    expect(r.fields.amount).toBe('500.0');
    expect(r.fields.orderRefNum).toBe('EP1');
    expect(r.fields.merchantHashedReq).toBe(
      easypaisaHashedRequest({ storeId: '99', amount: '500.0', postBackURL: 'https://api/cb', orderRefNum: 'EP1', expiryDate: '20260101 060000', autoRedirect: '1', paymentMethod: 'InitialRequest', emailAddr: '', mobileNum: '' }, '1234567890ABCDEF'),
    );
  });

  const http = (status: number, body: any) => jest.fn().mockResolvedValue({ status, json: async () => body });

  it('trusts only the server-side inquiry: PAID => success', async () => {
    const post = http(200, { responseCode: '0000', transactionStatus: 'PAID', transactionAmount: 500, orderId: 'EP1', transactionId: 'TX9' });
    const v = await new EasypaisaProvider(epEnv, post).verifyCallback({ orderRefNumber: 'EP1', status: '0000' });
    expect(v).toMatchObject({ valid: true, success: true, amountMinor: 50000, providerRef: 'TX9' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].headers.Credentials).toBe(Buffer.from('u:p').toString('base64'));
  });

  it('a redirect that claims success is ignored when the inquiry says unpaid', async () => {
    const post = http(200, { responseCode: '0000', transactionStatus: 'PENDING', orderId: 'EP1' });
    expect((await new EasypaisaProvider(epEnv, post).verifyCallback({ orderRefNumber: 'EP1', status: '0000' })).success).toBe(false);
  });

  it('inquiry failure / http error => invalid, never success', async () => {
    expect((await new EasypaisaProvider(epEnv, http(500, {})).verifyCallback({ orderRefNumber: 'EP1' })).valid).toBe(false);
    const boom = jest.fn().mockRejectedValue(new Error('net'));
    expect((await new EasypaisaProvider(epEnv, boom).verifyCallback({ orderRefNumber: 'EP1' })).success).toBe(false);
    expect((await new EasypaisaProvider(epEnv, http(200, {})).verifyCallback({})).valid).toBe(false);
  });
});
