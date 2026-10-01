/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { PaymentGatewayService } from 'src/subscriptions/payment-gateway/payment-gateway.service';
import { AiCreditsService } from './ai-credits.service';
import { verifyStoreOwnershipStrict } from 'src/common/store-ownership.util';
import { PurchaseAddonDto } from './dto/purchase-addon.dto';

import { clampInt } from 'src/common/query-safety.util';
/**
 * One-off / recurring add-on purchases — "Extra AI Credits", "Additional
 * Staff Seats", "Priority Marketplace Placement" etc. from the pricing
 * page's add-ons row. Independent of the base PlatformPlan: a store can buy
 * these regardless of tier, without a full plan upgrade.
 *
 * Pricing table is intentionally simple/flat (not a database-driven catalog
 * like PlatformPlan) — these are small, fixed-price add-ons; making them
 * admin-configurable would be reasonable future work but wasn't required
 * for the core plan/entitlement system.
 */
const ADDON_PRICING: Record<string, { priceUSD: number; recurring: boolean; unitLabel: string }> = {
  extra_ai_credits: { priceUSD: 10, recurring: false, unitLabel: '500 credits' },
  priority_marketplace_placement: { priceUSD: 29, recurring: true, unitLabel: 'month' },
  advanced_tax_compliance: { priceUSD: 15, recurring: true, unitLabel: 'month' },
  sms_notifications: { priceUSD: 5, recurring: true, unitLabel: 'month (base enablement fee)' },
};

const RETIRED_ADDON_TYPES = new Set(['extra_staff_seat']);

@Injectable()
export class PlatformAddonsService {
  private readonly logger = new Logger(PlatformAddonsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: PaymentGatewayService,
    private readonly activityLogService: ActivityLogService,
    private readonly aiCreditsService: AiCreditsService,
  ) {}

