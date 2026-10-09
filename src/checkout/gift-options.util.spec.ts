import { GIFT_MESSAGE_MAX, GiftOptionsError, sanitizeGiftOptions } from './gift-options.util';

describe('sanitizeGiftOptions', () => {
  it('defaults to nothing', () => {
    expect(sanitizeGiftOptions({})).toEqual({ giftMessage: null, giftWrap: false });
    expect(sanitizeGiftOptions(null)).toEqual({ giftMessage: null, giftWrap: false });
  });
  it('keeps a clean note (including Urdu) and the wrap flag', () => {
    expect(sanitizeGiftOptions({ giftMessage: '  Happy birthday!  ', giftWrap: true })).toEqual({ giftMessage: 'Happy birthday!', giftWrap: true });
    expect(sanitizeGiftOptions({ giftMessage: 'سالگرہ مبارک' }).giftMessage).toBe('سالگرہ مبارک');
  });
  it('strips markup characters and control characters; blank becomes null', () => {
    expect(sanitizeGiftOptions({ giftMessage: '<b>Hi</b>\u0007' }).giftMessage).toBe('bHi/b');
    expect(sanitizeGiftOptions({ giftMessage: '   ' }).giftMessage).toBeNull();
  });
  it('rejects wrong types and too-long notes', () => {
    expect(() => sanitizeGiftOptions({ giftMessage: 5 })).toThrow(GiftOptionsError);
    expect(() => sanitizeGiftOptions({ giftWrap: 'yes' })).toThrow(GiftOptionsError);
    expect(() => sanitizeGiftOptions({ giftMessage: 'a'.repeat(GIFT_MESSAGE_MAX + 1) })).toThrow(/at most/);
    expect(sanitizeGiftOptions({ giftMessage: 'a'.repeat(GIFT_MESSAGE_MAX) }).giftMessage).toHaveLength(GIFT_MESSAGE_MAX);
  });
});
