import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { isValidObjectId } from 'mongoose';

import { DatabaseService } from 'src/database/databaseservice';
import { ProductType as StoreProductType } from 'src/store/schemas/store.schema';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { MarketingService } from 'src/marketing/marketing.service';
import { pickPrimaryCampaignForBadge } from 'src/marketing/campaign-pricing.util';
import { EducationLevel } from './schemas/product.schema';
import { EducationLevelService } from './education-level.service';
import { UploadService } from 'src/upload/upload.service';
import { generateUniqueSlug } from 'src/common/slug.util';
import { RedisService } from 'src/redis/redis.service';
import { aggregateProductSales } from 'src/analytics/utils/order-aggregation.util';
import {
  PREVIEW_RATE_LIMIT_MAX,
  PREVIEW_RATE_LIMIT_WINDOW_SECONDS,
} from './constants/preview.constants';
import { optionNameSet, optionsKey, validateOptions } from './variant-options.util';
import { AttributesService } from 'src/attributes/attributes.service';

const EDUCATION_LEVEL_VALUES: string[] = Object.values(EducationLevel);

@Injectable()
export class ProductsService {
  constructor(
    private databaseService: DatabaseService,
    private activityLogService: ActivityLogService,
    private subscriptionBenefits: SubscriptionBenefitsService,
    private entitlementsService: EntitlementsService,
    private educationLevelService: EducationLevelService,
    private marketingService: MarketingService,
    private uploadService: UploadService,
    private redisService: RedisService,
    private attributesService: AttributesService,
  ) {}

  /** Attaches an `activeCampaign` badge summary (or null) to each product,
   *  based on whether its store currently has an active platform-sale
   *  campaign. Same lookup CheckoutService uses to enforce the discount, so
   *  a product never shows a "sale" badge checkout wouldn't actually honor.
   *  One batched query for the whole page, not per-product. */
  private async attachCampaignBadges<T extends { storeId?: string }>(
    products: T[],
  ): Promise<T[]> {
    const storeIds = [
      ...new Set(products.map((p) => p.storeId).filter(Boolean)),
    ] as string[];
    const campaignsByStore = storeIds.length
      ? await this.marketingService.getActiveCampaignsForStores(storeIds)
      : new Map();

    return products.map((p) => {
      const campaigns = p.storeId ? campaignsByStore.get(p.storeId) : undefined;
      const primary = campaigns ? pickPrimaryCampaignForBadge(campaigns) : null;
      return {
        ...p,
        activeCampaign: primary
          ? {
              campaignId: primary.campaignId,
              name: primary.name,
              discountType: primary.discountType,
              discountValue: primary.discountValue,
              currency: primary.currency,
              endDate: primary.endDate,
            }
          : null,
      };
    });
  }

  /** Stamps a fresh product with an early-access window if the store has any active plan configuring one — non-subscribers can't see it until this passes. */
  private async applyEarlyAccessWindow(product: any) {
    const hours = await this.subscriptionBenefits.getStoreEarlyAccessHours(
      product.storeId,
    );
    if (!hours) return;
    product.earlyAccessUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
    await product.save();
  }

  /** True if this product should stay hidden from this requester right now (still in its early-access window and the requester isn't a subscriber with early_access). */
  private async isHiddenByEarlyAccess(
    product: any,
    customerId?: string | null,
  ): Promise<boolean> {
    if (!product.earlyAccessUntil || product.earlyAccessUntil <= new Date())
      return false;
    if (!customerId) return true;
    const entry = await this.subscriptionBenefits.getActiveBenefits(
      customerId,
      product.storeId,
    );
    return !entry || !this.subscriptionBenefits.hasEarlyAccess(entry.benefits);
  }

  // Attaches subscriberPrice/youSaveUSD/discountPercent/planName to each
  // variant when the requester has an active, discount-granting subscription
  // to the product's store. Never hides or restricts the product itself —
  // this only ever adds optional pricing metadata.
  private applySubscriberPricing(
    variants: any[],
    product: { _id: any; categoryId?: string; subCategoryId?: string | null },
    benefitsEntry: { benefits: any[]; planName: string } | undefined,
  ) {
    if (!benefitsEntry) return variants;
    return variants.map((v: any) => {
      const discount = this.subscriptionBenefits.resolveProductDiscount(
        benefitsEntry.benefits,
        product as any,
        v.price,
      );
      if (!discount) return v;
      return {
        ...v,
        subscriberPrice: discount.subscriberPrice,
        youSaveUSD: discount.savingsUSD,
        discountPercent: discount.discountPercent,
        subscriberPlanName: benefitsEntry.planName,
        minOrderValueUSD: discount.minOrderValueUSD,
      };
    });
  }

  // Strips the private Cloudinary file manifest (publicId/name/size/mimeType)
  // from a digital product's `digital.files` before it's shown to a
  // non-owner — pre-purchase browsers only need to know *how many* files
  // they'll get, never the storage manifest itself. The actual bytes are
  // only ever reachable through OrdersService's signed download flow after
  // payment, regardless of this — but the manifest shouldn't leak either.
  private sanitizeDigitalForPublicView<T extends { digital?: any }>(
    product: T,
  ): T {
    if (!product?.digital) return product;
    const { files, preview, ...safeDigital } = product.digital;
    return {
      ...product,
      digital: {
        ...safeDigital,
        fileCount: Array.isArray(files) ? files.length : 0,
        previewAvailable: !!preview?.enabled,
      },
    };
  }

