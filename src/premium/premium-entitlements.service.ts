/* eslint-disable prettier/prettier */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { PremiumMembership, PremiumMembershipDocument, PremiumSettings, PremiumSettingsDocument } from './premium.schemas';
import { DEFAULT_CHILDREN_LIMIT, DEFAULT_PREMIUM_SETTINGS, Entitlements, NON_PREMIUM, premiumLinePrice, PremiumSettingsShape, PremiumTerms, premiumPercentFor, termsFromSettings } from './premium.util';

const CACHE_TTL_SECONDS = 60;
const key = (userId: string) => `premium:ent:${userId}`;

/**
 * Light, dependency-free-ish read side of Edudeen Premium. Other modules (children, products, checkout, cart,
 * contact, retention, marketing) inject it as an OPTIONAL dependency, so their existing specs keep working.
 * Redis-cached ~60s; every membership change calls invalidate().
 */
@Injectable()
export class PremiumEntitlementsService {
  private readonly logger = new Logger(PremiumEntitlementsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    @InjectModel(PremiumMembership.name) private readonly membershipModel: Model<PremiumMembershipDocument>,
    @Optional() @InjectModel(PremiumSettings.name) private readonly settingsModel?: Model<PremiumSettingsDocument>,
  ) {}

  private settingsCache: { at: number; settings: PremiumSettingsShape } | null = null;

  /** Admin settings (platform offer, premium sale fee, min gap). Defaults when never saved or the read fails. ~15s per-instance cache. */
  async getSettings(): Promise<PremiumSettingsShape> {
    if (this.settingsCache && Date.now() - this.settingsCache.at < 15_000) return this.settingsCache.settings;
    let settings: PremiumSettingsShape = { ...DEFAULT_PREMIUM_SETTINGS, platformDiscount: { ...DEFAULT_PREMIUM_SETTINGS.platformDiscount } };
    try {
      const row: any = this.settingsModel ? await this.settingsModel.findOne({ key: 'default' }).lean() : null;
      if (row) {
        settings = {
          platformDiscount: { enabled: row.platformDiscount?.enabled ?? true, percent: Number(row.platformDiscount?.percent ?? 5) },
          premiumSellerFeePercent: Number(row.premiumSellerFeePercent ?? 5),
          minGapPercent: Number(row.minGapPercent ?? 5),
        };
      }
    } catch (err: any) { this.logger.warn(`premium settings read failed, using defaults: ${err?.message}`); }
    this.settingsCache = { at: Date.now(), settings };
    return settings;
  }

  /** Effective numbers for pricing/fees/validation (platformPercent is 0 when the offer is off). */
  async getTerms(): Promise<PremiumTerms> { return termsFromSettings(await this.getSettings()); }

  invalidateSettings() { this.settingsCache = null; }

  async getEntitlements(userId?: string | null): Promise<Entitlements> {
    if (!userId || typeof userId !== 'string') return NON_PREMIUM;
    try {
      const cached = await this.redis.get(key(userId));
      if (cached) return JSON.parse(cached) as Entitlements;
    } catch { /* cache is best-effort */ }
    const ent = await this.compute(userId);
    try { await this.redis.set(key(userId), JSON.stringify(ent), CACHE_TTL_SECONDS); } catch { /* ignore */ }
    return ent;
  }

  async invalidate(userId: string): Promise<void> {
    try { await this.redis.del(key(userId)); } catch { /* ignore */ }
  }

  private async compute(userId: string): Promise<Entitlements> {
    const m: any = await this.membershipModel.findOne({ userId, status: 'active', currentPeriodEnd: { $gt: new Date() } }).lean();
    if (!m) return NON_PREMIUM;
    const b = m.planSnapshot?.benefits ?? {};
    return {
      isPremium: true,
      childrenLimit: Math.max(DEFAULT_CHILDREN_LIMIT, Number(b.childrenLimit) || 15),
      earlyAccessHours: Math.max(0, Number(b.earlyAccessHours) || 0),
      prioritySupport: b.prioritySupport !== false,
    };
  }

