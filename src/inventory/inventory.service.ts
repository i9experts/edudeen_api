import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
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
import { DEFAULT_LOW_STOCK_THRESHOLD, effectiveThreshold, isLowStock, parseThresholdInput } from './stock-threshold.util';
import { StockHistory } from './stock-history.schema';

/** Store-wide passes (sort by views/sales, low-quality filter) look at most this many products. */
const STORE_PASS_CAP = 2000;
const PRODUCT_STATUSES = ['draft', 'pending_review', 'active', 'scheduled', 'inactive', 'rejected'];

const STOCK_STATES = ['low', 'out', 'in', 'unlimited'] as const;
const INVENTORY_SORTS = ['name', 'price', 'stock', 'status'] as const;

/** Empty = not sent (undefined). Anything outside the allowed list = 400. */
function parseEnumParam<T extends string>(raw: unknown, allowed: readonly T[], name: string): T | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const v = String(raw);
  if (!(allowed as readonly string[]).includes(v)) throw new BadRequestException(`${name} must be one of: ${allowed.join(', ')}`);
  return v as T;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional() @InjectModel(VisitDaily.name) private readonly visitModel?: Model<VisitDaily>,
    @Optional() private readonly entitlements?: EntitlementsService,
    @Optional() @InjectModel(StockHistory.name) private readonly historyModel?: Model<StockHistory>,
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
    // Seller Categories page: "products with no subcategory" (additive, only when asked for).
    if (query.noSubcategory === '1' || query.noSubcategory === 1 || query.noSubcategory === true) {
      and.push({ $or: [{ subCategoryId: null }, { subCategoryId: '' }] });
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
    // Optional Inventory-page params (additive: callers that do not send them behave exactly as before).
    const stockState = parseEnumParam(query.stockState, STOCK_STATES, 'stockState');
    const sortBy = parseEnumParam(query.sortBy, INVENTORY_SORTS, 'sortBy');
    const order = parseEnumParam(query.order, ['asc', 'desc'] as const, 'order') ?? 'asc';
    const stockPass = !!(stockState || sortBy);
    // views/sales sort belongs to the Products page; when the stock pass is asked for it takes over.
    const sortKey = !stockPass && (query.sort === 'views' || query.sort === 'sales') ? (query.sort as 'views' | 'sales') : null;
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

    // Stock pass: filter by stock bucket and/or sort by name / price / stock / status across ALL pages.
    // Buckets use scanStock's exact rules, so a stat card count == the filtered list total.
    if (stockPass) {
      if (!(await storeCheck)) throw new ForbiddenException('Store not found or unauthorized');
      const cand: any[] = await productModel.find(filter).sort({ createdAt: -1 }).select('name type status lowStockThreshold').lean();
      const candIds = cand.map((p) => String(p._id));
      const vars: any[] = candIds.length
        ? await productVariantModel.find({ productId: { $in: candIds }, isDelete: false }).select('productId stock unlimitedStock isDefault price').lean()
        : [];
      const byProduct = new Map<string, any[]>();
      for (const v of vars) {
        const k = String(v.productId);
        if (!byProduct.has(k)) byProduct.set(k, []);
        byProduct.get(k)!.push(v);
      }
      let rows = cand.map((p) => {
        const vs = byProduct.get(String(p._id)) ?? [];
        const unlimited = p.type === 'digital' || vs.some((v) => v.unlimitedStock);
        const stock = unlimited ? Infinity : vs.reduce((s, v) => s + (v.stock || 0), 0);
        const bucket = unlimited ? 'unlimited' : stock <= 0 ? 'out' : isLowStock(stock, p.lowStockThreshold) ? 'low' : 'in';
        const def = vs.find((v) => v.isDefault) || vs[0];
        return { id: String(p._id), name: String(p.name ?? ''), status: String(p.status ?? ''), stock, bucket, price: def?.price || 0 };
      });
      if (stockState) rows = rows.filter((r) => r.bucket === stockState);
      // Array.sort is stable: ties keep newest first.
      const dir = order === 'desc' ? -1 : 1;
      const cmp: Record<string, (a: any, b: any) => number> = {
        stock: (a, b) => (a.stock === b.stock ? 0 : a.stock < b.stock ? -1 : 1),
        price: (a, b) => a.price - b.price,
        name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        status: (a, b) => a.status.localeCompare(b.status),
      };
      if (sortBy) rows.sort((a, b) => dir * cmp[sortBy](a, b));
      filter._id = { $in: rows.map((r) => r.id) };
      orderedIds = rows.slice(skip, skip + limit).map((r) => r.id);
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
        else if (isLowStock(totalStock, product.lowStockThreshold)) stockStatus = 'low_stock';
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
        // Why a listing is "In review" (display only; nothing about review rules changes).
        reviewReason: product.status === 'pending_review'
          ? (Array.isArray(product.flags) && product.flags.includes('contact_info')
              ? 'Contact details found in the text'
              : product.approvedAt ? 'Update waiting for review' : 'First publish: waiting for approval')
          : null,
        // Seller's "running low" line: the effective value (default 10) + whether the seller set their own.
        lowStockThreshold: effectiveThreshold(product.lowStockThreshold),
        hasCustomThreshold: typeof product.lowStockThreshold === 'number',
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

  /** Seller sets (or clears with null) the "running low" line of ONE of their products. */
  async setLowStockThreshold(sellerId: string, storeId: string, productId: string, rawThreshold: unknown) {
    const threshold = parseThresholdInput(rawThreshold);
    if (threshold === undefined) throw new BadRequestException('threshold must be a whole number from 0 to 1000 (or null for the default)');
    const { productModel, storeModel } = this.databaseService.repositories;
    if (!(await storeModel.exists({ _id: storeId, sellerId, isDelete: false }))) throw new ForbiddenException('Store not found or unauthorized');
    const res: any = await (productModel as any).updateOne({ _id: productId, storeId, sellerId, isDelete: false }, { $set: { lowStockThreshold: threshold } });
    if (!res?.matchedCount) throw new NotFoundException('Product not found in this store');
    return { success: true, data: { productId, lowStockThreshold: effectiveThreshold(threshold), hasCustomThreshold: threshold !== null } };
  }

  /** Last stock changes (manual + bulk) of one product, newest first. Seller only, own store only. */
  async getStockHistory(sellerId: string, storeId: string, productId: string, limitRaw?: unknown) {
    const { productModel, storeModel } = this.databaseService.repositories;
    if (!(await storeModel.exists({ _id: storeId, sellerId, isDelete: false }))) throw new ForbiddenException('Store not found or unauthorized');
    if (!(await productModel.exists({ _id: productId, storeId, isDelete: false }))) throw new NotFoundException('Product not found in this store');
    const limit = clampInt(limitRaw, 20, 1, 20);
    const rows: any[] = this.historyModel
      ? await this.historyModel.find({ storeId, productId }).sort({ createdAt: -1 }).limit(limit).lean()
      : [];
    return {
      success: true,
      data: {
        items: rows.map((r) => ({ id: String(r._id), old: r.old, new: r.new, source: r.source, createdAt: r.createdAt })),
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
        threshold: DEFAULT_LOW_STOCK_THRESHOLD, // platform default; each item carries its own `threshold`
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
      .select('name type lowStockThreshold')
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
    const items: { productId: any; name: string; stock: number; threshold: number }[] = [];
    for (const p of products as any[]) {
      const id = p._id.toString();
      if (p.type === 'digital' || unlimitedProducts.has(id)) {
        stats.unlimited++;
        continue;
      }
      const stock = stockByProduct.get(id) ?? 0;
      if (stock <= 0) stats.outOfStock++;
      else if (isLowStock(stock, p.lowStockThreshold)) {
        stats.lowStock++;
        items.push({ productId: p._id, name: p.name, stock, threshold: effectiveThreshold(p.lowStockThreshold) });
      } else stats.inStock++;
    }
    items.sort((x, y) => x.stock - y.stock);
    return { stats, items };
  }}