  /**
   * Called from addDigitalProduct/editProduct whenever a seller's `digital`
   * payload is saved. If preview is enabled, resolves the chosen source file
   * and — for pdf/audio only, since those are stored under Cloudinary
   * resource_type 'raw' and can't be transformed in place — lazily prepares a
   * transform-capable shadow copy via UploadService.ensurePreviewSourceAsset.
   * `existingPreview` is the product's current `digital.preview` (or null for
   * a brand-new product) so we can skip re-preparing an unchanged source file.
   */
  private async prepareDigitalPreview(
    existingPreview: any,
    digital: any,
  ): Promise<any> {
    if (!digital?.preview?.enabled) {
      return {
        ...digital,
        preview: {
          enabled: false,
          sourceFileIndex: null,
          previewSourcePublicId: null,
          previewSourceResourceType: null,
        },
      };
    }

    const sourceFileIndex = digital.preview.sourceFileIndex ?? 0;
    const file = digital.files?.[sourceFileIndex];
    if (!file)
      throw new BadRequestException(
        'preview.sourceFileIndex does not match any uploaded file',
      );

    const mimeType =
      file.mimeType || this.uploadService.resolveMimeType(file.name, '');
    const unchanged =
      existingPreview?.enabled &&
      existingPreview?.sourceFileIndex === sourceFileIndex &&
      existingPreview?.previewSourcePublicId;

    let previewSourcePublicId: string | null = unchanged
      ? existingPreview.previewSourcePublicId
      : null;
    let previewSourceResourceType: 'image' | 'video' | null = unchanged
      ? existingPreview.previewSourceResourceType
      : null;

    if (!unchanged) {
      if (mimeType === 'application/pdf') {
        previewSourcePublicId =
          await this.uploadService.ensurePreviewSourceAsset(
            file.url,
            'raw',
            'image',
          );
        previewSourceResourceType = 'image';
      } else if (mimeType.startsWith('audio/')) {
        previewSourcePublicId =
          await this.uploadService.ensurePreviewSourceAsset(
            file.url,
            'raw',
            'video',
          );
        previewSourceResourceType = 'video';
      } else if (
        mimeType.startsWith('image/') ||
        mimeType.startsWith('video/')
      ) {
        previewSourcePublicId = null; // already transform-capable in place
        previewSourceResourceType = null;
      } else {
        throw new BadRequestException(
          `Preview is not supported for file type "${mimeType}"`,
        );
      }
    }

    return {
      ...digital,
      preview: {
        enabled: true,
        sourceFileIndex,
        previewSourcePublicId,
        previewSourceResourceType,
      },
    };
  }