  private get addonModel() { return this.db.repositories.platformAddonPurchaseModel; }
  private get storeModel() { return this.db.repositories.storeModel; }
  private round(n: number) { return Math.round(n * 100) / 100; }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    return verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
  }

  private addMonth(date: Date): Date {
    const d = new Date(date);
    d.setMonth(d.getMonth() + 1);
    return d;
  }

  /** Keeps Store.badges in sync when a priority-placement add-on is purchased/canceled — reuses the same 'featured' badge the marketplace listing already sorts/highlights on. */
  private async syncPriorityPlacementBadge(storeId: string) {
    try {
      const [store, hasActive] = await Promise.all([
        this.storeModel.findById(storeId),
        this.addonModel.exists({ storeId, addonType: 'priority_marketplace_placement', status: 'active' }),
      ]);
      if (!store) return;
      const currentlyFeatured = (store.badges ?? []).includes('featured');
      if (hasActive && !currentlyFeatured) {
        store.badges = [...(store.badges ?? []), 'featured'];
        await store.save();
      } else if (!hasActive && currentlyFeatured) {
        // Only remove if the plan itself doesn't also grant it — check plan entitlement first.
        const planGrantsFeatured = await this.db.repositories.sellerPlatformSubscriptionModel
          .findOne({ storeId })
          .then(async (sub: any) => {
            if (!sub) return false;
            const plan = await this.db.repositories.platformPlanModel.findById(sub.platformPlanId).lean();
            return !!(plan as any)?.limits?.marketplaceFeaturedBadge;
          });
        if (!planGrantsFeatured) {
          store.badges = (store.badges ?? []).filter((b: string) => b !== 'featured');
          await store.save();
        }
      }
    } catch (err: any) {
      this.logger.warn(`Priority-placement badge sync failed for store ${storeId}: ${err?.message}`);
    }
  }

  async purchaseAddon(sellerId: string, storeId: string, dto: PurchaseAddonDto, idempotencyKey?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const pricing = ADDON_PRICING[dto.addonType];
    if (!pricing) throw new BadRequestException('Unknown add-on type');

    const quantity = dto.quantity ?? 1;
    const totalPriceUSD = this.round(pricing.priceUSD * quantity);

    const sub = await this.db.repositories.sellerPlatformSubscriptionModel.findOne({ storeId, isDelete: false });
    // With a client Idempotency-Key the Stripe charge is deduplicated too (a double-click or a retry
    // after a timeout used to create a second charge AND a second credit pack — the key was Date.now()-based).
    const charge = await this.gateway.chargeSubscription(`addon_${storeId}_${dto.addonType}_${Date.now()}`, totalPriceUSD, {
      providerCustomerId: sub?.stripeCustomerId ?? undefined,
      ...(idempotencyKey ? { idempotencyKey: `addon_${storeId}_${dto.addonType}_${idempotencyKey}` } : {}),
    });
    if (!charge.success) {
      throw new BadRequestException(`Payment of $${totalPriceUSD.toFixed(2)} failed — ${charge.failureReason ?? 'declined'}`);
    }

    const addon = await this.addonModel.create({
      storeId, sellerId, addonType: dto.addonType,
      recurring: pricing.recurring, priceUSD: totalPriceUSD, quantity,
      status: 'active',
      nextBillingDate: pricing.recurring ? this.addMonth(new Date()) : null,
      providerChargeId: charge.providerChargeId,
    });

    // Immediate effects
    if (dto.addonType === 'extra_ai_credits') {
      try {
        await this.aiCreditsService.grant(storeId, sellerId, quantity * 500, `Purchased ${quantity} × 500 AI credits`, 'purchase');
      } catch (err: any) {
        // The card was charged and the purchase row exists but the credits didn't land — never silent.
        this.logger.error(`AI credit grant failed after charge ${charge.providerChargeId}: ${err?.message}`);
        await this.activityLogService.log({
          storeId, category: 'platform_plans', action: 'addon_credits_grant_failed',
          description: `Charged ${charge.providerChargeId} for ${quantity} × 500 AI credits but the wallet grant failed — grant manually`,
          actorRole: 'system', isSecurityAlert: true, targetId: (addon as any)._id.toString(), targetType: 'platform_addon_purchase',
        });
      }
    }
    if (dto.addonType === 'priority_marketplace_placement') {
      await this.syncPriorityPlacementBadge(storeId);
    }

    this.activityLogService.log({
      storeId, category: 'platform_plans', action: 'addon_purchased',
      description: `Purchased add-on "${dto.addonType}" ×${quantity} — $${totalPriceUSD.toFixed(2)}${pricing.recurring ? '/mo' : ''}`,
      actorId: sellerId, actorRole: 'seller',
      targetId: (addon as any)._id.toString(), targetType: 'platform_addon_purchase',
    });

    return { success: true, message: 'Add-on purchased', data: addon };
  }

  async listAddons(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const addons = await this.addonModel.find({ storeId }).sort({ createdAt: -1 }).lean();
    return { success: true, data: addons };
  }

  async cancelAddon(sellerId: string, storeId: string, addonId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const addon = await this.addonModel.findOne({ _id: addonId, storeId });
    if (!addon) throw new NotFoundException('Add-on purchase not found');
    if (addon.status === 'canceled') throw new BadRequestException('Add-on is already canceled');

    addon.status = 'canceled';
    addon.nextBillingDate = null;
    await addon.save();

    if (addon.addonType === 'priority_marketplace_placement') {
      await this.syncPriorityPlacementBadge(storeId);
    }

    this.activityLogService.log({
      storeId, category: 'platform_plans', action: 'addon_canceled',
      description: `Add-on "${addon.addonType}" canceled — no further billing`,
      actorId: sellerId, actorRole: 'seller',
      targetId: addonId, targetType: 'platform_addon_purchase',
    });

    return { success: true, message: 'Add-on canceled. No further charges.' };
  }

  /** Effective extra staff-seat count from active recurring add-ons — added on top of the base plan limit (see EntitlementsService.assertCanAddStaff). */
  async getActiveExtraStaffSeats(storeId: string): Promise<number> {
    const addons = await this.addonModel.find({ storeId, addonType: 'extra_staff_seat', status: 'active' }).lean();
    return addons.reduce((sum: number, a: any) => sum + (a.quantity ?? 1), 0);
  }

  /** Runs monthly (cron) — charges every active recurring add-on whose billing date has arrived. Failed charges cancel the add-on (lower stakes than the core plan, so no multi-attempt dunning). */
  async processRecurringAddonRenewals(): Promise<{ processed: number; succeeded: number; failed: number }> {
    const now = new Date();
    const due = await this.addonModel.find({ status: 'active', recurring: true, nextBillingDate: { $lte: now } });

    let succeeded = 0, failed = 0;
    for (const addon of due) {
      // Retired add-on (POS staff seats): never charge again — cancel it.
      if (RETIRED_ADDON_TYPES.has(addon.addonType)) {
        addon.status = 'canceled';
        addon.nextBillingDate = null;
        await addon.save();
        this.logger.log(`Canceled retired add-on ${addon._id} (${addon.addonType}) instead of renewing`);
        continue;
      }
      try {
        const sub = await this.db.repositories.sellerPlatformSubscriptionModel.findOne({ storeId: addon.storeId });
        const charge = await this.gateway.chargeSubscription(`addon_renewal_${addon._id}`, addon.priceUSD, {
          providerCustomerId: sub?.stripeCustomerId ?? undefined,
          // Per billing period: a crash before addon.save() re-runs with the same key and Stripe returns
          // the original charge rather than billing the seller again next tick.
          idempotencyKey: `addon_renew_${addon._id}_${new Date(addon.nextBillingDate as Date).getTime()}`,
        });

        if (charge.success) {
          addon.nextBillingDate = this.addMonth(now);
          succeeded++;
        } else {
          addon.status = 'canceled';
          addon.nextBillingDate = null;
          failed++;
          if (addon.addonType === 'priority_marketplace_placement') {
            await this.syncPriorityPlacementBadge(addon.storeId);
          }
          this.activityLogService.log({
            storeId: addon.storeId, category: 'platform_plans', action: 'addon_canceled_payment_failure',
            description: `Add-on "${addon.addonType}" auto-canceled after a failed renewal charge`,
            actorRole: 'system', targetId: (addon as any)._id.toString(), targetType: 'platform_addon_purchase',
          });
        }
        await addon.save();
      } catch (err: any) {
        this.logger.error(`Add-on renewal failed for ${addon._id}: ${err?.message}`);
        failed++;
      }
    }

    return { processed: due.length, succeeded, failed };
  }

  // ── Admin visibility ─────────────────────────────────────────────────────

  async adminListAddonPurchases(query: any) {
    const page = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(100, clampInt(query.limit, 20, 1, 100));
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (query.addonType) filter.addonType = query.addonType;
    if (query.status) filter.status = query.status;

    const [addons, total] = await Promise.all([
      this.addonModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.addonModel.countDocuments(filter),
    ]);

    const storeIds = [...new Set(addons.map((a: any) => a.storeId))];
    const stores = await this.storeModel.find({ _id: { $in: storeIds } }).select('name slug').lean();
    const storeMap = Object.fromEntries(stores.map((s: any) => [s._id.toString(), s]));

    const activeRecurringRevenueUSD = this.round(
      (await this.addonModel.find({ status: 'active', recurring: true }).lean())
        .reduce((sum: number, a: any) => sum + a.priceUSD, 0),
    );

    return {
      success: true,
      data: {
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        addons: addons.map((a: any) => ({ ...a, store: storeMap[a.storeId] ?? null })),
        activeRecurringMonthlyRevenueUSD: activeRecurringRevenueUSD,
      },
    };
  }
}
