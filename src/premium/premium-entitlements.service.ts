/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { PremiumMembership, PremiumMembershipDocument } from './premium.schemas';
import { DEFAULT_CHILDREN_LIMIT, Entitlements, NON_PREMIUM, premiumPercentFor, premiumUnitPrice } from './premium.util';

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
  ) {}

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
   * (seller's chosen percent); only an active member also gets `premiumPrice` + `premiumDiscountPercent` on each
   * variant. Products already on a campaign sale, or whose subscriber price is as good, get no premiumPrice
   * (checkout takes the best single seller-side discount per line and is the source of truth).
   */
  async decorateProducts<T extends Record<string, any>>(products: T[], userId?: string | null, opts: { storeSettings?: Map<string, any> } = {}): Promise<T[]> {
    if (!products.length) return products;
    try {
      const settings = opts.storeSettings ?? (await this.loadStoreSettings(products.map((p) => String(p.storeId))));
      const isMember = (await this.getEntitlements(userId)).isPremium;
      return products.map((p) => {
        const pct = premiumPercentFor(p as any, settings.get(String(p.storeId)));
        if (!pct) return p;
        const out: any = { ...p, premiumPercent: pct };
        if (isMember && !p.activeCampaign && Array.isArray(p.variants)) {
          out.variants = p.variants.map((v: any) => {
            const unit = premiumUnitPrice(v.price, pct);
            if (typeof v.subscriberPrice === 'number' && v.subscriberPrice <= unit) return v;
            return { ...v, premiumPrice: unit, premiumDiscountPercent: pct };
          });
        }
        return out as T;
      });
    } catch (err: any) {
      this.logger.warn(`premium decoration skipped: ${err?.message}`);
      return products;
    }
  }
}