  /** Public, pre-purchase preview of a digital product — always a watermarked/trimmed derivative, never the original file. */
  async getProductPreview(idOrSlug: string, clientIp: string) {
    const rateLimitKey = `preview:rl:${clientIp}:${idOrSlug}`;
    const count = await this.redisService.incrWithTtl(
      rateLimitKey,
      PREVIEW_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (count !== null && count > PREVIEW_RATE_LIMIT_MAX) {
      throw new HttpException(
        {
          success: false,
          message: 'Too many preview requests — please try again later',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { productModel } = this.databaseService.repositories;
    // Same slug-first, id-fallback resolution as getProductById — the
    // product-detail page passes whatever :slug route param it has.
    let product = await productModel
      .findOne({ slug: idOrSlug, status: 'active', isDelete: false })
      .lean();
    if (!product && isValidObjectId(idOrSlug)) {
      product = await productModel
        .findOne({ _id: idOrSlug, status: 'active', isDelete: false })
        .lean();
    }
    if (!product) throw new NotFoundException('Product not found');
    if (product.type !== 'digital' || !product.digital?.preview?.enabled) {
      throw new BadRequestException(
        'Preview is not available for this product',
      );
    }

    const sourceFileIndex = product.digital.preview.sourceFileIndex ?? 0;
    const file = product.digital.files?.[sourceFileIndex];
    if (!file) throw new BadRequestException('Preview source file not found');

    const mimeType =
      file.mimeType || this.uploadService.resolveMimeType(file.name, '');
    const expiresAt = Math.floor(Date.now() / 1000) + 300;

    if (mimeType === 'application/pdf') {
      if (!product.digital.preview.previewSourcePublicId)
        throw new BadRequestException(
          'Preview is not ready for this product yet',
        );
      const pages = this.uploadService.generatePreviewPdfPageUrls(
        product.digital.preview.previewSourcePublicId,
      );
      return { success: true, data: { type: 'pdf', pages, expiresAt } };
    }
    if (mimeType.startsWith('image/')) {
      return {
        success: true,
        data: {
          type: 'image',
          url: this.uploadService.generatePreviewImageUrl(file.url),
          expiresAt,
        },
      };
    }
    if (mimeType.startsWith('video/')) {
      return {
        success: true,
        data: {
          type: 'video',
          url: this.uploadService.generatePreviewVideoUrl(file.url),
          expiresAt,
        },
      };
    }
    if (mimeType.startsWith('audio/')) {
      if (!product.digital.preview.previewSourcePublicId)
        throw new BadRequestException(
          'Preview is not ready for this product yet',
        );
      return {
        success: true,
        data: {
          type: 'audio',
          url: this.uploadService.generatePreviewAudioUrl(
            product.digital.preview.previewSourcePublicId,
          ),
          expiresAt,
        },
      };
    }
    throw new BadRequestException(
      'Preview is not supported for this file type',
    );
  }

  /** Constrains a product query to only stores with `status: 'active'` —
   *  `Product.status` alone isn't enough: a store can be suspended/rejected
   *  by an admin action *after* its products were created and left
   *  `status: 'active'` on the product itself, so public browse/search must
   *  independently re-check the owning store on every request rather than
   *  relying on product-creation-time gating alone. Intersects with any
   *  `storeId.$in` the query already has (e.g. a campaign's participating
   *  stores) instead of overwriting it. */
  private async restrictToActiveStores(query: any): Promise<void> {
    const activeIds: string[] = (
      await this.databaseService.repositories.storeModel
        .find({ status: 'active', isDelete: false }, { _id: 1 })
        .lean()
    ).map((s: any) => s._id.toString());

    if (query.storeId?.$in) {
      const existing = new Set(query.storeId.$in as string[]);
      query.storeId = { $in: activeIds.filter((id) => existing.has(id)) };
    } else {
      query.storeId = { $in: activeIds };
    }
  }

  async getProductsByCategoryId(
    parentCategoryId?: string,
    page: number = 1,
    limit: number = 10,
    customerId?: string | null,
    productType?: string,
    educationLevel?: string,
    normalizedCustomLevel?: string,
    campaignId?: string,
    minPrice?: number,
    maxPrice?: number,
    minRating?: number,
    sortBy?: 'newest' | 'price_asc' | 'price_desc' | 'rating' | 'popularity',
    attributesFilter?: Record<string, string[]>,
  ): Promise<any> {
    const productModel = this.databaseService.repositories.productModel;
    const productVariantModel =
      this.databaseService.repositories.productVariantModel;
    const sellerModel = this.databaseService.repositories.sellerModel;

    const query: any = {
      status: 'active',
      isDelete: false,
    };

    // 0️⃣ Optional productType/educationLevel filters — used by verticals like the
    // Education marketplace to show only `productType: 'educational'` listings
    // from the same shared catalog, instead of a separate one. normalizedCustomLevel
    // is the Tier-2 drill-down, only meaningful when educationLevel === 'other'.
    if (productType) query.productType = productType;
    if (educationLevel) query.educationLevel = educationLevel;
    if (normalizedCustomLevel)
      query.normalizedCustomLevel = normalizedCustomLevel;

    // "Shop the Sale" — an expired/unknown/inactive/malformed campaignId (e.g. a
    // stale bookmark to a sale that's since ended) yields an intentionally
    // empty result, not an error: it should read as "nothing left on sale",
    // not a 404/500.
    if (campaignId) {
      const campaignModel = this.databaseService.repositories.campaignModel;
      const campaignBaseFilter = {
        isDelete: false,
        status: 'active',
        startDate: { $lte: new Date() },
        endDate: { $gte: new Date() },
      };
      // campaignId may be the new slug-based handle (?campaign=summer-sale)
      // or an old bookmarked raw id — try slug first, then id, same
      // resolution order as ProductsService.getProductById.
      let campaign = await campaignModel
        .findOne({ slug: campaignId, ...campaignBaseFilter })
        .select('participatingStoreIds sponsorType')
        .lean();
      if (!campaign && isValidObjectId(campaignId)) {
        campaign = await campaignModel
          .findOne({ _id: campaignId, ...campaignBaseFilter })
          .select('participatingStoreIds sponsorType')
          .lean();
      }
      // A platform-sponsored campaign applies to every store — no storeId
      // restriction at all, same universal rule as getActiveCampaignsForStores.
      if (campaign && campaign.sponsorType !== 'platform') {
        query.storeId = { $in: campaign.participatingStoreIds ?? [] };
      } else if (!campaign) {
        query.storeId = { $in: [] };
      }
    }

    // 1️⃣ Agar category ID di gayi hai to filter lagao
    //
    // A `Product` stores its category as two separate flat fields, not a
    // nested chain: `categoryId` (always the seller's store's main category)
    // and an optional `subCategoryId`. Categories are also capped at exactly
    // 2 levels (main → sub, enforced in CategoriesService), so there's no
    // deeper tree to walk here.
    //
    // So: browsing a MAIN category means "any product under it, with or
    // without a subcategory" → filter by `categoryId`. Browsing a
    // SUBCATEGORY means "only products tagged with this specific
    // subcategory" → filter by `subCategoryId`.
    if (parentCategoryId) {
      const category =
        await this.databaseService.repositories.categoryModel.findOne({
          _id: parentCategoryId,
          status: 'active',
          isDelete: false,
        });

      if (category?.parentId) {
        query.subCategoryId = parentCategoryId;
      } else {
        query.categoryId = parentCategoryId;
      }
    }

    // 1️⃣.5 Category-scoped structured attributes (subject/resource-type/
    // format/etc, defined per category via AttributesModule) — AND across
    // distinct attribute keys, OR within a single key's selected values.
    // `null` means no attribute filter was requested; an empty array is a
    // real "nothing matches" result, so only skip the query.
    if (attributesFilter && Object.keys(attributesFilter).length) {
      const matchingIds =
        await this.attributesService.filterProductIdsByAttributes(attributesFilter);
      if (matchingIds) {
        query._id = { $in: matchingIds };
      }
    }

    await this.restrictToActiveStores(query);

    // Rating lives directly on `Product`, so it's a plain query clause —
    // unlike price (see below), it never needs the variants aggregation.
    if (minRating !== undefined) {
      query.averageRating = { $gte: minRating };
    }

    const skip = (page - 1) * limit;

    // Price lives on `ProductVariant`, not `Product` (a product can have many
    // variants at different prices), so filtering/sorting by "price" — the
    // same cheapest-variant price shown to buyers as the "starting from"
    // price — requires a `$lookup` into variants rather than a plain
    // `find()`. Only pay for that join when price is actually in play;
    // every other browse (the overwhelming majority) keeps the cheap path.
    const needsPriceAggregation =
      minPrice !== undefined ||
      maxPrice !== undefined ||
      sortBy === 'price_asc' ||
      sortBy === 'price_desc';

    let total: number;
    let products: any[];

    if (needsPriceAggregation) {
      const priceRange: any = {};
      if (minPrice !== undefined) priceRange.$gte = minPrice;
      if (maxPrice !== undefined) priceRange.$lte = maxPrice;

      const pipeline: any[] = [
        { $match: query },
        {
          // `ProductVariant.productId` is stored as a plain string (not an
          // ObjectId ref), so the join needs `$toString` on the product side.
          $lookup: {
            from: productVariantModel.collection.name,
            let: { pid: { $toString: '$_id' } },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$productId', '$$pid'] },
                  status: 'active',
                  isDelete: false,
                },
              },
              { $project: { price: 1 } },
            ],
            as: '_variantsForFilter',
          },
        },
        { $addFields: { _minVariantPrice: { $min: '$_variantsForFilter.price' } } },
      ];

      if (Object.keys(priceRange).length) {
        // A product with no active variants has no price at all — exclude
        // it whenever a price filter is actually active rather than letting
        // it slip through as a false match.
        pipeline.push({ $match: { _minVariantPrice: { $ne: null, ...priceRange } } });
      }

      const sortStage =
        sortBy === 'price_asc'
          ? { _minVariantPrice: 1, _id: -1 }
          : sortBy === 'price_desc'
            ? { _minVariantPrice: -1, _id: -1 }
            : sortBy === 'rating'
              ? { averageRating: -1, _id: -1 }
              : sortBy === 'popularity'
                ? { purchaseCount: -1, _id: -1 }
                : { createdAt: -1, _id: -1 };

      pipeline.push({
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [
            { $sort: sortStage },
            { $skip: skip },
            { $limit: limit },
            { $project: { _variantsForFilter: 0, _minVariantPrice: 0 } },
          ],
        },
      });

      const [result] = await productModel.aggregate(pipeline);
      total = result?.metadata?.[0]?.total ?? 0;
      products = result?.data ?? [];
    } else {
      const sortStage =
        sortBy === 'rating'
          ? { averageRating: -1, _id: -1 }
          : sortBy === 'popularity'
            ? { purchaseCount: -1, _id: -1 }
            : { createdAt: -1, _id: -1 };

      total = await productModel.countDocuments(query);
      products = await productModel
        .find(query)
        .sort(sortStage as any)
        .skip(skip)
        .limit(limit)
        .lean();
    }

    const productIds = products.map((p) => p._id.toString());

    // 2️⃣ Variants fetch
    const variants = await productVariantModel
      .find({
        productId: { $in: productIds },
        status: 'active',
        isDelete: false,
      })
      .lean();

    const variantMap: Record<string, any[]> = {};

    for (const v of variants) {
      if (!variantMap[v.productId]) {
        variantMap[v.productId] = [];
      }
      variantMap[v.productId].push(v);
    }

    // Batch-resolve subscriber pricing across every distinct store present in
    // this page of results — one query instead of N.
    const storeIds = [
      ...new Set(products.map((p) => p.storeId).filter(Boolean)),
    ];
    const benefitsMap = await this.subscriptionBenefits.getActiveBenefitsBatch(
      customerId,
      storeIds,
    );

    // Batch-resolve seller name + verification badge across every distinct
    // seller present in this page — same one-query-instead-of-N pattern as
    // the subscriber-benefits batch above.
    const sellerIds = [
      ...new Set(products.map((p) => p.sellerId).filter(Boolean)),
    ];
    const sellers = await sellerModel
      .find({ _id: { $in: sellerIds } })
      .select('name isVerified')
      .lean();
    const sellerMap = new Map(
      sellers.map((s) => [s._id.toString(), s]),
    );

    const productsWithVariants = await this.attachCampaignBadges(
      products.map((p) => {
        const seller = sellerMap.get(p.sellerId?.toString());
        return this.sanitizeDigitalForPublicView({
          ...p,
          sellerName: seller ? seller.name : null,
          sellerVerified: seller ? !!seller.isVerified : false,
          variants: this.applySubscriberPricing(
            variantMap[p._id.toString()] || [],
            p,
            benefitsMap.get(p.storeId),
          ),
        });
      }),
    );

    return {
      message: 'Products fetched successfully',
      success: true,
      data: {
        total,
        page,
        limit,
        products: productsWithVariants,
      },
    };
  }

