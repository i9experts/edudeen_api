/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { createHmac, randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { escapeHtml, notificationEmailShell } from '../notifications/templates/notification-email.template';
import { ProductsService } from '../products/products.service';
import { sanitizeDigitalForPublicView } from '../products/product-public-view.util';
import {
  CartReminder, CartReminderDocument, Referral, ReferralCode, ReferralCodeDocument, ReferralDocument,
  RetentionSettings, RetentionSettingsDocument, WishlistShare, WishlistShareDocument,
  WishlistVariantState, WishlistVariantStateDocument,
} from './retention.schemas';
import {
  CART_REMINDER_COOLDOWN_MS, DEFAULT_REFERRAL_SETTINGS, ReferralSettings, cleanReferralSettings, describeReward,
  detectWishlistEvents, evaluateReferral, generateReferralCode, isCartReminderDue, isValidReferralCodeShape,
} from './retention.util';

const WEB = () => (process.env.WEB_APP_URL || 'https://www.edudeen.com').replace(/\/$/, '');
const REFERRAL_WINDOW_DAYS = 14;
const REFERRAL_PENDING_MAX_DAYS = 90;
const BLOCKED_STATUSES = ['deleted', 'suspended'];

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
    private readonly productsService: ProductsService,
    private readonly redis: RedisService,
    @InjectModel(CartReminder.name) private readonly cartReminderModel: Model<CartReminderDocument>,
    @InjectModel(WishlistVariantState.name) private readonly variantStateModel: Model<WishlistVariantStateDocument>,
    @InjectModel(WishlistShare.name) private readonly shareModel: Model<WishlistShareDocument>,
    @InjectModel(ReferralCode.name) private readonly codeModel: Model<ReferralCodeDocument>,
    @InjectModel(Referral.name) private readonly referralModel: Model<ReferralDocument>,
    @InjectModel(RetentionSettings.name) private readonly settingsModel: Model<RetentionSettingsDocument>,
  ) {}

  // ── shared helpers ────────────────────────────────────────────────────────

  private async locked(name: string, ttlMs: number, fn: () => Promise<void>) {
    try {
      const r = await this.redis.withLock(`cron-lock:${name}`, ttlMs, fn);
      if (r === 'lock_not_acquired') this.logger.debug(`Skipped "${name}" (lock held or Redis down)`);
    } catch (err: any) {
      this.logger.error(`Retention job "${name}" failed: ${err?.message}`);
    }
  }

  /** Buyer may be contacted: active verified account and the promotions category not muted. */
  private async contactable(userId: string): Promise<{ email: string; name: string } | null> {
    if (!isValidObjectId(userId)) return null;
    const user: any = await this.db.repositories.userModel
      .findOne({ _id: userId, isVerified: true, isDelete: false, status: { $nin: BLOCKED_STATUSES } })
      .select('email name').lean();
    if (!user?.email) return null;
    const prefs: any = await this.db.repositories.notificationPreferenceModel.findOne({ userId }).select('prefs').lean();
    if (prefs?.prefs?.promotions === false) return null;
    return { email: user.email, name: user.name };
  }

  // ── (a) abandoned cart reminders ──────────────────────────────────────────

  @Cron('*/20 * * * *')
  async cronCartReminders() {
    await this.locked('retention-cart-reminders', 15 * 60_000, async () => { await this.runCartReminders(); });
  }

  async runCartReminders(now = new Date()): Promise<{ users: number; reminded: number }> {
    const { cartModel } = this.db.repositories;
    const carts: any[] = await cartModel
      .find({
        isDelete: false, status: 'active', 'items.0': { $exists: true },
        updatedAt: { $gte: new Date(now.getTime() - 72 * 3600_000), $lte: new Date(now.getTime() - 2 * 3600_000) },
      })
      .sort({ updatedAt: 1 }).limit(500).select('userId items updatedAt').lean();
    const byUser = new Map<string, any[]>();
    for (const c of carts) byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), c]);

    let reminded = 0;
    for (const [userId, userCarts] of byUser) {
      try {
        const reminders = await this.cartReminderModel.find({ cartId: { $in: userCarts.map((c) => String(c._id)) } }).lean();
        const lastByCart = new Map(reminders.map((r) => [r.cartId, r.lastReminderAt]));
        const due = userCarts.filter((c) =>
          isCartReminderDue({ cartUpdatedAt: new Date(c.updatedAt), itemCount: c.items?.length ?? 0, lastReminderAt: lastByCart.get(String(c._id)) ?? null, now }));
        if (!due.length) continue;
        const who = await this.contactable(userId);
        if (!who) continue; // no account / muted / blocked: never contact
        const cutoff = new Date(now.getTime() - CART_REMINDER_COOLDOWN_MS);
        const claimed: any[] = [];
        for (const c of due) if (await this.claimCart(String(c._id), userId, cutoff, now)) claimed.push(c);
        if (!claimed.length) continue;
        const items = claimed.flatMap((c) => c.items as any[]);
        const first = String(items[0]?.name ?? 'your items');
        const more = items.length - 1;
        const link = `${WEB()}/cart`;
        await this.notifications.notify({
          recipientId: userId, recipientRole: 'user', type: NOTIFICATION_TYPES.CART_REMINDER,
          title: 'You left something in your cart',
          body: more > 0 ? `"${first}" and ${more} more item${more === 1 ? '' : 's'} are waiting for you.` : `"${first}" is waiting for you.`,
          data: { link: '/cart' },
          email: {
            subject: 'Your cart is waiting',
            html: notificationEmailShell('Your cart is waiting', `<p>Hi ${escapeHtml(String(who.name ?? '').split(' ')[0] || 'there')}, you left <strong>${escapeHtml(first)}</strong>${more > 0 ? ` and ${more} more item${more === 1 ? '' : 's'}` : ''} in your cart.</p>`, { label: 'Back to my cart', url: link }),
          },
          channelEvent: { event: 'cart_reminder', vars: { itemCount: String(items.length), link } },
        });
        reminded++;
      } catch (err: any) {
        this.logger.warn(`cart reminder for ${userId} failed: ${err?.message}`);
      }
    }
    return { users: byUser.size, reminded };
  }

  /** Atomic: only the caller that moves lastReminderAt past the 24h cooldown (or creates the row) wins. */
  private async claimCart(cartId: string, userId: string, cutoff: Date, now: Date): Promise<boolean> {
    try {
      const r = await this.cartReminderModel.updateOne({ cartId, lastReminderAt: { $lt: cutoff } }, { $set: { lastReminderAt: now, userId } }, { upsert: true });
      return r.modifiedCount === 1 || r.upsertedCount === 1;
    } catch (err: any) {
      if (err?.code === 11000) return false; // row exists and is still inside the cooldown
      throw err;
    }
  }

  // ── (b) wishlist back-in-stock / price-drop alerts ────────────────────────

  @Cron('*/15 * * * *')
  async cronWishlistAlerts() {
    await this.locked('retention-wishlist-alerts', 14 * 60_000, async () => { await this.runWishlistAlerts(); });
  }

  async runWishlistAlerts(): Promise<{ checked: number; alerts: number }> {
    const { wishListModel, productVariantModel, productModel } = this.db.repositories;
    const allIds: string[] = (await wishListModel.distinct('productVariantId')).filter((id: string) => isValidObjectId(id)).slice(0, 5000);
    let checked = 0;
    let alerts = 0;
    for (let i = 0; i < allIds.length; i += 500) {
      const ids = allIds.slice(i, i + 500);
      const variants: any[] = await productVariantModel.find({ _id: { $in: ids } }).select('price stock status isDelete productId currency').lean();
      const products: any[] = await productModel.find({ _id: { $in: [...new Set(variants.map((v) => v.productId))] } }).select('name slug status isDelete').lean();
      const productById = new Map(products.map((p) => [String(p._id), p]));
      const states = await this.variantStateModel.find({ variantId: { $in: ids } }).lean();
      const stateById = new Map(states.map((s) => [s.variantId, s]));
      for (const v of variants) {
        checked++;
        const product = productById.get(String(v.productId));
        const live = !!product && product.status === 'active' && !product.isDelete && v.status === 'active' && !v.isDelete;
        const curr = { price: Number(v.price) || 0, inStock: live && Number(v.stock) > 0 };
        const vid = String(v._id);
        const state = stateById.get(vid);
        try {
          if (!state) {
            await this.variantStateModel.updateOne({ variantId: vid }, { $setOnInsert: { lastPrice: curr.price, lastInStock: curr.inStock } }, { upsert: true }).catch(() => undefined);
            continue; // first sight = baseline, never an alert
          }
          const prev = { price: state.lastPrice, inStock: state.lastInStock };
          const events = live ? detectWishlistEvents(prev, curr) : [];
          // Baseline follows rises and alerted drops; a small (<5%) drop keeps the old reference so slow drops still add up.
          const nextPrice = events.includes('price_drop') || curr.price > prev.price ? curr.price : prev.price;
          if (curr.inStock === prev.inStock && nextPrice === prev.price) continue;
          const won = await this.variantStateModel.findOneAndUpdate(
            { variantId: vid, lastPrice: state.lastPrice, lastInStock: state.lastInStock },
            { $set: { lastPrice: nextPrice, lastInStock: curr.inStock } },
          );
          if (!won || !events.length) continue; // another instance owns this transition
          alerts += await this.dispatchWishlistEvents(vid, product, v, events);
        } catch (err: any) {
          this.logger.warn(`wishlist alert for variant ${vid} failed: ${err?.message}`);
        }
      }
    }
    return { checked, alerts };
  }

  private async dispatchWishlistEvents(variantId: string, product: any, variant: any, events: ('back_in_stock' | 'price_drop')[]): Promise<number> {
    const rows: any[] = await this.db.repositories.wishListModel.find({ productVariantId: variantId }).select('userId').limit(2000).lean();
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const path = `/product/${product.slug || product._id}`;
    const link = `${WEB()}${path}`;
    const name = String(product.name ?? 'An item');
    const priceText = `${variant.currency ?? ''} ${Number(variant.price).toLocaleString('en-US')}`.trim();
    let sent = 0;
    for (const userId of userIds) {
      if (!(await this.contactable(userId))) continue;
      for (const ev of events) {
        const isStock = ev === 'back_in_stock';
        await this.notifications.notify({
          recipientId: userId, recipientRole: 'user',
          type: isStock ? NOTIFICATION_TYPES.WISHLIST_BACK_IN_STOCK : NOTIFICATION_TYPES.WISHLIST_PRICE_DROP,
          title: isStock ? 'Back in stock' : 'Price drop on a saved item',
          body: isStock ? `"${name}" from your Saved list is available again.` : `"${name}" is now ${priceText}.`,
          data: { link: path, productId: String(product._id) },
          email: {
            subject: isStock ? `Back in stock: ${name}` : `Price drop: ${name}`,
            html: notificationEmailShell(isStock ? 'Back in stock' : 'Price drop', `<p><strong>${escapeHtml(name)}</strong> ${isStock ? 'from your Saved list is available again.' : `is now ${escapeHtml(priceText)}.`}</p>`, { label: 'View item', url: link }),
          },
          channelEvent: { event: ev, vars: { product: name.slice(0, 60), price: priceText, link } },
        });
        sent++;
      }
    }
    return sent;
  }

  // ── (c) shareable wishlist ────────────────────────────────────────────────

  async getMyShare(userId: string) {
    const s = await this.shareModel.findOne({ userId }).lean();
    return { success: true, data: { active: !!s, token: s?.token ?? null, url: s ? `${WEB()}/wishlist/shared/${s.token}` : null } };
  }

  async createShare(userId: string) {
    let s = await this.shareModel.findOne({ userId }).lean();
    if (!s) {
      try {
        s = (await this.shareModel.create({ userId, token: randomBytes(24).toString('base64url') })).toObject();
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
        s = await this.shareModel.findOne({ userId }).lean();
      }
    }
    return { success: true, data: { active: true, token: s!.token, url: `${WEB()}/wishlist/shared/${s!.token}` } };
  }

  async revokeShare(userId: string) {
    await this.shareModel.deleteOne({ userId });
    return { success: true, message: 'Share link turned off', data: { active: false, token: null, url: null } };
  }

  /** Public read-only view: product cards only - no owner name, id, store ids or notes. */
  async publicShare(token: string) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException('This link is not available');
    const share = await this.shareModel.findOne({ token }).lean();
    if (!share) throw new NotFoundException('This link is not available');
    const rows: any[] = await this.db.repositories.wishListModel.find({ userId: share.userId }).sort({ createdAt: -1 }).limit(200).select('productId').lean();
    const ids = [...new Set(rows.map((r) => String(r.productId)))].filter((id) => isValidObjectId(id));
    const products = (await this.productsService.getShapedProductsByIds(ids, null)).map((p: any) => sanitizeDigitalForPublicView(p));
    return { success: true, data: { count: products.length, items: products } };
  }

  // ── (d) referrals ─────────────────────────────────────────────────────────

  async getSettings(): Promise<ReferralSettings> {
    const doc: any = await this.settingsModel.findOne({ key: 'default' }).lean();
    return cleanReferralSettings(doc?.referral ?? {}, DEFAULT_REFERRAL_SETTINGS);
  }

  async updateSettings(body: any) {
    const next = cleanReferralSettings(body, await this.getSettings());
    await this.settingsModel.updateOne({ key: 'default' }, { $set: { referral: next } }, { upsert: true });
    return { success: true, message: 'Referral settings saved', data: next };
  }

  private async ensureCode(userId: string): Promise<string> {
    const existing = await this.codeModel.findOne({ userId }).lean();
    if (existing) return existing.code;
    for (let i = 0; i < 5; i++) {
      try {
        return (await this.codeModel.create({ userId, code: generateReferralCode() })).code;
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
        const again = await this.codeModel.findOne({ userId }).lean(); // same user raced us
        if (again) return again.code;
      }
    }
    throw new BadRequestException('Could not create a referral code, please try again');
  }

  async myReferral(userId: string) {
    const settings = await this.getSettings();
    const code = settings.enabled ? await this.ensureCode(userId) : (await this.codeModel.findOne({ userId }).lean())?.code ?? null;
    const [pending, rewarded, mine] = await Promise.all([
      this.referralModel.countDocuments({ referrerId: userId, status: { $in: ['pending', 'rewarding'] } }),
      this.referralModel.countDocuments({ referrerId: userId, status: 'rewarded' }),
      this.referralModel.findOne({ refereeId: userId }).select('status').lean(),
    ]);
    return {
      success: true,
      data: {
        enabled: settings.enabled,
        code,
        shareUrl: code ? `${WEB()}/register?ref=${code}` : null,
        reward: { type: settings.rewardType, value: settings.rewardValue, label: describeReward(settings.rewardType, settings.rewardValue), friendLabel: settings.refereeRewardValue > 0 ? describeReward(settings.rewardType, settings.refereeRewardValue) : null, expiryDays: settings.expiryDays },
        stats: { pending, rewarded, cap: settings.maxRewardsPerReferrer },
        // whether this buyer was referred (never says who) - lets the UI hide the "enter a code" box
        referredByAnyone: !!mine,
      },
    };
  }

  private ipHash(ip?: string | null) {
    return ip ? createHmac('sha256', process.env.JWT_SECRET ?? '').update(String(ip)).digest('hex').slice(0, 32) : null;
  }

  async applyCode(userId: string, rawCode: unknown, ip?: string | null) {
    const settings = await this.getSettings();
    if (!settings.enabled) throw new BadRequestException('Referral codes are not available right now');
    if (!isValidReferralCodeShape(rawCode)) throw new BadRequestException('That referral code is not valid');
    const code = String(rawCode).trim().toUpperCase();
    const owner = await this.codeModel.findOne({ code }).lean();
    if (!owner) throw new BadRequestException('That referral code is not valid');
    if (owner.userId === userId) throw new BadRequestException('You cannot use your own referral code');

    const { userModel, orderModel } = this.db.repositories;
    const [referee, referrer]: any[] = await Promise.all([
      userModel.findOne({ _id: userId, isDelete: false }).select('email phone createdAt').lean(),
      userModel.findOne({ _id: owner.userId, isDelete: false, status: { $nin: BLOCKED_STATUSES } }).select('email phone').lean(),
    ]);
    if (!referee || !referrer) throw new BadRequestException('That referral code is not valid');
    if (Date.now() - new Date(referee.createdAt).getTime() > REFERRAL_WINDOW_DAYS * 86400_000) {
      throw new BadRequestException(`Referral codes can only be added in your first ${REFERRAL_WINDOW_DAYS} days`);
    }
    if (await orderModel.exists({ userId, isDelete: false })) throw new BadRequestException('Referral codes are for new buyers who have not ordered yet');
    if (await this.referralModel.exists({ refereeId: userId })) throw new BadRequestException('You have already used a referral code');

    const ipHash = this.ipHash(ip);
    const sameIpReferrals = ipHash ? await this.referralModel.countDocuments({ referrerId: owner.userId, ipHash }) : 0;
    const verdict = evaluateReferral({
      referrer: { id: owner.userId, email: referrer.email, phone: referrer.phone },
      referee: { id: userId, email: referee.email, phone: referee.phone },
      sameIpReferrals, referrerRewardedCount: 0, maxRewardsPerReferrer: settings.maxRewardsPerReferrer,
    });
    try {
      await this.referralModel.create({
        referrerId: owner.userId, refereeId: userId, code, ipHash,
        status: verdict.ok ? 'pending' : 'flagged', reason: verdict.ok ? null : verdict.reason,
      });
    } catch (err: any) {
      if (err?.code === 11000) throw new BadRequestException('You have already used a referral code');
      throw err;
    }
    // Same answer whether or not it was flagged: the abuse rules are not revealed.
    return { success: true, message: 'Referral code applied', data: { applied: true } };
  }

  @Cron('*/30 * * * *')
  async cronReferralRewards() {
    await this.locked('retention-referral-rewards', 25 * 60_000, async () => { await this.sweepReferralRewards(); });
  }

  /** Rewards referrals whose referee has a PAID and COMPLETED (delivered) order that is not under a return. */
  async sweepReferralRewards(now = new Date()): Promise<{ rewarded: number; flagged: number }> {
    const settings = await this.getSettings();
    if (!settings.enabled) return { rewarded: 0, flagged: 0 };
    const { orderModel, userModel } = this.db.repositories;
    const pending = await this.referralModel.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(200).lean();
    let rewarded = 0;
    let flagged = 0;
    for (const ref of pending) {
      try {
        const order: any = await orderModel
          .findOne({ userId: ref.refereeId, isPaid: true, paymentStatus: 'paid', orderStatus: 'completed', isDelete: false, hasReturnApproved: { $ne: true } })
          .select('shippingAddress').lean();
        if (!order) {
          if (now.getTime() - new Date((ref as any).createdAt).getTime() > REFERRAL_PENDING_MAX_DAYS * 86400_000) {
            await this.referralModel.updateOne({ _id: ref._id, status: 'pending' }, { $set: { status: 'flagged', reason: 'no_qualifying_order' } });
            flagged++;
          }
          continue;
        }
        const claimed = await this.referralModel.findOneAndUpdate({ _id: ref._id, status: 'pending' }, { $set: { status: 'rewarding' } });
        if (!claimed) continue;
        try {
          const [referrer, referee]: any[] = await Promise.all([
            userModel.findOne({ _id: ref.referrerId, isDelete: false, status: { $nin: BLOCKED_STATUSES } }).select('email phone').lean(),
            userModel.findOne({ _id: ref.refereeId, isDelete: false, status: { $nin: BLOCKED_STATUSES } }).select('email phone').lean(),
          ]);
          if (!referrer || !referee) { await this.referralModel.updateOne({ _id: ref._id }, { $set: { status: 'flagged', reason: 'account_unavailable' } }); flagged++; continue; }
          const verdict = evaluateReferral({
            referrer: { id: ref.referrerId, email: referrer.email, phone: referrer.phone },
            referee: { id: ref.refereeId, email: referee.email, phone: referee.phone },
            refereeOrderPhone: order.shippingAddress?.phone ?? null,
            sameIpReferrals: ref.ipHash ? await this.referralModel.countDocuments({ referrerId: ref.referrerId, ipHash: ref.ipHash, _id: { $ne: ref._id } }) : 0,
            referrerRewardedCount: await this.referralModel.countDocuments({ referrerId: ref.referrerId, status: 'rewarded' }),
            maxRewardsPerReferrer: settings.maxRewardsPerReferrer,
          });
          if (!verdict.ok) { await this.referralModel.updateOne({ _id: ref._id }, { $set: { status: 'flagged', reason: verdict.reason } }); flagged++; continue; }
          const codes: string[] = [];
          const referrerCode = settings.rewardValue > 0 ? await this.createRewardCoupon(settings, settings.rewardValue, now) : null;
          if (referrerCode) codes.push(referrerCode);
          const refereeCode = settings.refereeRewardValue > 0 ? await this.createRewardCoupon(settings, settings.refereeRewardValue, now) : null;
          if (refereeCode) codes.push(refereeCode);
          await this.referralModel.updateOne({ _id: ref._id }, { $set: { status: 'rewarded', rewardedAt: now, rewardCodes: codes } });
          rewarded++;
          if (referrerCode) await this.notifyReward(ref.referrerId, referrerCode, settings, settings.rewardValue);
          if (refereeCode) await this.notifyReward(ref.refereeId, refereeCode, settings, settings.refereeRewardValue);
        } catch (err: any) {
          await this.referralModel.updateOne({ _id: ref._id, status: 'rewarding' }, { $set: { status: 'pending' } }); // retry next sweep
          throw err;
        }
      } catch (err: any) {
        this.logger.warn(`referral ${String(ref._id)} sweep failed: ${err?.message}`);
      }
    }
    return { rewarded, flagged };
  }

  /** The reward is a single-use platform coupon (the loyalty module is per-store and plan-gated, so it cannot carry a platform reward). */
  private async createRewardCoupon(settings: ReferralSettings, value: number, now: Date): Promise<string> {
    for (let i = 0; i < 4; i++) {
      const code = `REF${randomBytes(4).toString('hex').toUpperCase()}`;
      try {
        await this.db.repositories.couponModel.create({
          scope: 'platform', adminId: null, code, discountType: settings.rewardType, discountValue: value,
          currency: settings.rewardType === 'fixed' ? 'USD' : null, minOrderAmount: settings.minOrderUSD,
          usageLimit: 1, expiresAt: new Date(now.getTime() + settings.expiryDays * 86400_000),
        });
        return code;
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
      }
    }
    throw new Error('could not allocate a unique reward code');
  }

  private async notifyReward(userId: string, code: string, settings: ReferralSettings, value: number) {
    const label = describeReward(settings.rewardType, value);
    const link = `${WEB()}/cart`;
    await this.notifications.notify({
      recipientId: userId, recipientRole: 'user', type: NOTIFICATION_TYPES.REFERRAL_REWARD,
      title: 'Your referral reward is here',
      body: `Use code ${code} at checkout for ${label}. Valid for ${settings.expiryDays} days.`,
      data: { link: '/account/dashboard', code },
      email: { subject: 'Your Edudeen referral reward', html: notificationEmailShell('Your referral reward', `<p>Thanks for spreading the word! Use code <strong>${escapeHtml(code)}</strong> at checkout for <strong>${escapeHtml(label)}</strong>. It is valid for ${settings.expiryDays} days and works once.</p>`, { label: 'Go to my cart', url: link }) },
      channelEvent: { event: 'referral_reward', vars: { code, link } },
    });
  }
}
