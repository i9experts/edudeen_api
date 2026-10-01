/* eslint-disable prettier/prettier */
import { escapeHtml } from 'src/notifications/templates/notification-email.template';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { ExchangeRateService } from 'src/exchange-rate/exchange-rate.service';
import { EmailService } from 'src/otp/services/email.service';
import { UpdateGiftCardSettingsDto } from './dto/update-gift-card-settings.dto';
import { IssueManualGiftCardDto } from './dto/issue-manual-gift-card.dto';
import { CreatePurchaseIntentDto } from './dto/create-purchase-intent.dto';
import { randomBytes } from 'crypto';
import Stripe from 'stripe';

import { clampInt } from 'src/common/query-safety.util';
function generateGiftCardCode(): string {
  // Grouped for readability when a buyer types it in manually (e.g. reading
  // it off a printed/emailed card) — e.g. "GC4F2A-9KRT".
  const raw = randomBytes(5).toString('hex').toUpperCase();
  return `GC${raw.slice(0, 4)}-${raw.slice(4)}`;
}

@Injectable()
export class GiftCardsService {
  private stripe: InstanceType<typeof Stripe> | undefined;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY')?.trim();
    if (secretKey) {
      this.stripe = new Stripe(secretKey, { apiVersion: '2025-04-30.basil' as any });
    }
  }

  private get r() {
    return this.databaseService.repositories;
  }

  private round(n: number) {
    return Math.round(n * 100) / 100;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  private async getOrCreateSettings(storeId: string) {
    let settings = await this.r.giftCardSettingsModel.findOne({ storeId });
    if (!settings) settings = await this.r.giftCardSettingsModel.create({ storeId });
    return settings;
  }

  // ── Seller-facing ─────────────────────────────────────────────────────────

  async getSettings(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const settings = await this.getOrCreateSettings(storeId);
    return { success: true, message: 'Gift card settings', data: settings };
  }

  async updateSettings(sellerId: string, storeId: string, dto: UpdateGiftCardSettingsDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    await this.getOrCreateSettings(storeId);
    const settings = await this.r.giftCardSettingsModel.findOneAndUpdate(
      { storeId },
      { $set: dto },
      { returnDocument: 'after' },
    );
    return { success: true, message: 'Gift card settings updated', data: settings };
  }

  /** Seller issues a gift card directly — no purchase, e.g. a goodwill
   *  credit or service-recovery gesture — same pattern real platforms
   *  (Shopify's manual gift card issuance) offer alongside buyer purchase. */
  async issueManual(sellerId: string, storeId: string, dto: IssueManualGiftCardDto) {
    const store = await this.verifyStoreOwnership(storeId, sellerId);
    const currency = store.baseCurrency ?? 'USD';
    const settings = await this.getOrCreateSettings(storeId);

    const expiresAt = settings.neverExpires
      ? null
      : (() => { const d = new Date(); d.setMonth(d.getMonth() + settings.expiryMonths); return d; })();

    const giftCard = await this.createGiftCardRecord({
      storeId, currency, value: dto.value, issuedBy: 'manual',
      issuedByUserId: sellerId, recipientEmail: dto.recipientEmail ?? null,
      recipientName: dto.recipientName ?? null, message: dto.message ?? null,
      purchaserUserId: null, expiresAt,
    });

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'gift_card_issued',
      description: `${giftCard.code} — ${currency} ${dto.value} issued manually`,
      actorId: sellerId, actorRole: 'seller', targetId: String(giftCard._id), targetType: 'gift_card',
    });

    if (dto.recipientEmail) {
      this.sendGiftCardEmail(dto.recipientEmail, dto.recipientName ?? null, store.name, giftCard.code, currency, dto.value, dto.message ?? null).catch(() => {});
    }

    return { success: true, message: 'Gift card issued', data: giftCard };
  }

  async listGiftCards(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const page = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(100, Math.max(1, clampInt(query.limit, 20, 1, 100)));
    const filter: any = { storeId, isDelete: false };
    if (query.status) filter.status = query.status;
    if (query.code) filter.code = new RegExp(String(query.code).trim(), 'i');

    const [items, total] = await Promise.all([
      this.r.giftCardModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.giftCardModel.countDocuments(filter),
    ]);
    return { success: true, message: 'Gift cards', data: { items, total, page, limit } };
  }

  async disableGiftCard(sellerId: string, storeId: string, giftCardId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const giftCard = await this.r.giftCardModel.findOneAndUpdate(
      { _id: giftCardId, storeId, isDelete: false },
      { status: 'disabled' },
      { returnDocument: 'after' },
    );
    if (!giftCard) throw new NotFoundException('Gift card not found');

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'gift_card_disabled',
      description: `${giftCard.code} disabled`, actorId: sellerId, actorRole: 'seller',
      targetId: giftCardId, targetType: 'gift_card',
    });

    return { success: true, message: 'Gift card disabled', data: giftCard };
  }

  // ── Buyer-facing ──────────────────────────────────────────────────────────

  async getPublicSettings(storeId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false, status: 'active' }).select('baseCurrency');
    if (!store) throw new NotFoundException('Store not found');
    const settings = await this.getOrCreateSettings(storeId);
    return {
      success: true,
      data: {
        purchaseEnabled: settings.purchaseEnabled,
        denominations: settings.denominations,
        currency: store.baseCurrency ?? 'USD',
      },
    };
  }

  private assertStripeConfigured() {
    if (!this.stripe) throw new BadRequestException('Online payments are not configured');
    return this.stripe;
  }

  /** Creates a standalone Stripe PaymentIntent for a gift-card purchase —
   *  deliberately outside the buyer Cart/Checkout/Order pipeline (a gift
   *  card isn't a Product — no variant, no shipping, no stock), same
   *  precedent as the platform-plans billing engine's own direct
   *  PaymentIntent/SetupIntent usage. Finalization happens the same way
   *  every other Stripe charge in this codebase does — via the existing
   *  webhook (`PaymentService.stripeWebhook`, keyed on this intent's
   *  `metadata.purpose`), never trusting a client-side "it succeeded" call. */
  async createPurchaseIntent(userId: string, storeId: string, dto: CreatePurchaseIntentDto) {
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false, status: 'active' });
    if (!store) throw new NotFoundException('Store not found');
    const settings = await this.getOrCreateSettings(storeId);
    if (!settings.purchaseEnabled) throw new BadRequestException('Gift cards aren\'t available for purchase at this store');

    const currency = store.baseCurrency ?? 'USD';
    const stripe = this.assertStripeConfigured();

    // Stripe only ever processes USD in this codebase (see PaymentService) —
    // the gift card's own face value/currency stays in the store's native
    // currency (matching Coupon's convention), converted only for the
    // actual charge.
    const amountUSD = currency === 'USD' ? dto.amount : await this.exchangeRateService.convert(dto.amount, currency, 'USD');
    const amountCents = Math.round(this.round(amountUSD) * 100);
    if (amountCents < 50) throw new BadRequestException('Amount is too small to process');

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      metadata: {
        purpose: 'gift_card_purchase',
        storeId,
        userId,
        amount: String(dto.amount),
        currency,
        recipientEmail: dto.recipientEmail ?? '',
        recipientName: dto.recipientName ?? '',
        message: (dto.message ?? '').slice(0, 480),
      },
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    return {
      success: true,
      message: 'Payment initiated',
      data: { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id, amount: dto.amount, currency },
    };
  }

  /** Called from PaymentService.stripeWebhook on `payment_intent.succeeded`
   *  when `metadata.purpose === 'gift_card_purchase'` — mirrors
   *  finalizePaymentIntent's dedup convention (a redelivered webhook must
   *  never issue the gift card twice). */
  async finalizeGiftCardPurchase(paymentIntent: { id: string; metadata: Record<string, string> }) {
    const existing = await this.r.giftCardTransactionModel.findOne({ checkoutId: paymentIntent.id, type: 'issue' });
    if (existing) return; // already processed this exact PaymentIntent

    const { storeId, userId, amount, currency, recipientEmail, recipientName, message } = paymentIntent.metadata;
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) return;

    const settings = await this.getOrCreateSettings(storeId);
    const expiresAt = settings.neverExpires
      ? null
      : (() => { const d = new Date(); d.setMonth(d.getMonth() + settings.expiryMonths); return d; })();

    const value = parseFloat(amount) || 0;
    const giftCard = await this.createGiftCardRecord({
      storeId, currency: currency || 'USD', value, issuedBy: 'purchase',
      issuedByUserId: null, purchaserUserId: userId,
      recipientEmail: recipientEmail || null, recipientName: recipientName || null,
      message: message || null, expiresAt, purchaseIntentId: paymentIntent.id,
    });

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'gift_card_purchased',
      description: `${giftCard.code} — ${currency} ${value} purchased`,
      actorId: userId, actorRole: 'user', targetId: String(giftCard._id), targetType: 'gift_card',
    });

    const deliverTo = recipientEmail || null;
    if (deliverTo) {
      this.sendGiftCardEmail(deliverTo, recipientName || null, store.name, giftCard.code, currency || 'USD', value, message || null).catch(() => {});
    }
  }

  // ── Checkout redemption (called from CheckoutService) ────────────────────

  async findRedeemable(storeId: string, code: string) {
    return this.r.giftCardModel.findOne({
      storeId, code: code.toUpperCase(), status: 'active', isDelete: false,
      balance: { $gt: 0 },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    });
  }

  /** Decrements balance at order-placement time (never at apply-time — an
   *  abandoned checkout must not burn a gift card's balance), mirroring the
   *  Coupon usageCount / RewardVoucher status pattern. */
  async redeemAtOrderPlacement(storeId: string, code: string, amount: number, checkoutId: string, orderId: string) {
    // Idempotent per checkout: a retried createOrder must not debit the card twice.
    const already = await this.r.giftCardTransactionModel.exists({ storeId, checkoutId, type: 'redeem' });
    if (already) return;

    // Atomic, clamped debit: take min(balance, amount) in ONE update so two
    // checkouts holding the same card can never drive it negative or both take
    // the full amount. `returnDocument: 'before'` tells us what was really taken.
    const before = await this.r.giftCardModel.findOneAndUpdate(
      { storeId, code: code.toUpperCase(), status: 'active', balance: { $gt: 0 }, redeemedCheckoutIds: { $ne: checkoutId } },
      [{
        $set: {
          balance: { $max: [0, { $round: [{ $subtract: ['$balance', amount] }, 2] }] },
          redeemedCheckoutIds: { $concatArrays: [{ $ifNull: ['$redeemedCheckoutIds', []] }, [checkoutId]] },
        },
      }],
      { returnDocument: 'before', updatePipeline: true },
    );
    if (!before) {
      // Either the card is empty/disabled, or THIS checkout already debited it
      // (a concurrent retry that lost the race) — the latter is not a shortfall.
      const alreadyDebited = await this.r.giftCardModel.exists({
        storeId, code: code.toUpperCase(), redeemedCheckoutIds: checkoutId,
      });
      if (alreadyDebited) return;
    }

    const available = before ? before.balance : 0;
    const deducted = Math.round(Math.min(available, amount) * 100) / 100;
    const shortfall = Math.round((amount - deducted) * 100) / 100;

    if (shortfall > 0) {
      // The order was already placed/paid with this discount applied and can't be
      // rejected now — never swallow it: the card no longer covered the discount,
      // so the store/platform absorbs `shortfall`. Surface it for review.
      await this.activityLogService.log({
        storeId,
        category: 'marketing',
        action: 'gift_card_shortfall',
        description: `Gift card ${code.toUpperCase()} covered only ${deducted} of the ${amount} discount applied to checkout ${checkoutId} (shortfall ${shortfall})`,
        actorId: 'system',
        actorRole: 'system',
        isSecurityAlert: true,
        targetId: before ? String(before._id) : checkoutId,
        targetType: before ? 'gift_card' : 'checkout',
      });
    }
    if (!before) return; // nothing was left to debit

    await this.r.giftCardTransactionModel.create({
      storeId, giftCardId: String(before._id), type: 'redeem', amount: -deducted,
      balanceAfter: Math.round((available - deducted) * 100) / 100, checkoutId, orderId,
      description: shortfall > 0 ? `Applied at checkout (short by ${shortfall})` : 'Applied at checkout',
    });
  }

  private async createGiftCardRecord(opts: {
    storeId: string; currency: string; value: number; issuedBy: 'purchase' | 'manual';
    issuedByUserId: string | null; purchaserUserId: string | null; recipientEmail: string | null;
    recipientName: string | null; message: string | null; expiresAt: Date | null; purchaseIntentId?: string;
  }) {
    let giftCard: any = null;
    for (let attempt = 0; attempt < 3 && !giftCard; attempt++) {
      try {
        giftCard = await this.r.giftCardModel.create({
          storeId: opts.storeId, code: generateGiftCardCode(), currency: opts.currency,
          initialValue: opts.value, balance: opts.value, issuedBy: opts.issuedBy,
          issuedByUserId: opts.issuedByUserId, purchaserUserId: opts.purchaserUserId,
          recipientEmail: opts.recipientEmail, recipientName: opts.recipientName,
          message: opts.message, expiresAt: opts.expiresAt,
        });
      } catch (e: any) {
        if (e?.code !== 11000) throw e; // duplicate code — regenerate and retry
      }
    }
    if (!giftCard) throw new BadRequestException('Could not generate a gift card code, please try again');

    await this.r.giftCardTransactionModel.create({
      storeId: opts.storeId, giftCardId: String(giftCard._id), type: 'issue',
      amount: opts.value, balanceAfter: giftCard.balance,
      checkoutId: opts.purchaseIntentId ?? null, description: opts.issuedBy === 'purchase' ? 'Purchased' : 'Issued manually',
    });

    return giftCard;
  }

  private async sendGiftCardEmail(
    to: string, recipientName: string | null, storeName: string, code: string,
    currency: string, value: number, message: string | null,
  ) {
    // recipientName / message are typed by the purchaser and storeName by the seller: escape them, or the platform's
    // own mail identity relays arbitrary HTML (phishing links) to any address the purchaser names.
    const safeStore = escapeHtml(storeName);
    const greeting = recipientName ? `Hi ${escapeHtml(recipientName)},` : 'Hi,';
    const noteBlock = message ? `<p style="font-style:italic;color:#555">"${escapeHtml(message)}"</p>` : '';
    const subject = `You've received a ${currency} ${value} gift card from ${storeName}`.replace(/[\r\n]+/g, ' ');
    await this.emailService.sendMail(
      to,
      subject,
      `<div style="font-family:sans-serif">
        <p>${greeting}</p>
        <p>You've received a gift card for <strong>${safeStore}</strong>.</p>
        ${noteBlock}
        <p style="font-size:24px;font-weight:bold;letter-spacing:1px;background:#f5f5f5;padding:16px;border-radius:8px;text-align:center">${escapeHtml(code)}</p>
        <p>Enter this code at checkout on ${safeStore}'s store to redeem it.</p>
      </div>`,
    );
  }
}