  /** Variants + subscriber pricing for a page of lean product docs — the same
   *  shaping `getProductsByCategoryId` does, reusable for search/recently-viewed. */
  private async attachVariantsAndPricing(
    products: any[],
    customerId?: string | null,
  ) {
    const productVariantModel =
      this.databaseService.repositories.productVariantModel;
    const sellerModel = this.databaseService.repositories.sellerModel;

    const productIds = products.map((p) => p._id.toString());
    const variants = await productVariantModel
      .find({
        productId: { $in: productIds },
        status: 'active',
        isDelete: false,
      })
      .lean();

    const variantMap: Record<string, any[]> = {};
    for (const v of variants) {
      if (!variantMap[v.productId]) variantMap[v.productId] = [];
      variantMap[v.productId].push(v);
    }

    const storeIds = [
      ...new Set(products.map((p) => p.storeId).filter(Boolean)),
    ];
    const benefitsMap = await this.subscriptionBenefits.getActiveBenefitsBatch(
      customerId ?? null,
      storeIds as string[],
    );

    // Batch-resolve seller name + verification badge across every distinct
    // seller present in this batch — same one-query-instead-of-N pattern as
    // getProductsByCategoryId, so search results and getShapedProductsByIds
    // (recently-viewed, recent searches) carry the same badge.
    const sellerIds = [
      ...new Set(products.map((p) => p.sellerId).filter(Boolean)),
    ];
    const sellers = await sellerModel
      .find({ _id: { $in: sellerIds } })
      .select('name isVerified')
      .lean();
    const sellerMap = new Map(sellers.map((s) => [s._id.toString(), s]));

    return this.attachCampaignBadges(
      products.map((p) => {
        const seller = sellerMap.get(p.sellerId?.toString());
        return this.sanitizeDigitalForPublicView({
          ...p,
          sellerName: seller ? seller.name : null,
          sellerVerified: seller ? !!seller.isVerified : false,
          variants: this.applySubscriberPricing(
            variantMap[p._id.toString()] || [],
            p,
            benefitsMap.get(p.storeId),
          ),
        });
      }),
    );
  }