  /** Contact form is anonymous: match the typed email to an account, then to an active membership. */
  async isPremiumEmail(email: string): Promise<boolean> {
    try {
      const user: any = await this.db.repositories.userModel.findOne({ email: String(email).trim().toLowerCase(), isDelete: false }).select('_id').lean();
      if (!user) return false;
      const ent = await this.getEntitlements(String(user._id));
      return ent.isPremium && ent.prioritySupport;
    } catch { return false; }
  }

  /** Users to notify first: those of `userIds` with an active membership (cron ordering only). */
  async premiumUserIdSet(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const rows: any[] = await this.membershipModel.find({ userId: { $in: userIds }, status: 'active', currentPeriodEnd: { $gt: new Date() } }).select('userId').lean();
    return new Set(rows.map((r) => String(r.userId)));
  }

  /** One query: store premium settings keyed by store id. */
  async loadStoreSettings(storeIds: string[]): Promise<Map<string, any>> {
    const ids = [...new Set(storeIds.filter((s) => typeof s === 'string' && isValidObjectId(s)))];
    if (!ids.length) return new Map();
    const stores: any[] = await this.db.repositories.storeModel.find({ _id: { $in: ids } }).select('premiumDiscount').lean();
    return new Map(stores.map((s) => [String(s._id), s]));
  }

  /**
   * Adds premium price info to shaped products (each with `variants`). EVERYONE gets the teaser `premiumPercent`
   * (seller% + platform% combined) plus the breakdown `premiumSellerPercent` / `premiumPlatformPercent`; only an
   * active member also gets, per variant, `listPrice` (the original price to strike through), `premiumPrice` and the
   * same percents. R1: for a member the normal sale, campaign badge and store-subscriber price are not applied on a
   * line that has a premium price (checkout is the source of truth and charges the same number).
   */
  async decorateProducts<T extends Record<string, any>>(products: T[], userId?: string | null, opts: { storeSettings?: Map<string, any> } = {}): Promise<T[]> {
    if (!products.length) return products;
    try {
      const settings = opts.storeSettings ?? (await this.loadStoreSettings(products.map((p) => String(p.storeId))));
      const isMember = (await this.getEntitlements(userId)).isPremium;
      const terms = await this.getTerms();
      return products.map((p) => {
        const sellerPct = premiumPercentFor(p as any, settings.get(String(p.storeId)));
        if (!sellerPct) return p;
        const total = Math.round((sellerPct + terms.platformPercent) * 100) / 100;
        const out: any = { ...p, premiumPercent: total, premiumSellerPercent: sellerPct, premiumPlatformPercent: terms.platformPercent };
        if (isMember && Array.isArray(p.variants)) {
          let applied = false;
          out.variants = p.variants.map((v: any) => {
            const calc = premiumLinePrice(v.price, v.originalCompareAtPrice ?? v.compareAtPrice, sellerPct, terms.platformPercent);
            if (!calc.applies) return v;
            // Premium competes with the normal price a buyer would pay on this variant (running % sale, store-subscriber price):
            // when that is lower or equal, no premium price is offered and the sale / subscriber price stays visible.
            const camp = p.activeCampaign;
            const campUnit = camp?.discountType === 'percentage' && camp.discountValue ? Math.round(v.price * (1 - camp.discountValue / 100) * 100) / 100 : v.price;
            const normalUnit = Math.min(campUnit, typeof v.subscriberPrice === 'number' ? v.subscriberPrice : Infinity);
            if (!(calc.unit < normalUnit)) return v;
            applied = true;
            const { subscriberPrice: _a, youSaveUSD: _b, discountPercent: _c, subscriberPlanName: _d, minOrderValueUSD: _e, ...rest } = v;
            return { ...rest, listPrice: calc.listUnit, premiumPrice: calc.unit, premiumDiscountPercent: calc.totalPercent, premiumSellerPercent: calc.sellerPercent, premiumPlatformPercent: calc.platformPercent };
          });
          if (applied && out.activeCampaign) out.activeCampaign = null;
        }
        return out as T;
      });
    } catch (err: any) {
      this.logger.warn(`premium decoration skipped: ${err?.message}`);
      return products;
    }
  }}
