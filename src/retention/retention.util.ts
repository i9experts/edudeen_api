/* eslint-disable prettier/prettier */
import { randomBytes } from 'crypto';

// Pure decision logic for retention features (cart reminders, wishlist alerts, referrals).
// Kept free of Nest/Mongo so it is unit-testable.

export const CART_IDLE_MIN_MS = 2 * 60 * 60 * 1000; // abandoned after 2h without a change
export const CART_REMINDER_MAX_AGE_MS = 72 * 60 * 60 * 1000; // stop chasing after 3 days
export const CART_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000; // at most one reminder per cart per 24h
export const PRICE_DROP_MIN_PERCENT = 5;

/** A cart is due a reminder once: idle 2h-72h, not reminded in 24h, and not already reminded since its last change. */
export function isCartReminderDue(args: { cartUpdatedAt: Date; itemCount: number; lastReminderAt: Date | null; now?: Date }): boolean {
  const now = (args.now ?? new Date()).getTime();
  if (!(args.itemCount > 0)) return false;
  const idle = now - args.cartUpdatedAt.getTime();
  if (idle < CART_IDLE_MIN_MS || idle > CART_REMINDER_MAX_AGE_MS) return false;
  if (args.lastReminderAt) {
    if (now - args.lastReminderAt.getTime() < CART_REMINDER_COOLDOWN_MS) return false;
    if (args.lastReminderAt.getTime() >= args.cartUpdatedAt.getTime()) return false; // one reminder per abandonment
  }
  return true;
}

export interface VariantSnapshot { price: number; inStock: boolean }
export type WishlistEvent = 'back_in_stock' | 'price_drop';

/** Which alert events a wishlisted variant produced since the stored snapshot. No snapshot => no events (baseline only). */
export function detectWishlistEvents(prev: VariantSnapshot | null, curr: VariantSnapshot, minDropPercent = PRICE_DROP_MIN_PERCENT): WishlistEvent[] {
  if (!prev) return [];
  const events: WishlistEvent[] = [];
  if (!prev.inStock && curr.inStock) events.push('back_in_stock');
  if (curr.inStock && prev.price > 0 && curr.price > 0 && curr.price <= prev.price * (1 - minDropPercent / 100)) events.push('price_drop');
  return events;
}

/** gmail dots and +tags, and +tags elsewhere, collapse to one mailbox - used to catch self-referral via alias addresses. */
export function canonicalEmail(email: string | null | undefined): string {
  const e = String(email ?? '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at).split('+')[0];
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');
/** Compares phones on their last 10 digits (03xx.. vs +923xx..). Empty never matches. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = digits(a).slice(-10);
  const y = digits(b).slice(-10);
  return x.length >= 9 && x === y;
}

export interface ReferralSignals {
  referrer: { id: string; email: string; phone?: string | null };
  referee: { id: string; email: string; phone?: string | null };
  /** other referrals of this referrer that came from the same signup IP hash as this one */
  sameIpReferrals: number;
  /** a shipping phone on the referee's qualifying order, when known */
  refereeOrderPhone?: string | null;
  /** how many referrals already rewarded for this referrer, and the configured cap */
  referrerRewardedCount: number;
  maxRewardsPerReferrer: number;
}

export type ReferralVerdict = { ok: true } | { ok: false; reason: 'self_referral' | 'same_email_alias' | 'same_phone' | 'same_ip_cluster' | 'referrer_cap_reached' };

/** Cheap abuse guards. Order matters only for the reported reason. */
export function evaluateReferral(s: ReferralSignals): ReferralVerdict {
  if (s.referrer.id === s.referee.id) return { ok: false, reason: 'self_referral' };
  if (canonicalEmail(s.referrer.email) === canonicalEmail(s.referee.email)) return { ok: false, reason: 'same_email_alias' };
  if (samePhone(s.referrer.phone, s.referee.phone) || samePhone(s.referrer.phone, s.refereeOrderPhone)) return { ok: false, reason: 'same_phone' };
  if (s.sameIpReferrals >= 2) return { ok: false, reason: 'same_ip_cluster' };
  if (s.referrerRewardedCount >= s.maxRewardsPerReferrer) return { ok: false, reason: 'referrer_cap_reached' };
  return { ok: true };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export function generateReferralCode(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function isValidReferralCodeShape(code: unknown): code is string {
  return typeof code === 'string' && /^[A-HJ-NP-Z2-9]{8}$/.test(code.trim().toUpperCase());
}

export interface ReferralSettings {
  enabled: boolean;
  rewardType: 'percentage' | 'fixed';
  rewardValue: number; // percent, or USD for fixed
  refereeRewardValue: number; // 0 = no welcome reward for the invited friend
  minOrderUSD: number | null;
  expiryDays: number;
  maxRewardsPerReferrer: number;
}

export const DEFAULT_REFERRAL_SETTINGS: ReferralSettings = {
  enabled: false, rewardType: 'percentage', rewardValue: 10, refereeRewardValue: 0, minOrderUSD: null, expiryDays: 60, maxRewardsPerReferrer: 10,
};

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Normalises admin input (and stored docs) into safe settings. */
export function cleanReferralSettings(raw: any, base: ReferralSettings = DEFAULT_REFERRAL_SETTINGS): ReferralSettings {
  const rewardType: 'percentage' | 'fixed' = (raw?.rewardType ?? base.rewardType) === 'fixed' ? 'fixed' : 'percentage';
  const max = rewardType === 'percentage' ? 100 : 1000;
  const minOrder = raw?.minOrderUSD === null || raw?.minOrderUSD === '' ? null : raw?.minOrderUSD === undefined ? base.minOrderUSD : clamp(num(raw.minOrderUSD, 0), 0, 100000);
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : base.enabled,
    rewardType,
    rewardValue: clamp(num(raw?.rewardValue, base.rewardValue), 0, max),
    refereeRewardValue: clamp(num(raw?.refereeRewardValue, base.refereeRewardValue), 0, max),
    minOrderUSD: minOrder && minOrder > 0 ? minOrder : null,
    expiryDays: Math.round(clamp(num(raw?.expiryDays, base.expiryDays), 1, 365)),
    maxRewardsPerReferrer: Math.round(clamp(num(raw?.maxRewardsPerReferrer, base.maxRewardsPerReferrer), 1, 500)),
  };
}

export function describeReward(type: 'percentage' | 'fixed', value: number): string {
  return type === 'percentage' ? `${value}% off` : `$${value} off`;
}