  /** Keyword search over active products (name/description, case-insensitive).
   *  Same response shape as `getProductsByCategoryId` so the app parses both
   *  with one model. */
  async searchProducts(
    q: string,
    page: number = 1,
    limit: number = 20,
    customerId?: string | null,
  ) {
    const productModel = this.databaseService.repositories.productModel;

    const term = (q || '').trim();
    if (!term) {
      return {
        message: 'Search query is required',
        success: true,
        data: { total: 0, page, limit, products: [] },
      };
    }

    // User input goes into a regex — escape it so "c++" or "50% off" can't
    // break the query or turn into a pathological pattern.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');

    const query: any = {
      status: 'active',
      isDelete: false,
      $or: [{ name: regex }, { description: regex }],
    };

    await this.restrictToActiveStores(query);

    const skip = (page - 1) * limit;
    const total = await productModel.countDocuments(query);
    const products = await productModel
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const productsWithVariants = await this.attachVariantsAndPricing(
      products,
      customerId,
    );

    return {
      message: 'Products fetched successfully',
      success: true,
      data: { total, page, limit, products: productsWithVariants },
    };
  }

  /** Active products for an explicit id list, preserving the given order —
   *  ids whose product is gone/inactive are silently dropped. */
  async getShapedProductsByIds(
    productIds: string[],
    customerId?: string | null,
  ) {
    if (!productIds.length) return [];
    const productModel = this.databaseService.repositories.productModel;

    // Same active-store gate as getProductsByCategoryId/searchProducts —
    // without it, a product whose store was suspended after being pinned/
    // recently-viewed/etc. would still be servable through this id-list path.
    const query: any = {
      _id: { $in: productIds },
      status: 'active',
      isDelete: false,
    };
    await this.restrictToActiveStores(query);

    const products = await productModel.find(query).lean();

    const shaped = await this.attachVariantsAndPricing(products, customerId);
    const byId = new Map(shaped.map((p) => [p._id.toString(), p]));
    return productIds.map((id) => byId.get(id)).filter(Boolean);
  }

  // ── Storefront promotion sections (Best Seller / New Arrival / Trending / Pinned) ──
  // Public, read-only. No new schema — Best Seller/Trending are derived from the
  // same order-aggregation util analytics already uses; New Arrival is a plain
  // sort; Pinned reuses `getShapedProductsByIds` (order-preserving by id list).

