import { ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { AnalyticsService } from 'src/analytics/analytics.service';
import { hasDirectPayment } from 'src/common/direct-payment.util';
import { buildOnboardingChecklist } from './onboarding-checklist.util';
import { storePremiumStats } from 'src/premium/premium-stats.util';
import { buildProfileCompleteness } from 'src/store/featured-stores.util';

const SHELF_SIZE = 6;

/**
 * One call for the seller dashboard (was 5 round trips from the browser plus a
 * duplicate ownership check on each). Analytics calls are Redis-cached already.
 */
@Injectable()
export class StoreDashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly analytics: AnalyticsService,
  ) {}

  async getSummary(sellerId: string, storeId: string) {
    const { storeModel, productModel, productVariantModel, payoutMethodModel, storeBannerModel, shippingZoneModel } =
      this.db.repositories;

    const store: any = await storeModel
      .findOne({ _id: storeId, sellerId, isDelete: false })
      .select('logo coverImage directPayment description')
      .lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const productFilter = { storeId, sellerId, isDelete: false };

    const [overviewRes, revenueRes, todayRes, shelfDocs, totalProducts, activeProducts, physicalProducts, payoutCount, bannerCount, zoneCount] =
      await Promise.all([
        this.analytics.getOverview(sellerId, storeId, { storeId, range: '30d' }),
        this.analytics.getRevenueOverTime(sellerId, storeId, { storeId, range: '6m', granularity: 'month' }),
        this.analytics.getTodaySummary(sellerId, storeId),
        productModel.find(productFilter).sort({ createdAt: -1 }).limit(SHELF_SIZE).lean(),
        productModel.countDocuments(productFilter),
        productModel.countDocuments({ ...productFilter, status: 'active' }),
        productModel.countDocuments({ ...productFilter, type: 'physical' }),
        payoutMethodModel.countDocuments({ storeId }),
        storeBannerModel.countDocuments({ storeId }),
        shippingZoneModel.countDocuments({ isDelete: false, status: { $ne: 'inactive' } }),
      ]);

    // Edudeen Premium (additive): member orders + the member discount this store gave, last 30 days. Never breaks the summary.
    const premium = await storePremiumStats(this.db.repositories.orderModel, storeId, new Date(Date.now() - 30 * 86_400_000))
      .catch(() => ({ premiumOrders: 0, byCurrency: [] as any[] }));

    // Shelf rows: same shape the inventory list gives    // Shelf rows: same shape the inventory list gives (productId, name, type, status, price, image).
    const ids = (shelfDocs as any[]).map((p) => String(p._id));
    const variants = ids.length
      ? await productVariantModel.find({ productId: { $in: ids }, isDelete: false }).select('productId price isDefault').lean()
      : [];
    // Default variant's price, else the first variant (same rule as the inventory list).
    const priceOf = new Map<string, { price: number; isDefault: boolean }>();
    for (const v of variants as any[]) {
      const cur = priceOf.get(v.productId);
      if (!cur || (v.isDefault && !cur.isDefault)) priceOf.set(v.productId, { price: v.price || 0, isDefault: !!v.isDefault });
    }
    const shelf = (shelfDocs as any[]).map((p) => ({
      productId: String(p._id),
      name: p.name,
      type: p.type,
      productType: p.productType ?? null,
      status: p.status,
      image: p.images?.[0] ?? null,
      price: priceOf.get(String(p._id))?.price ?? 0,
    }));

    // Profile meter = the Featured-sellers rule (logo, banner, bio 30+, 5+ published non-test products).
    const publishedForProfile = await productModel.countDocuments({ ...productFilter, status: 'active', isTest: { $ne: true } });
    const profile = buildProfileCompleteness(store, publishedForProfile);

    const checklist = buildOnboardingChecklist({
      hasLogo: !!store.logo,
      hasBanner: !!store.coverImage || bannerCount > 0,
      hasPayoutOrBank: payoutCount > 0 || hasDirectPayment(store.directPayment),
      productCount: totalProducts,
      physicalProductCount: physicalProducts,
      activeShippingZones: zoneCount,
    });

    return {
      success: true,
      data: {
        overview: (overviewRes as any).data,
        revenueSeries: (revenueRes as any).data?.series ?? [],
        today: (todayRes as any).data,
        totalProducts,
        activeProducts,
        shelf,
        checklist,
        profile,
        premium: { ...premium, windowDays: 30 },
      },
    };
  }
}
