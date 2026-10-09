import {
  canonicalEmail, cleanReferralSettings, DEFAULT_REFERRAL_SETTINGS, detectWishlistEvents, evaluateReferral, generateReferralCode,
  isCartReminderDue, isValidReferralCodeShape, samePhone,
} from './retention.util';

const H = 3600_000;
const now = new Date('2026-10-09T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('isCartReminderDue', () => {
  it('waits for 2h of idleness and stops after 72h', () => {
    expect(isCartReminderDue({ cartUpdatedAt: ago(1 * H), itemCount: 2, lastReminderAt: null, now })).toBe(false);
    expect(isCartReminderDue({ cartUpdatedAt: ago(3 * H), itemCount: 2, lastReminderAt: null, now })).toBe(true);
    expect(isCartReminderDue({ cartUpdatedAt: ago(80 * H), itemCount: 2, lastReminderAt: null, now })).toBe(false);
  });
  it('never reminds an empty cart', () => {
    expect(isCartReminderDue({ cartUpdatedAt: ago(5 * H), itemCount: 0, lastReminderAt: null, now })).toBe(false);
  });
  it('allows one reminder per 24h and one per abandonment', () => {
    // reminded 3h ago, cart untouched since before that
    expect(isCartReminderDue({ cartUpdatedAt: ago(10 * H), itemCount: 1, lastReminderAt: ago(3 * H), now })).toBe(false);
    // reminded 30h ago but the cart has not changed since: still the same abandonment
    expect(isCartReminderDue({ cartUpdatedAt: ago(40 * H), itemCount: 1, lastReminderAt: ago(30 * H), now })).toBe(false);
    // reminded 30h ago, then the buyer touched the cart 5h ago: a new abandonment
    expect(isCartReminderDue({ cartUpdatedAt: ago(5 * H), itemCount: 1, lastReminderAt: ago(30 * H), now })).toBe(true);
  });
});

describe('detectWishlistEvents', () => {
  it('produces nothing without a baseline', () => {
    expect(detectWishlistEvents(null, { price: 100, inStock: true })).toEqual([]);
  });
  it('detects back in stock only on a 0 -> in stock transition', () => {
    expect(detectWishlistEvents({ price: 100, inStock: false }, { price: 100, inStock: true })).toEqual(['back_in_stock']);
    expect(detectWishlistEvents({ price: 100, inStock: true }, { price: 100, inStock: true })).toEqual([]);
    expect(detectWishlistEvents({ price: 100, inStock: true }, { price: 100, inStock: false })).toEqual([]);
  });
  it('detects a price drop of at least 5% on an in-stock item', () => {
    expect(detectWishlistEvents({ price: 100, inStock: true }, { price: 95, inStock: true })).toEqual(['price_drop']);
    expect(detectWishlistEvents({ price: 100, inStock: true }, { price: 96, inStock: true })).toEqual([]);
    expect(detectWishlistEvents({ price: 100, inStock: true }, { price: 120, inStock: true })).toEqual([]);
    expect(detectWishlistEvents({ price: 100, inStock: false }, { price: 50, inStock: false })).toEqual([]);
  });
  it('can report both events at once', () => {
    expect(detectWishlistEvents({ price: 100, inStock: false }, { price: 80, inStock: true })).toEqual(['back_in_stock', 'price_drop']);
  });
});

describe('referral abuse guards', () => {
  it('collapses gmail dots/plus tags and plus tags elsewhere', () => {
    expect(canonicalEmail('Ali.Khan+promo@Gmail.com')).toBe('alikhan@gmail.com');
    expect(canonicalEmail('ali.khan@googlemail.com')).toBe('alikhan@gmail.com');
    expect(canonicalEmail('a.b+x@school.edu.pk')).toBe('a.b@school.edu.pk');
  });
  it('matches phones in different local/international formats', () => {
    expect(samePhone('0300 1234567', '+92 300-1234567')).toBe(true);
    expect(samePhone('0300 1234567', '0301 1234567')).toBe(false);
    expect(samePhone('', '')).toBe(false);
    expect(samePhone(null, undefined)).toBe(false);
  });
  const base = {
    referrer: { id: 'a', email: 'a@x.com', phone: '03001111111' },
    referee: { id: 'b', email: 'b@y.com', phone: '03002222222' },
    sameIpReferrals: 0, referrerRewardedCount: 0, maxRewardsPerReferrer: 3,
  };
  it('accepts a normal referral', () => expect(evaluateReferral(base)).toEqual({ ok: true }));
  it('rejects self referral, alias email, shared phone, IP cluster and the cap', () => {
    expect(evaluateReferral({ ...base, referee: { ...base.referee, id: 'a' } })).toEqual({ ok: false, reason: 'self_referral' });
    expect(evaluateReferral({ ...base, referee: { ...base.referee, email: 'A+1@x.com' } })).toEqual({ ok: false, reason: 'same_email_alias' });
    expect(evaluateReferral({ ...base, referee: { ...base.referee, phone: '+923001111111' } })).toEqual({ ok: false, reason: 'same_phone' });
    expect(evaluateReferral({ ...base, refereeOrderPhone: '0300-1111111' })).toEqual({ ok: false, reason: 'same_phone' });
    expect(evaluateReferral({ ...base, sameIpReferrals: 2 })).toEqual({ ok: false, reason: 'same_ip_cluster' });
    expect(evaluateReferral({ ...base, referrerRewardedCount: 3 })).toEqual({ ok: false, reason: 'referrer_cap_reached' });
  });
});

describe('referral codes and settings', () => {
  it('generates 8 unambiguous characters', () => {
    for (let i = 0; i < 50; i++) expect(generateReferralCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
  it('validates the code shape (case-insensitive, no 0/O/1/I)', () => {
    expect(isValidReferralCodeShape('k7qm2xpd')).toBe(true);
    expect(isValidReferralCodeShape('K7QM2XP0')).toBe(false);
    expect(isValidReferralCodeShape('SHORT')).toBe(false);
    expect(isValidReferralCodeShape({ $ne: 1 })).toBe(false);
  });
  it('cleans admin input: clamps, defaults off, keeps unspecified keys', () => {
    expect(DEFAULT_REFERRAL_SETTINGS.enabled).toBe(false);
    const s = cleanReferralSettings({ enabled: true, rewardType: 'percentage', rewardValue: 500, expiryDays: 0, maxRewardsPerReferrer: 9999, minOrderUSD: -4 });
    expect(s).toMatchObject({ enabled: true, rewardValue: 100, expiryDays: 1, maxRewardsPerReferrer: 500, minOrderUSD: null });
    const kept = cleanReferralSettings({ rewardValue: 15 }, { ...DEFAULT_REFERRAL_SETTINGS, enabled: true });
    expect(kept.enabled).toBe(true);
    expect(kept.rewardValue).toBe(15);
    expect(cleanReferralSettings({ rewardType: 'bogus' }).rewardType).toBe('percentage');
    expect(cleanReferralSettings({ rewardType: 'fixed', rewardValue: 5000 }).rewardValue).toBe(1000);
  });
});