  async getPinnedProducts(storeId: string, customerId?: string | null) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).lean();
    if (!store) return { success: true, data: { products: [] } };
    const products = await this.getShapedProductsByIds((store as any).pinnedProductIds ?? [], customerId);
    return { success: true, data: { products } };
  }

  async getNewArrivals(storeId: string, limit: number = 12, customerId?: string | null) {
    const productModel = this.databaseService.repositories.productModel;
    const products = await productModel
      .find({ storeId, status: 'active', isDelete: false })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return { success: true, data: { products: await this.attachVariantsAndPricing(products, customerId) } };
  }

  private async getTopSellingProducts(storeId: string, from: Date, limit: number, customerId?: string | null) {
    const { orderModel, productModel } = this.databaseService.repositories;
    const sales = await aggregateProductSales(orderModel, from, new Date(), { 'sellerOrders.storeId': storeId });
    const topIds = [...sales].sort((a, b) => b.unitsSold - a.unitsSold).slice(0, limit).map((s) => s.productId);
    if (!topIds.length) return { success: true, data: { products: [] } };

    const products = await productModel.find({ _id: { $in: topIds }, storeId, status: 'active', isDelete: false }).lean();
    const byId = new Map(products.map((p: any) => [p._id.toString(), p]));
    const ordered = topIds.map((id) => byId.get(id)).filter(Boolean);
    return { success: true, data: { products: await this.attachVariantsAndPricing(ordered, customerId) } };
  }

  /** All-time unit-sales leaderboard for a store. */
  async getBestSellers(storeId: string, limit: number = 12, customerId?: string | null) {
    return this.getTopSellingProducts(storeId, new Date(0), limit, customerId);
  }

  /** Same leaderboard, narrowed to the last 7 days — a different signal ("hot right now" vs. "sells well overall"). */
  async getTrendingProducts(storeId: string, limit: number = 12, customerId?: string | null) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return this.getTopSellingProducts(storeId, sevenDaysAgo, limit, customerId);
  }

  async getProductById(idOrSlug: string, customerId?: string | null) {
    const productModel = this.databaseService.repositories.productModel;
    const productVariantModel =
      this.databaseService.repositories.productVariantModel;
    const sellerModel = this.databaseService.repositories.sellerModel;
    const storeModel = this.databaseService.repositories.storeModel;

    // 1️⃣ Get product — resolve by slug (the canonical public URL) first,
    // falling back to the raw Mongo id so old bookmarked/shared
    // /marketplace/:id links keep working forever (ids never change, even
    // if the product is later renamed and its slug regenerates).
    let product = await productModel
      .findOne({
        slug: idOrSlug,
        status: 'active',
        isDelete: false,
      })
      .lean();

    if (!product && isValidObjectId(idOrSlug)) {
      product = await productModel
        .findOne({
          _id: idOrSlug,
          status: 'active',
          isDelete: false,
        })
        .lean();
    }

    if (product && (await this.isHiddenByEarlyAccess(product, customerId))) {
      return { message: 'Product not found', success: false, data: null };
    }

    if (!product) {
      return {
        message: 'Product not found',
        success: false,
        data: null,
      };
    }

    // 2️⃣ Get seller name
    const seller = await sellerModel
      .findOne({
        _id: product.sellerId,
      })
      .select('name isVerified')
      .lean();

    // 3️⃣ Get store slug
    const store = await storeModel
      .findOne({
        _id: product.storeId,
        isDelete: false,
      })
      .select('slug name logo followersCount status')
      .lean();

    // A suspended/rejected store's product must not be directly viewable
    // even by id — getProductsByCategoryId/searchProducts/getPublicStoreProducts
    // already gate on this via restrictToActiveStores(); this was the one
    // remaining gap where a direct product link stayed reachable.
    if (!store || store.status !== 'active') {
      return {
        message: 'Product not found',
        success: false,
        data: null,
      };
    }

    const [productWithSeller] = await this.attachCampaignBadges([
      this.sanitizeDigitalForPublicView({
        ...product,
        sellerName: seller ? seller.name : null,
        sellerVerified: seller ? !!seller.isVerified : false,
        storeSlug: store ? store.slug : null,
        storeName: store ? store.name : null,
        storeLogo: store ? store.logo : null,
        storeFollowersCount: store ? (store.followersCount ?? 0) : 0,
      }),
    ]);

    // 4️⃣ Get variants — must key off the resolved document's real _id, not
    // the route param (which may be a slug string, not the product's id).
    const rawVariants = await productVariantModel
      .find({
        productId: product._id.toString(),
        status: 'active',
        isDelete: false,
      })
      .lean();

    const benefitsEntry = await this.subscriptionBenefits.getActiveBenefits(
      customerId,
      product.storeId,
    );
    const variants = this.applySubscriberPricing(
      rawVariants,
      product,
      benefitsEntry ?? undefined,
    );

    const defaultVariant =
      variants.length > 0
        ? variants.reduce(
            (min, v) => (v.price < min.price ? v : min),
            variants[0],
          )
        : null;

    return {
      message: 'Product fetched successfully',
      success: true,
      data: {
        product: productWithSeller,
        variants,
        defaultVariant,
      },
    };
  }
  async getVariantById(variantId: string) {
    const productModel = this.databaseService.repositories.productModel;
    const productVariantModel =
      this.databaseService.repositories.productVariantModel;
    const sellerModel = this.databaseService.repositories.sellerModel;

    // 1️⃣ Get variant
    const variant = await productVariantModel
      .findOne({
        _id: variantId,
        status: 'active',
        isDelete: false,
      })
      .lean();

    if (!variant) {
      return {
        message: 'Variant not found',
        success: false,
        data: null,
      };
    }

    // 2️⃣ Get product using variant.productId
    const product = await productModel
      .findOne({
        _id: variant.productId,
        status: 'active',
        isDelete: false,
      })
      .lean();

    if (!product) {
      return {
        message: 'Product not found',
        success: false,
        data: null,
      };
    }

    // 3️⃣ Get seller name
    const seller = await sellerModel
      .findOne({
        _id: product.sellerId,
      })
      .select('name')
      .lean();

    const productWithSeller = this.sanitizeDigitalForPublicView({
      ...product,
      sellerName: seller ? seller.name : null,
    });

    return {
      message: 'Variant & Product fetched successfully',
      success: true,
      data: {
        variant,
        product: productWithSeller,
      },
    };
  }

  // ─── NEW APIS ───────────────────────────────────────────────────────────────

  async addPhysicalProduct(sellerId: string, body: any) {
    const { storeModel, sellerModel, productModel, productVariantModel } =
      this.databaseService.repositories;

    const seller = await sellerModel.findOne({
      _id: sellerId,
      status: 'active',
      isDelete: false,
    });
    if (!seller) throw new UnauthorizedException('Unauthorized seller');

    const {
      storeId,
      name,
      description,
      subCategoryId,
      images,
      tags,
      isListedOnEdudeen,
      status,
      scheduledAt,
      variants,
    } = body;

    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store) throw new BadRequestException('Store not found');
    if (store.status !== 'active')
      throw new BadRequestException('Your store is not active');

    const allowsPhysical =
      store.productTypes?.includes(StoreProductType.PHYSICAL_PRODUCTS) ||
      store.productTypes?.includes(StoreProductType.EDUCATIONAL_RESOURCES);
    if (!allowsPhysical)
      throw new BadRequestException(
        'Your store does not support physical products',
      );

    await this.entitlementsService.assertCanCreateProduct(storeId);

    if (!name) throw new BadRequestException('Product name is required');

    if (!Array.isArray(variants) || variants.length === 0) {
      throw new BadRequestException('At least one variant is required');
    }
    for (const v of variants) {
      if (v?.price === undefined || v?.price === null) {
        throw new BadRequestException('Every variant requires a price');
      }
      try {
        validateOptions(v.options);
      } catch (e: any) {
        throw new BadRequestException(e.message);
      }
    }
    const nameSets = new Set(variants.map((v: any) => optionNameSet(v.options ?? [])));
    if (nameSets.size > 1) {
      throw new BadRequestException('All variants must use the same attributes');
    }
    const keys = variants.map((v: any) => optionsKey(v.options ?? []));
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException(
        'Duplicate variants — each must have a unique combination of attributes',
      );
    }
    const defaultFlags = variants.filter((v: any) => v.isDefault === true);
    if (defaultFlags.length > 1) {
      throw new BadRequestException('Only one variant may be marked as default');
    }

    if (status === 'scheduled' && !scheduledAt) {
      throw new BadRequestException(
        'scheduledAt is required when status is scheduled',
      );
    }

    const categoryId = store.categoryId;
    if (!categoryId)
      throw new BadRequestException('Your store has no category selected');

    const slug = await generateUniqueSlug(productModel, name);

    const product = await productModel.create({
      sellerId,
      storeId: store._id.toString(),
      name,
      slug,
      description: description ?? null,
      productType: 'physical',
      type: 'physical',
      categoryId,
      subCategoryId: subCategoryId ?? null,
      images: images ?? [],
      tags: tags ?? [],
      digital: null,
      isListedOnEdudeen: isListedOnEdudeen ?? false,
      status: status ?? 'draft',
      scheduledAt: status === 'scheduled' ? new Date(scheduledAt) : null,
    });

    const defaultIndex = variants.findIndex((v: any) => v.isDefault === true);
    const createdVariants = await Promise.all(
      variants.map((v: any, index: number) => {
        const sku =
          v.sku ||
          `SKU-${product._id.toString().slice(-6).toUpperCase()}-${Date.now().toString().slice(-4)}-${index}`;
        return productVariantModel.create({
          productId: product._id.toString(),
          sku,
          price: v.price,
          // Stamped from the owning store's own pricing currency — never
          // client-supplied, never a per-product choice. See
          // Store.baseCurrency's comment for why this is locked once set.
          currency: store.baseCurrency,
          compareAtPrice: v.compareAtPrice ?? null,
          options: v.options ?? [],
          stock: v.stock ?? 0,
          unlimitedStock: !!v.unlimitedStock,
          shippingWeight: v.shippingWeight ?? null,
          images: v.images ?? [],
          isDefault: defaultIndex === -1 ? index === 0 : index === defaultIndex,
        });
      }),
    );

    return {
      success: true,
      message: 'Physical product created successfully',
      data: { product, variants: createdVariants },
    };
  }

  async addDigitalProduct(sellerId: string, body: any) {
    const { storeModel, sellerModel, productModel, productVariantModel } =
      this.databaseService.repositories;

    const seller = await sellerModel.findOne({
      _id: sellerId,
      status: 'active',
      isDelete: false,
    });
    if (!seller) throw new UnauthorizedException('Unauthorized seller');

    const {
      storeId,
      name,
      description,
      productType,
      subCategoryId,
      images,
      tags,
      isListedOnEdudeen,
      status,
      scheduledAt,
      price,
      compareAtPrice,
      digital,
      educationLevel,
      customLevel,
    } = body;

    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store) throw new BadRequestException('Store not found');
    if (store.status !== 'active')
      throw new BadRequestException('Your store is not active');

    const allowsDigital =
      store.productTypes?.includes(StoreProductType.DIGITAL_DOWNLOADS) ||
      store.productTypes?.includes(StoreProductType.EDUCATIONAL_RESOURCES);
    if (!allowsDigital)
      throw new BadRequestException(
        'Your store does not support digital products',
      );

    await this.entitlementsService.assertCanCreateProduct(storeId);

    if (!name) throw new BadRequestException('Product name is required');
    if (price === undefined || price === null)
      throw new BadRequestException('Price is required');

    if (status === 'scheduled' && !scheduledAt) {
      throw new BadRequestException(
        'scheduledAt is required when status is scheduled',
      );
    }

    const finalProductType =
      productType === 'educational' ? 'educational' : 'digital';

    // Tier-1/Tier-2 education taxonomy — required only for educational products.
    let finalEducationLevel: string | null = null;
    let normalizedFields: {
      customLevel: string | null;
      normalizedCustomLevel: string | null;
    } = {
      customLevel: null,
      normalizedCustomLevel: null,
    };
    if (finalProductType === 'educational') {
      if (!educationLevel || !EDUCATION_LEVEL_VALUES.includes(educationLevel)) {
        throw new BadRequestException(
          `educationLevel is required and must be one of: ${EDUCATION_LEVEL_VALUES.join(', ')}`,
        );
      }
      finalEducationLevel = educationLevel;
      if (educationLevel === EducationLevel.OTHER) {
        if (!customLevel || !String(customLevel).trim()) {
          throw new BadRequestException(
            'customLevel is required when educationLevel is "other"',
          );
        }
        const normalized =
          await this.educationLevelService.normalizeCustomLevel(
            String(customLevel),
          );
        normalizedFields = {
          customLevel: normalized.customLevel,
          normalizedCustomLevel: normalized.normalizedCustomLevel,
        };
      }
    }

    const categoryId = store.categoryId;
    if (!categoryId)
      throw new BadRequestException('Your store has no category selected');

    const slug = await generateUniqueSlug(productModel, name);

    const product = await productModel.create({
      sellerId,
      storeId: store._id.toString(),
      name,
      slug,
      description: description ?? null,
      productType: finalProductType,
      type: 'digital',
      categoryId,
      subCategoryId: subCategoryId ?? null,
      educationLevel: finalEducationLevel,
      customLevel: normalizedFields.customLevel,
      normalizedCustomLevel: normalizedFields.normalizedCustomLevel,
      images: images ?? [],
      tags: tags ?? [],
      digital: digital ? await this.prepareDigitalPreview(null, digital) : null,
      isListedOnEdudeen: isListedOnEdudeen ?? false,
      status: status ?? 'draft',
      scheduledAt: status === 'scheduled' ? new Date(scheduledAt) : null,
    });

    const sku = `SKU-${product._id.toString().slice(-6).toUpperCase()}-${Date.now().toString().slice(-4)}`;

    const defaultVariant = await productVariantModel.create({
      productId: product._id.toString(),
      sku,
      price,
      // See the physical-product variant creation path (above in this same
      // file) for why this is stamped from the store, not client-supplied.
      currency: store.baseCurrency,
      compareAtPrice: compareAtPrice ?? null,
      options: [],
      stock: 0,
      shippingWeight: null,
      images: [],
      isDefault: true,
    });

    return {
      success: true,
      message: 'Digital product created successfully',
      data: { product, defaultVariant },
    };
  }

  async getSellerProductById(sellerId: string, productId: string) {
    const { productModel, productVariantModel } =
      this.databaseService.repositories;

    const product = await productModel
      .findOne({
        _id: productId,
        sellerId,
        isDelete: false,
      })
      .lean();

    if (!product) throw new NotFoundException('Product not found');

    const variants = await productVariantModel
      .find({
        productId,
        isDelete: false,
      })
      .lean();

    const defaultVariant =
      variants.find((v: any) => v.isDefault) || variants[0] || null;

    return {
      success: true,
      message: 'Product fetched successfully',
      data: { product, variants, defaultVariant },
    };
  }

  async getStoreProducts(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const { productModel, productVariantModel, storeModel } =
      this.databaseService.repositories;

    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store)
      throw new UnauthorizedException('Store not found or unauthorized');

    const page = parseInt(query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const filter: any = { storeId, sellerId, isDelete: false };
    if (query.type && query.type !== 'all') filter.type = query.type;
    if (query.status && query.status !== 'all') filter.status = query.status;

    const total = await productModel.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const products = await productModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const productIds = products.map((p: any) => p._id.toString());
    const allVariants = await productVariantModel
      .find({ productId: { $in: productIds }, isDelete: false })
      .lean();

    const variantMap: Record<string, any[]> = {};
    for (const v of allVariants) {
      if (!variantMap[v.productId]) variantMap[v.productId] = [];
      variantMap[v.productId].push(v);
    }

    const data = products.map((product: any) => ({
      ...product,
      variants: variantMap[product._id.toString()] || [],
    }));

    return {
      success: true,
      data: {
        pagination: { page, limit, totalPages, total },
        products: data,
      },
    };
  }

  async editProduct(sellerId: string, body: any) {
    const { productModel, productVariantModel, sellerModel } =
      this.databaseService.repositories;

    const {
      productId,
      name,
      description,
      subCategoryId,
      images,
      tags,
      isListedOnEdudeen,
      status,
      scheduledAt,
      digital,
      educationLevel,
      customLevel,
      price,
      compareAtPrice,
    } = body;

    if (!productId) throw new BadRequestException('productId is required');

    const seller = await sellerModel.findOne({
      _id: sellerId,
      status: 'active',
      isDelete: false,
    });
    if (!seller) throw new UnauthorizedException('Unauthorized seller');

    const product = await productModel.findOne({
      _id: productId,
      isDelete: false,
    });
    if (!product) throw new BadRequestException('Product not found');
    if (product.sellerId !== sellerId)
      throw new UnauthorizedException(
        'You are not authorized to edit this product',
      );

    const productUpdate: any = {};

    if (name && name !== product.name) {
      const slug = await generateUniqueSlug(productModel, name, { excludeId: productId });
      productUpdate.name = name;
      productUpdate.slug = slug;
    }

    if (description !== undefined) productUpdate.description = description;
    if (subCategoryId !== undefined)
      productUpdate.subCategoryId = subCategoryId;
    if (images !== undefined) productUpdate.images = images;
    if (tags !== undefined) productUpdate.tags = tags;
    if (isListedOnEdudeen !== undefined)
      productUpdate.isListedOnEdudeen = isListedOnEdudeen;
    if (status !== undefined) {
      if (status === 'scheduled' && !scheduledAt) {
        throw new BadRequestException(
          'scheduledAt is required when status is scheduled',
        );
      }
      productUpdate.status = status;
      productUpdate.scheduledAt =
        status === 'scheduled' ? new Date(scheduledAt) : null;
    }
    if (digital !== undefined && product.type === 'digital') {
      productUpdate.digital = await this.prepareDigitalPreview(
        product.digital?.preview,
        digital,
      );
    }

    if (educationLevel !== undefined && product.productType === 'educational') {
      if (!EDUCATION_LEVEL_VALUES.includes(educationLevel)) {
        throw new BadRequestException(
          `educationLevel must be one of: ${EDUCATION_LEVEL_VALUES.join(', ')}`,
        );
      }
      productUpdate.educationLevel = educationLevel;
    }
    if (product.productType === 'educational') {
      const effectiveLevel =
        productUpdate.educationLevel ?? product.educationLevel;
      if (effectiveLevel === EducationLevel.OTHER) {
        if (customLevel !== undefined) {
          if (!String(customLevel).trim())
            throw new BadRequestException(
              'customLevel is required when educationLevel is "other"',
            );
          const normalized =
            await this.educationLevelService.normalizeCustomLevel(
              String(customLevel),
            );
          productUpdate.customLevel = normalized.customLevel;
          productUpdate.normalizedCustomLevel =
            normalized.normalizedCustomLevel;
        } else if (!product.customLevel) {
          throw new BadRequestException(
            'customLevel is required when educationLevel is "other"',
          );
        }
      } else if (productUpdate.educationLevel !== undefined) {
        productUpdate.customLevel = null;
        productUpdate.normalizedCustomLevel = null;
      }
    }

    const updatedProduct =
      Object.keys(productUpdate).length > 0
        ? await productModel.findByIdAndUpdate(productId, productUpdate, {
            new: true,
          })
        : product;

    // Digital/educational products still have exactly one (default) variant
    // and no dedicated variant-management endpoints — price/compareAtPrice
    // edits for them stay routed through here. Physical products manage
    // price per-variant exclusively via the product-variants module now.
    let updatedVariant: any;
    if (product.type !== 'physical' && (price !== undefined || compareAtPrice !== undefined)) {
      const variantUpdate: any = {};
      if (price !== undefined) variantUpdate.price = price;
      if (compareAtPrice !== undefined) variantUpdate.compareAtPrice = compareAtPrice;
      updatedVariant = await productVariantModel.findOneAndUpdate(
        { productId, isDefault: true, isDelete: false },
        variantUpdate,
        { new: true },
      );
    }

    return {
      success: true,
      message: 'Product updated successfully',
      data: { product: updatedProduct, variant: updatedVariant },
    };
  }

  async deleteProduct(sellerId: string, productId: string) {
    const { productModel, productVariantModel, sellerModel } =
      this.databaseService.repositories;

    const seller = await sellerModel.findOne({
      _id: sellerId,
      status: 'active',
      isDelete: false,
    });
    if (!seller) throw new UnauthorizedException('Unauthorized seller');

    const product = await productModel.findOne({
      _id: productId,
      isDelete: false,
    });
    if (!product) throw new BadRequestException('Product not found');
    if (product.sellerId !== sellerId)
      throw new UnauthorizedException(
        'You are not authorized to delete this product',
      );

    await productModel.findByIdAndUpdate(productId, {
      isDelete: true,
      status: 'inactive',
    });
    await productVariantModel.updateMany(
      { productId, isDelete: false },
      { isDelete: true, isDefault: false },
    );

    return {
      success: true,
      message: 'Product deleted successfully',
      data: null,
    };
  }

  /** GET /api/products/education/facets — public, backs the Education marketplace's dynamic filter chips. */
  async getEducationFacets() {
    const facets = await this.educationLevelService.getFacets();
    return { success: true, data: facets };
  }

  /** GET /api/products/education/custom-level-suggestions — seller-only autocomplete while typing a custom level. */
  async getCustomLevelSuggestions(q: string) {
    const suggestions =
      await this.educationLevelService.getCustomLevelSuggestions(q);
    return { success: true, data: suggestions };
  }
}
