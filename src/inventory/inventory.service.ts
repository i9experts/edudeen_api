import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { courseTotals } from '../classroom/course.util';

import {
  clampInt,
  escapeRegex,
  searchTerm,
} from 'src/common/query-safety.util';
import { isValidObjectId } from 'mongoose';
import { getDescendantIds } from '../categories/category-tree.util';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { VisitDaily } from '../analytics-visits/visit-daily.schema';
import { conversionRate, pktDateOf, pktDayStartOf } from '../analytics-visits/visit-tracking.util';
import { resolveDateRange } from '../analytics/utils/analytics-date.util';
import { productSalesRows } from '../analytics/utils/product-performance.util';
import { QUALITY_LOW, listingQuality } from '../products/product-quality.util';

const LOW_STOCK_THRESHOLD = 10;
/** Store-wide passes (sort by views/sales, low-quality filter) look at most this many products. */
const STORE_PASS_CAP = 2000;
const PRODUCT_STATUSES = ['draft', 'pending_review', 'active', 'scheduled', 'inactive', 'rejected'];

@Injectable()
export class InventoryService {
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional() @InjectModel(VisitDaily.name) private readonly visitModel?: Model<VisitDaily>,
    @Optional() private readonly entitlements?: EntitlementsService,
  ) {}

  /** Quality input from a lean product doc (+ lesson count for courses). */
  private qualityOf(p: any, lessonCount: number) {
    return listingQuality({
      name: p.name,
      isPhysical: p.type === 'physical' || p.productType === 'physical',
      isCourse: p.deliveryFormat === 'course',
      imageCount: Array.isArray(p.images) ? p.images.length : 0,
      description: p.description,
      hasCategory: !!p.categoryId,
      hasSubCategory: !!p.subCategoryId,
      classFrom: p.classFrom,
      classTo: p.classTo,
      tagCount: Array.isArray(p.tags) ? p.tags.filter(Boolean).length : 0,
      hasPreview: !!(p.digital?.sampleFile || p.digital?.preview?.enabled),
      lessonCount,
      coverStyle: p.coverStyle,
    });
  }

  private async lessonCounts(productIds: string[]): Promise<Map<string, number>> {
    if (!productIds.length) return new Map();
    const courses: any[] = await (this.databaseService.repositories as any).courseModel
      .find({ productId: { $in: productIds } })
      .select('productId sections')
      .lean();
    return new Map(courses.map((c: any) => [String(c.productId), courseTotals(c.sections).lessonCount] as [string, number]));
  }

  /**
   * Last 30 PKT days (the Analytics page default) of views and booked sales, from the SAME sources as the
   * Analytics Products table: `analytics_visit_daily` and `productSalesRows`. productIds = null -> whole store.
   */
  private async metrics30d(storeId: string, productIds: string[] | null) {
    const { from, to } = resolveDateRange({ range: '30d' }, { pkt: true });
    const fromDate = pktDateOf(from);
    const toDate = pktDateOf(to);
    let trackingSince: string | null = null;
    const views = new Map<string, number>();
    if (this.visitModel) {
      const first: any = await this.visitModel.findOne({ storeId }).sort({ pktDate: 1 }).select('pktDate').lean();
      trackingSince = first?.pktDate ?? null;
      if (trackingSince) {
        const rows = await this.visitModel.aggregate([
          { $match: { storeId, productId: productIds ? { $in: productIds } : { $ne: '' }, pktDate: { $gte: fromDate, $lte: toDate } } },
          { $group: { _id: '$productId', visits: { $sum: '$visits' } } },
        ]);
        for (const r of rows as any[]) views.set(String(r._id), r.visits);
      }
    }
    const trackingFrom = trackingSince ? pktDayStartOf(trackingSince) : null;
    const scope: Record<string, any> = { 'sellerOrders.storeId': storeId };
    if (productIds) scope['sellerOrders.items.productId'] = { $in: productIds };
    const { rows } = await productSalesRows((this.databaseService.repositories as any).orderModel, from, to, scope, trackingFrom);
    const sales = new Map(rows.filter((r) => r.productId).map((r) => [r.productId as string, r]));
    return { trackingSince, views, sales };
  }

  async getStoreInventory(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const { productModel, productVariantModel, storeModel } =
      this.databaseService.repositories;

    // seller ka store he ya nahi - checked in parallel with the data reads below (every read is scoped by
    // storeId + sellerId, so nothing leaks before the check throws); this saves one DB round trip.
    const storeCheck = Promise.resolve(storeModel.exists({ _id: storeId, sellerId, isDelete: false }));
    // Store-wide, unfiltered stats (own two queries, independent of the page below)
    const statsPromise = this.computeStockStats(storeId, sellerId);

    // filters
    const filter: any = { storeId, sellerId, isDelete: false };
    if (query.type && query.type !== 'all') filter.type = query.type;
    if (query.status && query.status !== 'all') {
      // One status, or a comma list (the Active tab = "active,scheduled"). Unknown values keep the old behaviour.
      const parts = String(query.status).split(',').map((s) => s.trim()).filter(Boolean);
      filter.status = parts.length > 1 && parts.every((s) => PRODUCT_STATUSES.includes(s)) ? { $in: parts } : String(query.status);
    }
    const and: any[] = [];
    if (query.deliveryFormat && query.deliveryFormat !== 'all') {
      if (query.deliveryFormat === 'course') and.push({ deliveryFormat: 'course' });
      else if (query.deliveryFormat === 'download') and.push({ deliveryFormat: { $ne: 'course' } });
      else throw new BadRequestException('deliveryFormat must be download or course');
    }
    if (query.categoryId) {
      if (!isValidObjectId(String(query.categoryId))) throw new BadRequestException('categoryId is not valid');
      const ids = await getDescendantIds(this.databaseService.repositories.categoryModel as any, String(query.categoryId));
      and.push({ $or: [{ categoryId: { $in: ids } }, { subCategoryId: { $in: ids } }] });
    }
    if (and.length) filter.$and = and;

    // ?q= — case-insensitive name or SKU match (SKU lives on the variants, so
    // resolve matching variants within this store's products first).
    const q = searchTerm(query.q);
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const storeProductIds = (
        await productModel.distinct('_id', filter)
      ).map((id: any) => id.toString());
      const skuMatches = storeProductIds.length
        ? await productVariantModel.distinct('productId', {
            productId: { $in: storeProductIds },
            isDelete: false,
            sku: rx,
          })
        : [];
      filter.$or = [{ name: rx }, { _id: { $in: skuMatches } }];
    }

    const page = clampInt(query.page, 1, 1, 100000);
    // Honour ?limit= (pickers ask for bigger pages), bounded.
    const limit = clampInt(query.limit, 10, 1, 100);
    const skip = (page - 1) * limit;

    // Store-wide passes (cap STORE_PASS_CAP): "Low quality" filter and sort by views / sales 30d.
    const lowQuality = query.quality === 'low';
    const sortKey = query.sort === 'views' || query.sort === 'sales' ? (query.sort as 'views' | 'sales') : null;
    let orderedIds: string[] | null = null;
    if (lowQuality || sortKey) {
      if (!(await storeCheck)) throw new ForbiddenException('Store not found or unauthorized');
      if (lowQuality) {
        const cand: any[] = await productModel.find(filter).sort({ createdAt: -1 }).limit(STORE_PASS_CAP)
          .select('name type productType deliveryFormat images description categoryId subCategoryId classFrom classTo tags digital.sampleFile digital.preview.enabled coverStyle').lean();
        const lessons = await this.lessonCounts(cand.filter((p) => p.deliveryFormat === 'course').map((p) => String(p._id)));
        const lowIds = cand.filter((p) => this.qualityOf(p, lessons.get(String(p._id)) ?? 0).score < QUALITY_LOW).map((p) => p._id);
        filter._id = { $in: lowIds };
      }
      if (sortKey) {
        const ids: any[] = await productModel.find(filter).sort({ createdAt: -1 }).limit(STORE_PASS_CAP).select('_id').lean();
        const m = await this.metrics30d(storeId, null);
        const val = (id: string) => (sortKey === 'views' ? (m.views.get(id) ?? -1) : (m.sales.get(id)?.orders ?? 0));
        orderedIds = ids.map((x) => String(x._id));
        orderedIds.sort((a, b) => val(b) - val(a)); // stable: ties keep newest first
        orderedIds = orderedIds.slice(skip, skip + limit);
      }
    }

    const pageProducts = async () => {
      let found: any[];
      if (orderedIds) {
        const rows: any[] = orderedIds.length ? await productModel.find({ _id: { $in: orderedIds }, storeId, sellerId, isDelete: false }).lean() : [];
        const byId = new Map(rows.map((r) => [String(r._id), r]));
        found = orderedIds.map((id) => byId.get(id)).filter(Boolean);
      } else {
        found = await productModel
          .find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean();
      }
      // har product ke variants fetch karo
      const ids = found.map((p: any) => p._id.toString());
      const variants = ids.length
        ? await productVariantModel.find({ productId: { $in: ids }, isDelete: false }).lean()
        : [];
      // One query for the lesson count / minutes of every online course on this page.
      const courseIds = found.filter((p: any) => p.deliveryFormat === 'course').map((p: any) => p._id.toString());
      const courses: any[] = courseIds.length
        ? await (this.databaseService.repositories as any).courseModel.find({ productId: { $in: courseIds } }).select('productId sections').lean()
        : [];
      return { found, variants, courses };
    };
    const [store, totalProducts, { found: products, variants: allVariants, courses: pageCourses }, stats] = await Promise.all([
      storeCheck,
      productModel.countDocuments(filter),
      pageProducts(),
      statsPromise,
    ]);
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const totalPages = Math.ceil(totalProducts / limit);

    // productId → variants map
    const variantMap: Record<string, any[]> = {};
    for (const v of allVariants) {
      if (!variantMap[v.productId]) variantMap[v.productId] = [];
      variantMap[v.productId].push(v);
    }

    const courseSummaryById = new Map<string, { lessonCount: number; totalMinutes: number }>(
      (pageCourses ?? []).map((c: any) => [String(c.productId), courseTotals(c.sections)] as [string, { lessonCount: number; totalMinutes: number }]),
    );

    // 30-day views / sales for THIS PAGE's products only. Conversion is Pro-only (fails closed without entitlements).
    const pageIds = products.map((p: any) => String(p._id));
    let pageMetrics: Awaited<ReturnType<InventoryService['metrics30d']>> | null = null;
    let convAllowed = false;
    if (pageIds.length) {
      try {
        pageMetrics = await this.metrics30d(storeId, pageIds);
        convAllowed = this.entitlements ? !!(await this.entitlements.getLimits(storeId)).advancedAnalyticsAllowed : false;
      } catch {
        pageMetrics = null; // metrics are decoration: never break the product list
      }
    }
    const pageLessons = await this.lessonCounts(
      products.filter((p: any) => p.deliveryFormat === 'course').map((p: any) => String(p._id)),
    ).catch(() => new Map<string, number>());

    const productList = products.map((product: any) => {
      const pid = String(product._id);
      const sale = pageMetrics?.sales.get(pid);
      const views30d = pageMetrics?.trackingSince ? (pageMetrics.views.get(pid) ?? 0) : null;
      const quality = this.qualityOf(product, pageLessons.get(pid) ?? 0);
      const variants = variantMap[product._id.toString()] || [];
      const isDigital = product.type === 'digital';
      const hasUnlimitedVariant = variants.some((v: any) => v.unlimitedStock);

      let stockDisplay: string | number = '∞ Unlimited';
      let stockStatus = 'active';
      let price = 0;

      if (!isDigital && !hasUnlimitedVariant) {
        const totalStock = variants.reduce(
          (sum: number, v: any) => sum + (v.stock || 0),
          0,
        );
        stockDisplay = totalStock;

        if (totalStock === 0) stockStatus = 'out_of_stock';
        else if (totalStock <= LOW_STOCK_THRESHOLD) stockStatus = 'low_stock';
        else stockStatus = 'active';
      }

      // default variant ki price, fallback to min price
      const defaultVariant =
        variants.find((v: any) => v.isDefault) || variants[0];
      price = defaultVariant?.price || 0;

      // default variant ka sku
      const sku = defaultVariant?.sku || null;

      const prices = variants
        .map((v: any) => v.price)
        .filter((p: any) => typeof p === 'number');
      const minPrice = prices.length ? Math.min(...prices) : price;
      const maxPrice = prices.length ? Math.max(...prices) : price;

      return {
        productId: product._id,
        sku,
        name: product.name,
        description: product.description ?? null,
        image: product.images?.[0] ?? null,
        slug: (product as any).slug ?? null,
        images: product.images ?? [],
        type: product.type,
        productType: product.productType,
        deliveryFormat: (product as any).deliveryFormat ?? 'download',
        courseSummary: (product as any).deliveryFormat === 'course' ? (courseSummaryById.get(String(product._id)) ?? { lessonCount: 0, totalMinutes: 0 }) : null,
        stock: stockDisplay,
        stockStatus,
        status: product.status,
        scheduledAt: product.scheduledAt ?? null,
        // Why an admin sent the listing back (status 'rejected').
        reviewNote: (product as any).reviewNote ?? null,
        // A seller edit of this live listing is waiting for admin approval / was declined.
        hasPendingEdit: !!(product as any).pendingEdit?.submittedAt,
        pausedByPlan: !!(product as any).pausedFromStatus,
        editRejection: (product as any).lastEditRejection?.reason ?? null,
        price,
        compareAtPrice: defaultVariant?.compareAtPrice ?? null,
        allTimeSales: product.purchaseCount || 0,
        // Last 30 PKT days, same rules as Analytics -> Products. views30d null = no tracked day yet.
        views30d,
        sales30d: sale?.orders ?? 0,
        conversionPct: convAllowed && views30d !== null ? conversionRate(sale?.trackedOrders ?? 0, views30d) : null,
        conversionLocked: !convAllowed,
        qualityScore: quality.score,
        qualityMissing: quality.missing,
        tags: product.tags ?? [],
        // physical-only (defaultVariant fields)
        options: defaultVariant?.options ?? [],
        shippingWeight: defaultVariant?.shippingWeight ?? null,
        variantCount: variants.length,
        // Lets the Inventory page edit stock inline for single-variant products.
        defaultVariantId: defaultVariant?._id ?? null,
        minPrice,
        maxPrice,
        // Offers (seller bulk tool): platform sales this product is in + its Premium member offer
        campaignIds: Array.isArray(product.campaignIds) ? product.campaignIds : [],
        premiumDiscountPercent: product.premiumDiscountPercent ?? null,
        premiumOptOut: product.premiumOptOut === true,
        // digital-only — full config so re-opening Edit repopulates correctly
        digital: product.digital ?? null,
      };
    });

    return {
      success: true,
      data: {
        stats,
        pagination: {
          page,
          limit,
          totalPages,
          totalProducts,
        },
        products: productList,
      },
    };
  }

  // Store-wide low-stock summary for the seller dashboard's alert card —
  // unlike getStoreInventory above, this isn't paginated (it needs the true
  // store-wide count/list, not just the current page) and only returns the
  // items that actually need attention. Digital products are excluded —
  // they always have `stock: 0` and would otherwise show up as permanently
  // low/out of stock.
  async getLowStockSummary(sellerId: string, storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const { productModel, productVariantModel, storeModel } =
      this.databaseService.repositories;

    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const { items } = await this.scanStock(storeId, sellerId);

    return {
      success: true,
      data: {
        count: items.length,
        threshold: LOW_STOCK_THRESHOLD,
        items,
      },
    };
  }

  // Single source for the Inventory/Products stat cards AND the low-stock
  // alert list: every non-deleted product of the store (all statuses). Each
  // product lands in exactly one bucket, so
  // inStock + lowStock + outOfStock + unlimited === totalProducts.
  // Digital products and products with an unlimited-stock variant are
  // "unlimited" (never low/out of stock).
  private async computeStockStats(storeId: string, sellerId: string) {
    const { productModel } = this.databaseService.repositories;
    // ONE $group by status (store-wide, unfiltered) feeds the tab counts.
    const [{ stats }, grouped] = await Promise.all([
      this.scanStock(storeId, sellerId),
      productModel.aggregate([
        { $match: { storeId, sellerId, isDelete: false } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
    ]);
    const statusCounts: Record<string, number> = {};
    for (const g of grouped as any[]) if (g._id) statusCounts[g._id] = g.n;
    return { ...stats, statusCounts };
  }

  private async scanStock(storeId: string, sellerId: string) {
    const { productModel, productVariantModel } = this.databaseService.repositories;
    const products = await productModel
      .find({ storeId, sellerId, isDelete: false })
      .select('name type')
      .lean();

    const productIds = products.map((p: any) => p._id.toString());
    const variants = productIds.length
      ? await productVariantModel
          .find({ productId: { $in: productIds }, isDelete: false })
          .select('productId stock unlimitedStock')
          .lean()
      : [];

    const stockByProduct = new Map<string, number>();
    const unlimitedProducts = new Set<string>();
    for (const v of variants) {
      if ((v as any).unlimitedStock) {
        unlimitedProducts.add(v.productId);
        continue;
      }
      stockByProduct.set(v.productId, (stockByProduct.get(v.productId) ?? 0) + (v.stock || 0));
    }

    const stats = { totalProducts: products.length, inStock: 0, lowStock: 0, outOfStock: 0, unlimited: 0 };
    const items: { productId: any; name: string; stock: number }[] = [];
    for (const p of products as any[]) {
      const id = p._id.toString();
      if (p.type === 'digital' || unlimitedProducts.has(id)) {
        stats.unlimited++;
        continue;
      }
      const stock = stockByProduct.get(id) ?? 0;
      if (stock <= 0) stats.outOfStock++;
      else if (stock <= LOW_STOCK_THRESHOLD) {
        stats.lowStock++;
        items.push({ productId: p._id, name: p.name, stock });
      } else stats.inStock++;
    }
    items.sort((x, y) => x.stock - y.stock);
    return { stats, items };
  }}
