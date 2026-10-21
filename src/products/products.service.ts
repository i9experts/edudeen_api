/* eslint-disable prettier/prettier */
import { MAX_CATEGORY_DEPTH, getDescendantIds } from 'src/categories/category-tree.util';
import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  HttpException,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { checkVerifiedPurchase } from 'src/rating/verified-purchase.util';
import { isValidObjectId } from 'mongoose';

import { DatabaseService } from 'src/database/databaseservice';
import { ProductType as StoreProductType } from 'src/store/schemas/store.schema';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { MarketingService } from 'src/marketing/marketing.service';
import { ActiveCampaignForStore, applyCampaignsToVariants, pickBestCampaignForLine, pickPrimaryCampaignForBadge } from 'src/marketing/campaign-pricing.util';
import { campaignsForProduct, loadCampaignContext, parseCampaignIdsInput } from 'src/marketing/campaign-eligibility.util';
import { EducationLevel, LICENSE_OPTION_LABEL, LICENSE_OPTION_NAME } from './schemas/product.schema';
import { EducationLevelService } from './education-level.service';
import { UploadService } from 'src/upload/upload.service';
import { UploadedAssetsService } from 'src/upload/uploaded-assets.service';
import { fetchPdfPageCount, isPdfName } from './pdf-page-count.util';
import { sanitizeDigitalForPublicView } from './product-public-view.util';
import { classFilter, classIndex } from './class-levels';
import { assertPriceRules, assertDescriptionRule, assertStockRule, cleanShippingWeight } from './price-rules.util';
import { splitEditForReview, overlayPendingEdit } from './product-edit-review.util';
import { assertSellerStatus, parseScheduledAt, assertStringArray, assertText, cleanDigitalSettings, resolveSellerPublishStatus, cleanLearningMeta, cleanLicenseTiers, cleanDeliveryFormat } from './product-input.util';
import { allocateSkus, cleanSku } from './sku.util';
import { generateProductSlug, nextPreviousSlugs } from 'src/common/slug.util';
import { assertClassRangeRule, assertTitleRule, normalizeTitle, productWarnings } from './product-quality.util';
import { CONTACT_FLAG, scanImagesForContactInfo, scanListingText } from './contact-info.util';
import { RedisService } from 'src/redis/redis.service';
import { aggregateProductSales } from 'src/analytics/utils/order-aggregation.util';
import {
  PREVIEW_RATE_LIMIT_MAX,
  PREVIEW_RATE_LIMIT_WINDOW_SECONDS,
} from './constants/preview.constants';
import { optionNameSet, optionsKey, validateOptions } from './variant-options.util';
import { AttributesService } from 'src/attributes/attributes.service';
import { PremiumEntitlementsService } from 'src/premium/premium-entitlements.service';
import { assertOfferExclusive, premiumFieldsFromBody } from './offers.util';
import { assertPremiumGap } from 'src/premium/premium-gap';
import { premiumPercentFor } from 'src/premium/premium.util';

import { clampInt } from 'src/common/query-safety.util';
import { resolveStoreNames } from './store-name.util';
import { FuzzyIndex, buildAllWordsFilter, relevanceTier } from 'src/search/search-terms.util';
const EDUCATION_LEVEL_VALUES: string[] = Object.values(EducationLevel);

/** Prices arrive on `body: any` endpoints, so they are checked here rather
 *  than by a DTO. 0 is allowed (free resources are common on education
 *  marketplaces); negative / non-finite values would corrupt order totals
 *  and seller ledgers. */
const MAX_PRICE = 1_000_000;
function assertValidPrice(value: unknown, field: string, { nullable = false } = {}): void {
  if (value === null && nullable) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_PRICE) {
    throw new BadRequestException(`${field} must be a number between 0 and ${MAX_PRICE}`);
  }
}

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
    private uploadedAssets: UploadedAssetsService,
    @Optional() private premiumService?: PremiumEntitlementsService,
  ) {}

  /** Attaches an `activeCampaign` badge summary (or null) to each product,
   *  based on whether its store currently has an active platform-sale
   *  campaign. Same lookup CheckoutService uses to enforce the discount, so
   *  a product never shows a "sale" badge checkout wouldn't actually honor.
   *  One batched query for the whole page, not per-product. */
  private async attachCampaignBadges<T extends { storeId?: string }>(
    products: T[],
    customerId?: string | null,
  ): Promise<T[]> {
    const storeIds = [
      ...new Set(products.map((p) => p.storeId).filter(Boolean)),
    ] as string[];
    // Premium early access: an active member also sees a campaign starting within their earlyAccessHours.
    const ent = customerId && this.premiumService ? await this.premiumService.getEntitlements(customerId) : null;
    const campaignsByStore = storeIds.length
      ? await this.marketingService.getActiveCampaignsForStores(storeIds, ent?.isPremium ? { earlyAccessHours: ent.earlyAccessHours } : {})
      : new Map();

    // Per-product participation (marketing/campaign-eligibility.util.ts): a product only carries the sale when it is
    // in the campaign. Two batched queries for the page, none when no store is in a campaign.
    const campaignIds = [...new Set([...campaignsByStore.values()].flat().map((c: any) => c.campaignId))] as string[];
    const missingIds = products
      .filter((p: any) => p._id && !Array.isArray(p.campaignIds))
      .map((p: any) => String(p._id));
    const ctx = campaignIds.length ? await loadCampaignContext(this.databaseService.repositories.productModel, missingIds) : { campaignIdsByProduct: new Map<string, string[]>() };
    const ownIds = (p: any): string[] | undefined => (Array.isArray(p.campaignIds) ? p.campaignIds : ctx.campaignIdsByProduct.get(String(p._id)));

    return products.map((raw) => {
      const { campaignIds: _own, ...p } = raw as any;
      const campaigns = campaignsForProduct(raw.storeId ? campaignsByStore.get(raw.storeId) : undefined, ownIds(raw));
      // Owner rule R1: an Edudeen offer is computed from the LIST price (compare-at when above the price) and only
      // applies when strictly cheaper than the normal price; each variant gets its own `campaignPrice`.
      let primary: ActiveCampaignForStore | null = null;
      let appliedPrice: number | null = null;
      if (Array.isArray(p.variants) && p.variants.length > 0) {
        const r = applyCampaignsToVariants(campaigns, p.variants);
        p.variants = r.variants; primary = r.primary; appliedPrice = r.appliedPrice;
      } else {
        const price = p.defaultVariantPrice ?? p.price;
        const line = typeof price === 'number' ? pickBestCampaignForLine(campaigns.filter((c) => c.discountType != null && c.discountValue != null), price, p.compareAtPrice ?? null) : null;
        if (line) { primary = line.campaign; appliedPrice = line.unit; }
      }
      if (primary && p.compareAtPrice != null) p.compareAtPrice = null;
      // Badge-only campaign (no discount configured): shown, never changes a price.
      if (!primary) primary = pickPrimaryCampaignForBadge(campaigns.filter((c) => c.discountType == null || c.discountValue == null));
      return {
        ...p,
        ...(appliedPrice != null ? { campaignPrice: appliedPrice } : {}),
        activeCampaign: primary
          ? {
              campaignId: primary.campaignId,
              name: primary.name,
              discountType: primary.discountType,
              discountValue: primary.discountValue,
              currency: primary.currency,
              endDate: primary.endDate,
              ...(primary.earlyAccess ? { earlyAccess: true } : {}),
            }
          : null,
      };
    });
  }

  /** Edudeen Premium decoration (no-op when the premium module is absent). See PremiumEntitlementsService.decorateProducts. */
  private async withPremium<T extends Record<string, any>>(products: T[], customerId?: string | null): Promise<T[]> {
    return this.premiumService ? this.premiumService.decorateProducts(products, customerId ?? null) : products;
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
  private sanitizeDigitalForPublicView<T extends { digital?: any }>(product: T): T {
    return sanitizeDigitalForPublicView(product);
  }

  /** subCategoryId must be an ACTIVE child of the product's root category. It used to be stored unchecked
   *  (any string, any foreign/inactive/deleted/root category), polluting other categories' browse pages. */
  /** Seller may pick ANY active main category per product; omitted -> the store's own category (legacy default). */
  private async resolveRootCategoryId(defaultCategoryId: string | null | undefined, requested: unknown): Promise<string> {
    if (requested === undefined || requested === null || requested === '') {
      if (!defaultCategoryId) throw new BadRequestException('Your store has no category selected');
      return defaultCategoryId;
    }
    if (typeof requested !== 'string' || !isValidObjectId(requested)) {
      throw new BadRequestException('categoryId is not a valid category id');
    }
    const root = await this.databaseService.repositories.categoryModel.findOne({
      _id: requested, parentId: null, status: 'active', isDelete: false,
    });
    if (!root) throw new BadRequestException('categoryId must be an active main category');
    return requested;
  }

  private async resolveSubCategoryId(rootCategoryId: string, subCategoryId: unknown): Promise<string | null> {
    if (subCategoryId === undefined || subCategoryId === null || subCategoryId === '') return null;
    if (typeof subCategoryId !== 'string' || !isValidObjectId(subCategoryId)) {
      throw new BadRequestException('subCategoryId is not a valid category id');
    }
    // Any ACTIVE descendant of the chosen root at any depth is allowed: walk parents up from the node and
    // require every step to be active and the chain to end at `rootCategoryId` (max MAX_CATEGORY_DEPTH hops).
    const categoryModel = this.databaseService.repositories.categoryModel;
    let node: any = await categoryModel.findOne({ _id: subCategoryId, status: 'active', isDelete: false });
    let reachedRoot = false;
    for (let hops = 0; node && hops < MAX_CATEGORY_DEPTH; hops++) {
      if (!node.parentId) break;
      if (String(node.parentId) === String(rootCategoryId)) { reachedRoot = true; break; }
      node = await categoryModel.findOne({ _id: node.parentId, status: 'active', isDelete: false });
    }
    if (!node || !reachedRoot) throw new BadRequestException('subCategoryId must be an active subcategory of the selected category');
    return subCategoryId;
  }

  /** Builds the digital config from untrusted input: every file must be one THIS seller uploaded (or already be
   *  part of this same product), its mime type/size come from our upload record — never the client — and the
   *  remaining settings are whitelisted and bounds-checked. */
  private async buildDigitalConfig(sellerId: string, raw: unknown, existing: any | null): Promise<any> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('digital must be an object');
    const input = raw as Record<string, unknown>;
    const existingFiles: any[] = existing?.files ?? [];

    const rawFiles = input.files === undefined ? existingFiles : input.files;
    if (!Array.isArray(rawFiles)) throw new BadRequestException('digital.files must be an array');
    if (rawFiles.length > 30) throw new BadRequestException('A product can have at most 30 files');

    const files: Array<{ url: string; name: string; size: number | null; mimeType: string | null; pageCount?: number }> = [];
    for (const f of rawFiles as Array<Record<string, unknown>>) {
      if (!f || typeof f !== 'object') throw new BadRequestException('Each file must be an object');
      const known = existingFiles.find((e) => e.url === f.url);
      const trusted = await this.uploadedAssets.assertOwned(sellerId, f.url, 'digital_product', { alreadyReferenced: !!known });
      const name = f.name === undefined && known ? known.name : assertText(f.name, 'file name', 255);
      if (!name.trim()) throw new BadRequestException('Each file needs a name');
      files.push({
        url: f.url as string,
        name,
        size: trusted?.fileSize ?? known?.size ?? null,
        mimeType: trusted?.mimeType ?? known?.mimeType ?? null,
        ...(typeof known?.pageCount === 'number' ? { pageCount: known.pageCount as number } : {}), // kept for unchanged files; new PDFs are counted after save
      });
    }
    const knownPages = files.filter(f => typeof f.pageCount === 'number');
    const pageCount = knownPages.length ? knownPages.reduce((s, f) => s + (f.pageCount as number), 0) : null;

    // Free sample: same ownership rule as the paid files.
    let sampleFile: { url: string; name: string; size: number | null; mimeType: string | null } | null = existing?.sampleFile ?? null;
    if (input.sampleFile !== undefined) {
      if (input.sampleFile === null) sampleFile = null;
      else {
        const s = input.sampleFile as Record<string, unknown>;
        if (!s || typeof s !== 'object') throw new BadRequestException('sampleFile must be an object');
        const known = existing?.sampleFile?.url === s.url ? existing.sampleFile : null;
        const trusted = await this.uploadedAssets.assertOwned(sellerId, s.url, 'digital_product', { alreadyReferenced: !!known });
        const name = s.name === undefined && known ? known.name : assertText(s.name, 'sample file name', 255);
        sampleFile = { url: s.url as string, name, size: trusted?.fileSize ?? known?.size ?? null, mimeType: trusted?.mimeType ?? known?.mimeType ?? null };
      }
    }

    const settings = cleanDigitalSettings(input, existing);
    const { preview, ...rest } = settings;
    return this.prepareDigitalPreview(existing?.preview ?? null, { files, pageCount, ...rest, preview, sampleFile });
  }

  /** Best-effort, fire-and-forget: counts the pages of PDF files that have no pageCount yet and stores them per file
   *  (digital.files.[].pageCount) plus the sum (digital.pageCount). Never throws; a failure just leaves pageCount unset. */
  async fillPdfPageCounts(productId: string): Promise<void> {
    try {
      const { productModel } = this.databaseService.repositories;
      const product: any = await productModel.findOne({ _id: productId }).select('digital.files').lean();
      const files: any[] = product?.digital?.files ?? [];
      let changed = false;
      for (const f of files) {
        if (typeof f.pageCount === 'number' || !isPdfName(f.name, f.mimeType)) continue;
        const n = await fetchPdfPageCount(this.uploadService.generateSignedUrl(f.url, 'raw', 300));
        if (n === null) continue;
        f.pageCount = n;
        changed = true;
        await productModel.updateOne({ _id: productId }, { $set: { 'digital.files.$[f].pageCount': n } }, { arrayFilters: [{ 'f.url': f.url }] });
      }
      if (!changed) return;
      const total = files.reduce((s, f) => s + (typeof f.pageCount === 'number' ? f.pageCount : 0), 0);
      await productModel.updateOne({ _id: productId }, { $set: { 'digital.pageCount': total || null } });
    } catch {
      /* best-effort */
    }
  }

  /** Creates, updates or removes the extra "License" variants of a digital
   *  product so each license (one classroom, whole school) has its own price.
   *  The default variant is the product's base license. */
  private async syncLicenseVariants(product: any, baseLicense: string, tiers: { license: string; price: number; compareAtPrice: number | null }[], currency: string) {
    const { productVariantModel } = this.databaseService.repositories;
    const productId = String(product._id);
    const variants = await productVariantModel.find({ productId, isDelete: false });
    const def = variants.find((v: any) => v.isDefault) ?? variants[0];
    const extra = tiers.filter(t => t.license !== baseLicense);
    const option = (license: string) => [{ name: LICENSE_OPTION_NAME, value: LICENSE_OPTION_LABEL[license] ?? license }];

    if (def) {
      def.options = extra.length ? option(baseLicense) : [];
      await def.save();
    }
    const wanted = new Set(extra.map(t => LICENSE_OPTION_LABEL[t.license] ?? t.license));
    for (const v of variants) {
      if (v === def) continue;
      const label = v.options?.find((o: any) => o.name === LICENSE_OPTION_NAME)?.value;
      if (!label || !wanted.has(label)) { v.isDelete = true; await v.save(); }
    }
    const licenseStore: any = await this.databaseService.repositories.storeModel.findById(product.storeId).select('name').lean();
    for (const t of extra) {
      const label = LICENSE_OPTION_LABEL[t.license] ?? t.license;
      const existing = variants.find((v: any) => v !== def && !v.isDelete && v.options?.some((o: any) => o.name === LICENSE_OPTION_NAME && o.value === label));
      if (existing) {
        existing.price = t.price;
        existing.compareAtPrice = t.compareAtPrice;
        await existing.save();
      } else {
        await productVariantModel.create({
          productId,
          sku: (await allocateSkus(this.databaseService.repositories.storeModel, licenseStore ?? { _id: product.storeId }, 1))[0],
          price: t.price,
          currency,
          compareAtPrice: t.compareAtPrice,
          options: option(t.license),
          stock: 0,
          shippingWeight: null,
          images: [],
          isDefault: false,
        });
      }
    }
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
          previewSourceUrl: null,
        },
      };
    }

    const sourceFileIndex = digital.preview.sourceFileIndex ?? 0;
    // The seller's free sample is what buyers preview; without one, the chosen paid file is used.
    const file = digital.sampleFile?.url ? digital.sampleFile : digital.files?.[sourceFileIndex];
    if (!file)
      throw new BadRequestException(
        'preview.sourceFileIndex does not match any uploaded file',
      );

    const mimeType =
      file.mimeType || this.uploadService.resolveMimeType(file.name, '');
    const unchanged =
      existingPreview?.enabled &&
      existingPreview?.sourceFileIndex === sourceFileIndex &&
      existingPreview?.previewSourceUrl === file.url &&
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
        previewSourceUrl: file.url,
      },
    };
  }

  /** A course listing can't go live (or to review) until the course builder has at least one lesson. */
  private async assertCourseReady(productId: string | null, format: string | null | undefined, nextStatus: string | null | undefined) {
    if (format !== 'course' || !nextStatus || nextStatus === 'draft' || nextStatus === 'archived') return;
    const course: any = productId ? await this.databaseService.repositories.courseModel.findOne({ productId }).select('sections').lean() : null;
    const lessons = (course?.sections ?? []).reduce((n: number, s: any) => n + (s.lessons?.length ?? 0), 0);
    if (!lessons) throw new BadRequestException('Add at least one lesson in the course builder before publishing — save this course as a draft first');
  }

  /** The seller's free sample (a separate file from what buyers get), as a   *  short-lived link. Rate-limited the same way as previews. */
  async getProductSample(idOrSlug: string, clientIp: string) {
    // Owner decision: buyers no longer get a free-sample download (the Preview viewer replaces it).
    if (process.env.PUBLIC_FREE_SAMPLE !== 'true') throw new NotFoundException('Free samples are not offered');
    const count = await this.redisService.incrWithTtl(`sample:rl:${clientIp}:${idOrSlug}`, PREVIEW_RATE_LIMIT_WINDOW_SECONDS);
    if (count !== null && count > PREVIEW_RATE_LIMIT_MAX) {
      throw new HttpException({ success: false, message: 'Too many requests — please try again later' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const { productModel } = this.databaseService.repositories;
    let product: any = await productModel.findOne({ slug: idOrSlug, status: 'active', isDelete: false, isTest: { $ne: true } }).lean();
    if (!product && isValidObjectId(idOrSlug)) product = await productModel.findOne({ _id: idOrSlug, status: 'active', isDelete: false, isTest: { $ne: true } }).lean();
    if (!product || !(await this.isStoreLive(product.storeId))) throw new NotFoundException('Product not found');
    const sample = product.digital?.sampleFile;
    if (!sample?.url) throw new NotFoundException('This product has no free sample');
    const mimeType = this.uploadService.resolveMimeType(sample.name ?? '', sample.mimeType ?? 'application/octet-stream');
    const resourceType = mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('image/') ? 'image' : 'raw';
    return {
      success: true,
      data: { name: sample.name, mimeType, url: this.uploadService.generateSignedUrl(sample.url, resourceType, 600, sample.name, true) },
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
      .findOne({ slug: idOrSlug, status: 'active', isDelete: false, isTest: { $ne: true } })
      .lean();
    if (!product && isValidObjectId(idOrSlug)) {
      product = await productModel
        .findOne({ _id: idOrSlug, status: 'active', isDelete: false, isTest: { $ne: true } })
        .lean();
    }
    if (!product) throw new NotFoundException('Product not found');
    if (!(await this.isStoreLive(product.storeId))) throw new NotFoundException('Product not found');
    if (product.type !== 'digital' || !product.digital?.preview?.enabled) {
      throw new BadRequestException(
        'Preview is not available for this product',
      );
    }

    const sourceFileIndex = product.digital.preview.sourceFileIndex ?? 0;
    const builtFrom = product.digital.preview.previewSourceUrl as string | null | undefined;
    const file = builtFrom
      ? [product.digital.sampleFile, ...(product.digital.files ?? [])].find((f: any) => f?.url === builtFrom)
      : product.digital.files?.[sourceFileIndex];
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
    search?: string,
    learning?: { curriculum?: string; age?: number; featured?: boolean; classValue?: string },
  ): Promise<any> {
    const productModel = this.databaseService.repositories.productModel;
    const productVariantModel =
      this.databaseService.repositories.productVariantModel;
    const sellerModel = this.databaseService.repositories.sellerModel;

    const query: any = {
      status: 'active',
      isDelete: false, isTest: { $ne: true },
    };

    // Keyword search together with every filter below, so a search results
    // page can page and filter on the server (the plain search endpoint can't).
    // Exam board, and "suitable for age N" (an open end counts as a match).
    if (learning?.curriculum) query.curricula = learning.curriculum;
    // Listings an admin has featured (Admin → Listings).
    if (learning?.featured) query.isFeatured = true;
    if (learning?.age !== undefined) {
      query.$and = [
        { $or: [{ ageMin: null }, { ageMin: { $lte: learning.age } }] },
        { $or: [{ ageMax: null }, { ageMax: { $gte: learning.age } }] },
      ];
    }

    // Exact class (class-3): the product's class range covers it, or it has no class data and its coarse level does.
    if (learning?.classValue) {
      const cf = classFilter(learning.classValue);
      if (cf) query.$and = [...(query.$and ?? []), cf];
    }

    const term = typeof search === 'string' ? search.trim().slice(0, 100) : '';
    if (term) {
      // Every word must match (any order) in name/tags/description; each word also matches its Roman-Urdu/Urdu synonyms.
      query.$and = [...(query.$and ?? []), buildAllWordsFilter(term)];
    }

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
        .select('_id participatingStoreIds sponsorType')
        .lean();
      if (!campaign && isValidObjectId(campaignId)) {
        campaign = await campaignModel
          .findOne({ _id: campaignId, ...campaignBaseFilter })
          .select('_id participatingStoreIds sponsorType')
          .lean();
      }
      // A platform-sponsored campaign applies to every store — no storeId
      // restriction at all, same universal rule as getActiveCampaignsForStores.
      if (campaign && campaign.sponsorType !== 'platform') {
        query.storeId = { $in: campaign.participatingStoreIds ?? [] };
      } else if (!campaign) {
        query.storeId = { $in: [] };
      }
      // Strict per-product opt-in (marketing/campaign-eligibility.util.ts): only products the seller ticked for this
      // sale are listed, so every result card carries the sale badge/price - the count matches what is shown.
      if (campaign) query.campaignIds = String((campaign as any)._id);
    }

    // 1️⃣ Agar category ID di gayi hai to filter lagao
    //
    // A `Product` stores its category as two separate flat fields, not a
    // nested chain: `categoryId` (always the seller's store's main category)
    // and an optional `subCategoryId`. Categories are also capped at exactly
    // up to 4 levels (enforced in CategoriesService); subCategoryId may be any
    // depth, so a sub-category browse expands to all of its descendants.
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
        }).select('parentId').lean();

      if (category?.parentId) {
        // A sub-category page also lists everything filed under its deeper sub-categories.
        query.subCategoryId = { $in: await getDescendantIds(this.databaseService.repositories.categoryModel, String(parentCategoryId)) };
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
                : sortBy === 'newest'
                  ? { createdAt: -1, _id: -1 }
                  // Default order: Edudeen-featured listings first, then newest.
                  : { isFeatured: -1, createdAt: -1, _id: -1 };

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
            : sortBy === 'newest'
              ? { createdAt: -1, _id: -1 }
              // Default order: Edudeen-featured listings first, then newest.
              : { isFeatured: -1, createdAt: -1, _id: -1 };

      if (term && !sortBy) {
        // Search with no explicit sort = relevance (exact/prefix name, then name has all words, then the rest).
        const ranked = await this.rankByRelevance(query, term);
        total = ranked.length;
        const pageIds = ranked.slice(skip, skip + limit);
        const docs = await productModel.find({ _id: { $in: pageIds } }).lean();
        const byId = new Map(docs.map((d: any) => [String(d._id), d]));
        products = pageIds.map((id) => byId.get(id)).filter(Boolean);
      } else {
        [total, products] = await Promise.all([
          productModel.countDocuments(query),
          productModel
            .find(query)
            .sort(sortStage as any)
            .skip(skip)
            .limit(limit)
            .lean(),
        ]);
      }
    }

    const productIds = products.map((p) => p._id.toString());

    // 2️⃣ Variants, subscriber pricing, seller + store names: four independent
    // batched lookups for the whole page, run in parallel (one round trip of latency, not four).
    const storeIds = [
      ...new Set(products.map((p) => p.storeId).filter(Boolean)),
    ];
    const sellerIds = [
      ...new Set(products.map((p) => p.sellerId).filter(Boolean)),
    ];
    const [variants, benefitsMap, sellers, storeNameMap] = await Promise.all([
      productVariantModel
        .find({
          productId: { $in: productIds },
          status: 'active',
          isDelete: false,
        })
        .lean(),
      this.subscriptionBenefits.getActiveBenefitsBatch(customerId, storeIds),
      sellerModel
        .find({ _id: { $in: sellerIds } })
        .select('name isVerified')
        .lean(),
      resolveStoreNames(
        this.databaseService.repositories.storeModel,
        storeIds as string[],
      ),
    ]);

    const variantMap: Record<string, any[]> = {};
    for (const v of variants) {
      if (!variantMap[v.productId]) {
        variantMap[v.productId] = [];
      }
      variantMap[v.productId].push(v);
    }
    const sellerMap = new Map(
      sellers.map((s) => [s._id.toString(), s]),
    );

    const productsWithVariants = await this.withPremium(await this.attachCampaignBadges(
      products.map((p) => {
        const seller = sellerMap.get(p.sellerId?.toString());
        return this.sanitizeDigitalForPublicView({
          ...p,
          // Buyers see the STORE, never the seller's personal name (seller name only if a store name is missing).
          sellerName: storeNameMap.get(String(p.storeId)) ?? (seller ? seller.name : null),
          storeName: storeNameMap.get(String(p.storeId)) ?? null,
          sellerVerified: seller ? !!seller.isVerified : false,
          variants: this.applySubscriberPricing(
            variantMap[p._id.toString()] || [],
            p,
            benefitsMap.get(p.storeId),
          ),
        });
      }),
      customerId,
    ), customerId);

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
    const storeNameMap = await resolveStoreNames(
      this.databaseService.repositories.storeModel,
      storeIds as string[],
    );

    return this.withPremium(await this.attachCampaignBadges(
      products.map((p) => {
        const seller = sellerMap.get(p.sellerId?.toString());
        return this.sanitizeDigitalForPublicView({
          ...p,
          // Buyers see the STORE, never the seller's personal name (seller name only if a store name is missing).
          sellerName: storeNameMap.get(String(p.storeId)) ?? (seller ? seller.name : null),
          storeName: storeNameMap.get(String(p.storeId)) ?? null,
          sellerVerified: seller ? !!seller.isVerified : false,
          variants: this.applySubscriberPricing(
            variantMap[p._id.toString()] || [],
            p,
            benefitsMap.get(p.storeId),
          ),
        });
      }),
      customerId,
    ), customerId);
  }

  /** Matching product ids ordered by relevance tier, then featured, then newest (capped at 500 matches). */
  private async rankByRelevance(query: any, term: string): Promise<string[]> {
    const rows: any[] = await this.databaseService.repositories.productModel
      .find(query).select('name tags isFeatured createdAt').sort({ createdAt: -1, _id: -1 }).limit(500).lean();
    return rows
      .map((r, i) => ({ id: String(r._id), tier: relevanceTier(term, r.name, r.tags), feat: r.isFeatured ? 0 : 1, i }))
      .sort((a, b) => a.tier - b.tier || a.feat - b.feat || a.i - b.i)
      .map((r) => r.id);
  }

  /** Keyword search over active products (name/tags/description, all words, ranked by relevance).
   *  Same response shape as `getProductsByCategoryId` so the app parses both
   *  with one model. */
  async searchProducts(
    q: string,
    page: number = 1,
    limit: number = 20,
    customerId?: string | null,
  ) {
    const productModel = this.databaseService.repositories.productModel;

    // Bounded: an unbounded term ran a regex scan over name+description for every request.
    const term = (typeof q === 'string' ? q : '').trim().slice(0, 100);
    if (!term) {
      return {
        message: 'Search query is required',
        success: true,
        data: { total: 0, page, limit, products: [] },
      };
    }

    // Words are regex-escaped inside buildAllWordsFilter; ALL words must match (any order).
    const query: any = {
      status: 'active',
      isDelete: false, isTest: { $ne: true },
      $and: [buildAllWordsFilter(term)],
    };

    await this.restrictToActiveStores(query);

    const skip = (page - 1) * limit;
    const ranked = await this.rankByRelevance(query, term);
    const total = ranked.length;
    const pageIds = ranked.slice(skip, skip + limit);
    const docs = await productModel.find({ _id: { $in: pageIds } }).lean();
    const byId = new Map(docs.map((d: any) => [String(d._id), d]));
    const products = pageIds.map((id) => byId.get(id)).filter(Boolean) as any[];

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
  /**
   * "Teachers who bought this also bought": products that appear in the same
   * paid orders as this one, most often first. Topped up with the best sellers
   * for the same grade (or category) when there isn't enough order history.
   */
  async getAlsoBought(idOrSlug: string, limit = 8, customerId?: string | null) {
    const { productModel, orderModel } = this.databaseService.repositories;
    let product: any = await productModel.findOne({ slug: idOrSlug, status: 'active', isDelete: false, isTest: { $ne: true } }).select('_id categoryId educationLevel').lean();
    if (!product && isValidObjectId(idOrSlug)) product = await productModel.findOne({ _id: idOrSlug, status: 'active', isDelete: false, isTest: { $ne: true } }).select('_id categoryId educationLevel').lean();
    if (!product) throw new NotFoundException('Product not found');
    const pid = String(product._id);
    const max = Math.min(Math.max(limit, 1), 20);

    const rows: { _id: string; n: number }[] = await orderModel.aggregate([
      { $match: { isDelete: false, isPaid: true, 'sellerOrders.items.productId': pid } },
      { $sort: { createdAt: -1 } },
      { $limit: 300 },
      { $unwind: '$sellerOrders' },
      { $unwind: '$sellerOrders.items' },
      { $match: { 'sellerOrders.items.productId': { $ne: pid } } },
      { $group: { _id: '$sellerOrders.items.productId', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 40 },
    ]);
    const coIds = rows.map(r => r._id).filter(id => isValidObjectId(id));
    let picked: any[] = (await this.getShapedProductsByIds(coIds, customerId)).slice(0, max);
    let basis: 'bought_together' | 'similar' = picked.length ? 'bought_together' : 'similar';

    if (picked.length < max) {
      const have = new Set([pid, ...picked.map(p => String(p._id))]);
      const filter: any = { status: 'active', isDelete: false, isTest: { $ne: true }, _id: { $nin: [...have] } };
      if (product.educationLevel) filter.educationLevel = product.educationLevel;
      else filter.categoryId = product.categoryId;
      await this.restrictToActiveStores(filter);
      const extra = await productModel.find(filter).sort({ purchaseCount: -1, averageRating: -1 }).limit(max - picked.length).lean();
      picked = [...picked, ...(await this.attachVariantsAndPricing(extra, customerId))];
      if (!rows.length) basis = 'similar';
    }
    return { success: true, data: { basis, products: picked.map(p => this.sanitizeDigitalForPublicView(p)) } };
  }

  // ── Typo tolerance: in-memory word index of product names/tags, rebuilt lazily every 10 minutes ──
  private fuzzy = new FuzzyIndex();
  private fuzzyLoading: Promise<void> | null = null;

  private async ensureFuzzyIndex() {
    if (this.fuzzy.size && Date.now() - this.fuzzy.builtAt < 10 * 60 * 1000) return;
    if (!this.fuzzyLoading) {
      this.fuzzyLoading = (async () => {
        const rows = await this.databaseService.repositories.productModel
          .find({ status: 'active', isDelete: false, isTest: { $ne: true } }).select('name tags').limit(20000).lean();
        this.fuzzy.build(rows.map((r: any) => [r.name, ...(Array.isArray(r.tags) ? r.tags : [])].join(' ')));
      })().catch(() => { this.fuzzy.builtAt = Date.now(); }).finally(() => { this.fuzzyLoading = null; });
    }
    await this.fuzzyLoading;
  }

  /** A spell-corrected version of a search term (null when nothing to fix). Never throws. */
  async suggestCorrection(term: string): Promise<string | null> {
    try {
      const t = (typeof term === 'string' ? term : '').trim().slice(0, 100);
      if (t.length < 4) return null;
      await this.ensureFuzzyIndex();
      const fixed = this.fuzzy.correct(t);
      return fixed && fixed.toLowerCase() !== t.toLowerCase() ? fixed : null;
    } catch { return null; }
  }

  /** Runs a keyword search; with no hits retries once with a spell-corrected term ("Showing results for X"),
   *  and with very few hits just suggests it ("Did you mean X"). `exact` turns this off ("Search instead for Y"). */
  async withSpellFix(term: string | undefined, exact: boolean, run: (t: string | undefined) => Promise<any>): Promise<any> {
    const res = await run(term);
    const q = typeof term === 'string' ? term.trim() : '';
    const total = res?.data?.total;
    if (!q || exact || typeof total !== 'number' || total > 2) return res;
    const fixed = await this.suggestCorrection(q);
    if (!fixed) return res;
    if (total === 0) {
      const res2 = await run(fixed);
      if ((res2?.data?.total ?? 0) > 0) return { ...res2, correctedQuery: fixed, originalQuery: q };
      return { ...res, didYouMean: fixed };
    }
    return { ...res, didYouMean: fixed };
  }

  /** Public side-by-side data for the Compare page: up to 4 active products, same shaping/sanitising as listings. */
  async getCompareProducts(ids: string[], customerId?: string | null) {
    const clean = Array.from(new Set((ids ?? []).filter((i) => typeof i === 'string' && isValidObjectId(i)))).slice(0, 4);
    const products = await this.getShapedProductsByIds(clean, customerId);
    return { success: true, message: 'Products fetched successfully', data: { products } };
  }

  private premiumDealsPool: { at: number; docs: any[] } | null = null;

  /**
   * Members-only "Premium Deals": the products with the biggest effective Premium percent (seller% + platform%),
   * decorated with the same public view as listings (so a member sees the member price + `premiumDiscountPercent`).
   * The ranked candidate pool is cached ~60s per instance; non-members get an empty list.
   */
  async getPremiumDeals(limit = 12, customerId?: string | null) {
    const lim = Math.min(24, Math.max(1, Math.floor(limit) || 12));
    const empty = { success: true, message: 'Premium deals', data: { isPremium: false, products: [] as any[] } };
    if (!this.premiumService || !customerId) return empty;
    const ent = await this.premiumService.getEntitlements(customerId);
    if (!ent.isPremium) return empty;

    if (!this.premiumDealsPool || Date.now() - this.premiumDealsPool.at > 60_000) {
      const { productModel, storeModel } = this.databaseService.repositories as any;
      const stores: any[] = await storeModel.find({ status: 'active', isDelete: false }).select('premiumDiscount').lean();
      const storeById = new Map(stores.map((s) => [String(s._id), s]));
      const enabledStoreIds = stores.filter((s) => s.premiumDiscount?.enabled).map((s) => String(s._id));
      const docs: any[] = await productModel.find({
        status: 'active', isDelete: false, isTest: { $ne: true }, premiumOptOut: { $ne: true },
        storeId: { $in: [...storeById.keys()] },
        $or: [{ premiumDiscountPercent: { $gt: 0 } }, { storeId: { $in: enabledStoreIds } }],
      }).sort({ purchaseCount: -1, _id: -1 }).limit(300).lean();
      const ranked = docs
        .map((p) => ({ p, pct: premiumPercentFor(p, storeById.get(String(p.storeId))) }))
        .filter((x) => x.pct > 0)
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 60)
        .map((x) => x.p);
      this.premiumDealsPool = { at: Date.now(), docs: ranked };
    }

    const shaped: any[] = await this.attachVariantsAndPricing(this.premiumDealsPool.docs, customerId);
    const products = shaped
      .map((p) => {
        const dv = (p.variants ?? []).find((v: any) => v.isDefault && v.premiumPrice != null) ?? (p.variants ?? []).find((v: any) => v.premiumPrice != null);
        return { p, pct: dv?.premiumDiscountPercent ?? 0 };
      })
      .filter((x) => x.pct > 0)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, lim)
      .map((x) => x.p);
    return { success: true, message: 'Premium deals', data: { isPremium: true, products } };
  }
  // ── Home-page shelves (public): Bestsellers + Free resources. Candidate ids are cached in Redis for 10 min; the
  //    products are re-shaped per request so prices/campaigns/Premium stay current. Test products are never included.
  private static readonly HOME_SHELF_TTL_S = 600;

  private async cachedShelfIds(key: string, load: () => Promise<string[]>): Promise<string[]> {
    try {
      const hit = await this.redisService?.get(key);
      if (hit) { const ids = JSON.parse(hit); if (Array.isArray(ids)) return ids; }
    } catch { /* cache is optional */ }
    const ids = await load();
    try { await this.redisService?.set(key, JSON.stringify(ids), ProductsService.HOME_SHELF_TTL_S); } catch { /* ignore */ }
    return ids;
  }

  /** Real best sellers: ordered by the number of units on paid orders (`purchaseCount`); products nobody has bought are left out. */
  async getBestsellers(limit = 10, customerId?: string | null) {
    const lim = Math.min(24, Math.max(1, Math.floor(limit) || 10));
    const ids = await this.cachedShelfIds('home:bestsellers:v1', async () => {
      const rows: any[] = await this.databaseService.repositories.productModel
        .find({ status: 'active', isDelete: false, isTest: { $ne: true }, purchaseCount: { $gte: 1 } })
        .sort({ purchaseCount: -1, averageRating: -1, _id: -1 }).limit(60).select('_id').lean();
      return rows.map((r) => String(r._id));
    });
    // Over-ask: some candidates may belong to a store that has since gone offline.
    const products = (await this.getShapedProductsByIds(ids.slice(0, lim * 3), customerId ?? null)).slice(0, lim);
    return { success: true, data: { products } };
  }

  /** Free downloads: digital / educational products with a 0 price, then paid ones that offer a free sample file (flagged `freeKind`). */
  async getFreeResources(limit = 10, customerId?: string | null) {
    const lim = Math.min(24, Math.max(1, Math.floor(limit) || 10));
    const { productModel, productVariantModel } = this.databaseService.repositories as any;
    const loaded = await this.cachedShelfIds('home:free-resources:v1', async () => {
      const base = { status: 'active', isDelete: false, isTest: { $ne: true }, productType: { $in: ['digital', 'educational'] } };
      const zero: any[] = await productVariantModel.find({ isDelete: false, price: 0 }).select('productId').limit(400).lean();
      const freeIds = [...new Set(zero.map((v) => String(v.productId)))].filter((id) => isValidObjectId(id));
      const free: any[] = freeIds.length ? await productModel.find({ ...base, _id: { $in: freeIds } }).sort({ purchaseCount: -1, _id: -1 }).limit(60).select('_id').lean() : [];
      const samples: any[] = await productModel.find({ ...base, 'digital.sampleFile.url': { $type: 'string' } }).sort({ purchaseCount: -1, _id: -1 }).limit(60).select('_id').lean();
      const freeSet = new Set(free.map((r) => String(r._id)));
      return [...free.map((r) => `f:${r._id}`), ...samples.filter((r) => !freeSet.has(String(r._id))).map((r) => `s:${r._id}`)];
    });
    const kindOf = new Map(loaded.map((k) => [k.slice(2), k[0] === 'f' ? 'free' : 'sample']));
    const shaped: any[] = await this.getShapedProductsByIds(loaded.slice(0, lim * 3).map((k) => k.slice(2)), customerId ?? null);
    const products = shaped.slice(0, lim).map((p) => ({ ...p, freeKind: kindOf.get(String(p._id)) ?? 'free' }));
    return { success: true, data: { products } };
  }

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
      isDelete: false, isTest: { $ne: true },
    };
    await this.restrictToActiveStores(query);

    const products = await productModel.find(query).lean();

    const shaped = await this.attachVariantsAndPricing(products, customerId);
    const byId = new Map(shaped.map((p) => [p._id.toString(), p]));
    return productIds.map((id) => byId.get(id)).filter(Boolean);
  }

  /** A store's catalogue is only publicly visible while the store itself is live. Several public read paths
   *  (new arrivals, best sellers, trending, pinned, variant lookup, digital preview) only checked the PRODUCT's
   *  status, so a pending/suspended/deleted store's products stayed reachable to anyone with an id. */
  private async isStoreLive(storeId: string): Promise<boolean> {
    if (typeof storeId !== 'string' || !isValidObjectId(storeId)) return false;
    return !!(await this.databaseService.repositories.storeModel.exists({ _id: storeId, status: 'active', isDelete: false }));
  }

  // ── Storefront promotion sections (Best Seller / New Arrival / Trending / Pinned) ──
  // Public, read-only. No new schema — Best Seller/Trending are derived from the
  // same order-aggregation util analytics already uses; New Arrival is a plain
  // sort; Pinned reuses `getShapedProductsByIds` (order-preserving by id list).

  async getPinnedProducts(storeId: string, customerId?: string | null) {
    if (typeof storeId !== 'string' || !isValidObjectId(storeId)) return { success: true, data: { products: [] } };
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false, status: 'active' }).lean();
    if (!store) return { success: true, data: { products: [] } };
    const products = await this.getShapedProductsByIds((store as any).pinnedProductIds ?? [], customerId);
    return { success: true, data: { products } };
  }

  async getNewArrivals(storeId: string, limit: number = 12, customerId?: string | null) {
    if (!(await this.isStoreLive(storeId))) return { success: true, data: { products: [] } };
    const productModel = this.databaseService.repositories.productModel;
    const products = await productModel
      .find({ storeId, status: 'active', isDelete: false, isTest: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return { success: true, data: { products: await this.attachVariantsAndPricing(products, customerId) } };
  }

  private async getTopSellingProducts(storeId: string, from: Date, limit: number, customerId?: string | null) {
    if (!(await this.isStoreLive(storeId))) return { success: true, data: { products: [] } };
    const { orderModel, productModel } = this.databaseService.repositories;
    const sales = await aggregateProductSales(orderModel, from, new Date(), { 'sellerOrders.storeId': storeId });
    const topIds = [...sales].sort((a, b) => b.unitsSold - a.unitsSold).slice(0, limit).map((s) => s.productId);
    if (!topIds.length) return { success: true, data: { products: [] } };

    const products = await productModel.find({ _id: { $in: topIds }, storeId, status: 'active', isDelete: false, isTest: { $ne: true } }).lean();
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

  async getProductById(idOrSlug: string, customerId?: string | null, viewerRole?: string | null) {
    // Products flagged as test are hidden from the public; an admin can still open them.
    const testFilter: any = viewerRole === 'admin' ? {} : { isTest: { $ne: true } };
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
        isDelete: false, ...testFilter,
      })
      .lean();

    if (!product && isValidObjectId(idOrSlug)) {
      product = await productModel
        .findOne({
          _id: idOrSlug,
          status: 'active',
          isDelete: false, ...testFilter,
        })
        .lean();
    }

    // An old link after a rename: the previous slug still finds the product; `canonicalSlug` lets the web replace the URL.
    let viaPreviousSlug = false;
    if (!product && typeof idOrSlug === 'string' && !isValidObjectId(idOrSlug)) {
      product = await productModel.findOne({ previousSlugs: idOrSlug, status: 'active', isDelete: false, ...testFilter }).lean();
      viaPreviousSlug = !!product;
    }

    if (product && (await this.isHiddenByEarlyAccess(product, customerId))) {
      return { message: 'Product not found', success: false, data: null };
    }

    if (!product || !(await this.isStoreLive(product.storeId))) {
      return {
        message: 'Product not found',
        success: false,
        data: null,
      };
    }

    // 2️⃣-4️⃣ Seller, store, variants (keyed off the resolved document's real _id, not the route
    // param, which may be a slug) and subscriber benefits are independent: fetch them in parallel.
    const [seller, store, rawVariants, benefitsEntry] = await Promise.all([
      sellerModel
        .findOne({ _id: product.sellerId })
        .select('name isVerified')
        .lean(),
      storeModel
        .findOne({ _id: product.storeId, isDelete: false })
        .select('slug name logo followersCount status')
        .lean(),
      productVariantModel
        .find({
          productId: product._id.toString(),
          status: 'active',
          isDelete: false,
        })
        .lean(),
      this.subscriptionBenefits.getActiveBenefits(customerId, product.storeId),
    ]);

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

    const pricedVariants = this.applySubscriberPricing(
      rawVariants,
      product,
      benefitsEntry ?? undefined,
    );

    // The campaign price is computed per variant (same helper as the listings), so the variants go through the
    // badge step with the product. While a campaign's sale runs on a variant the seller's own markdown is hidden.
    const [withCampaign] = await this.attachCampaignBadges([
      this.sanitizeDigitalForPublicView({
        ...product,
        variants: pricedVariants,
        // Buyers see the STORE, never the seller's personal name.
        sellerName: (store && store.name) || (seller ? seller.name : null),
        sellerVerified: seller ? !!seller.isVerified : false,
        storeSlug: store ? store.slug : null,
        storeName: store ? store.name : null,
        storeLogo: store ? store.logo : null,
        storeFollowersCount: store ? (store.followersCount ?? 0) : 0,
      }),
    ], customerId);
    const { variants: campaignVariants, ...productWithSeller } = withCampaign as any;
    let variants: any[] = campaignVariants ?? pricedVariants;
    // Canonical URL slug; slugRedirect = the request used an OLD slug, so the web should replace the URL.
    (productWithSeller as any).canonicalSlug = product.slug;
    (productWithSeller as any).slugRedirect = viaPreviousSlug;

    // Edudeen Premium: teaser percent for everyone, member price on the variants for active members.
    {
      const [decorated] = await this.withPremium([{ ...(productWithSeller as any), variants }], customerId);
      if (decorated) {
        if (decorated.premiumPercent) {
          (productWithSeller as any).premiumPercent = decorated.premiumPercent;
          (productWithSeller as any).premiumSellerPercent = decorated.premiumSellerPercent;
          (productWithSeller as any).premiumPlatformPercent = decorated.premiumPlatformPercent;
        }
        // A member with a premium price gets only that price: the campaign badge does not apply to them.
        if ((productWithSeller as any).activeCampaign && decorated.activeCampaign === null) (productWithSeller as any).activeCampaign = null;
        variants = decorated.variants;
      }
    }

    const defaultVariant =
      variants.length > 0
        ? variants.reduce(
            (min, v) => (v.price < min.price ? v : min),
            variants[0],
          )
        : null;

    // Only for a logged-in caller: may THIS buyer review the product? Same rule as RatingService.addReview.
    // One indexed-by-user query on the single-product endpoint — never on list endpoints.
    // `hasReviewed` (same filter addReview uses to detect an existing review) is one more query, run alongside.
    const [canReview, hasReviewed] = customerId
      ? await Promise.all([
          checkVerifiedPurchase(this.databaseService.repositories.orderModel, customerId, product._id.toString(), null),
          this.databaseService.repositories.ratingModel
            .exists({ userId: customerId, productId: product._id.toString(), isDelete: false })
            .then((hit: unknown) => !!hit),
        ])
      : [undefined, undefined];

    return {
      message: 'Product fetched successfully',
      success: true,
      data: {
        product: productWithSeller,
        variants,
        defaultVariant,
        ...(canReview === undefined ? {} : { canReview, hasReviewed }),
      },
    };
  }
  async getVariantById(variantId: string) {
    if (typeof variantId !== 'string' || !isValidObjectId(variantId)) {
      return { message: 'Variant not found', success: false, data: null };
    }
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
        isDelete: false, isTest: { $ne: true },
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
    // A store under admin review may prepare its catalogue; nothing is
    // publicly visible or purchasable until the store is approved (public
    // browse and checkout both require store.status === 'active').
    if (!['active', 'pending'].includes(store.status))
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
      assertPriceRules({ price: v.price, compareAtPrice: v.compareAtPrice, currency: store.baseCurrency, priceLabel: 'Variant price' });
      assertValidPrice(v.price, 'Variant price');
      assertStockRule(v.stock, !!v.unlimitedStock);
      v.shippingWeight = cleanShippingWeight(v.shippingWeight, true);
      if (v.compareAtPrice !== undefined) assertValidPrice(v.compareAtPrice, 'compareAtPrice', { nullable: true });
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

    assertText(name, 'name', 200);
    const title = normalizeTitle(name);
    assertTitleRule(title);
    // The schema requires a non-empty description (a missing one used to come back as a 500); sellers must write at least 20 characters.
    assertDescriptionRule(description);
    assertText(description, 'description', 20000);
    if (status !== undefined) assertSellerStatus(status);
    const scheduledDate = status === 'scheduled' ? parseScheduledAt(scheduledAt) : null;
    const cleanTags = tags === undefined ? [] : assertStringArray(tags, 'tags', { maxItems: 30, maxLength: 60 });
    const cleanImages = images === undefined ? [] : assertStringArray(images, 'images', { maxItems: 20, maxLength: 2048 });

    const categoryId = await this.resolveRootCategoryId(store.categoryId, body.categoryId);

    // Owner rule R3: the normal sale must stay below the Premium discount by the admin's minimum gap.
    await assertPremiumGap(this.premiumService, store as any, premiumFieldsFromBody(body).premiumDiscountPercent, variants.map((v: any) => ({ price: v.price, compareAtPrice: v.compareAtPrice ?? null })), premiumFieldsFromBody(body).premiumOptOut === true);

    const campaignIds = body.campaignIds === undefined ? [] : await this.marketingService.resolveProductCampaignIds(String(store._id), body.campaignIds);
    // Owner rule R3: a product is in a platform sale OR has a Premium offer, never both.
    assertOfferExclusive(store as any, { ...premiumFieldsFromBody(body), campaignIds });
    const slug = await generateProductSlug(productModel, title);
    const learnMeta = cleanLearningMeta(body);
    const quality = this.checkListing({ title, type: 'physical', description, classFrom: learnMeta.classFrom, classTo: learnMeta.classTo, requestedStatus: status });
    const requestedStatus = status ? resolveSellerPublishStatus(status, null) : 'draft';
    // Contact details in the text: saved, but held for admin review (never rejected, never published unseen).
    const finalStatus = quality.scan.flagged && requestedStatus !== 'draft' && requestedStatus !== 'inactive' ? 'pending_review' : requestedStatus;

    const product: any = await (productModel as any).create({
      sellerId,
      storeId: store._id.toString(),
      name: title,
      slug,
      ...this.qualityFields(quality.scan),
      campaignIds,
      ...premiumFieldsFromBody(body),
      description: description ?? null,
      productType: 'physical',
      type: 'physical',
      categoryId,
      subCategoryId: await this.resolveSubCategoryId(categoryId, subCategoryId),
      images: cleanImages,
      tags: cleanTags,
      digital: null,
      isListedOnEdudeen: isListedOnEdudeen ?? false,
      ...learnMeta,
      // A first publish goes to admin review (see resolveSellerPublishStatus).
      status: finalStatus,
      scheduledAt: scheduledDate,
    });

    const defaultIndex = variants.findIndex((v: any) => v.isDefault === true);
    for (const v of variants) v.sku = cleanSku(v.sku);
    const blankSkus = variants.filter((v: any) => !v.sku).length;
    const autoSkus = blankSkus ? await allocateSkus(this.databaseService.repositories.storeModel, store as any, blankSkus) : [];
    const createdVariants = await Promise.all(
      variants.map((v: any, index: number) => {
        const sku = v.sku || autoSkus.shift()!;
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
          shippingWeight: v.shippingWeight,
          images: v.images ?? [],
          isDefault: defaultIndex === -1 ? index === 0 : index === defaultIndex,
        });
      }),
    );

    void scanImagesForContactInfo(String(product._id), cleanImages); // TODO(OCR) no-op hook - see contact-info.util.ts
    return {
      success: true,
      message: 'Physical product created successfully' + this.contactNote(quality.scan),
      // `defaultVariant` mirrors the digital create response; the seller UI caches it to open the edit form.
      data: { product, variants: createdVariants, defaultVariant: createdVariants.find((v: any) => v.isDefault) ?? createdVariants[0] ?? null, warnings: quality.warnings, contactFlag: quality.scan.flagged ? { matches: quality.scan.matches, reason: quality.scan.reason } : null },
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
    // A store under admin review may prepare its catalogue; nothing is
    // publicly visible or purchasable until the store is approved (public
    // browse and checkout both require store.status === 'active').
    if (!['active', 'pending'].includes(store.status))
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
    assertPriceRules({ price, compareAtPrice, currency: store.baseCurrency });
    assertValidPrice(price, 'Price');
    if (compareAtPrice !== undefined) assertValidPrice(compareAtPrice, 'compareAtPrice', { nullable: true });

    if (status === 'scheduled' && !scheduledAt) {
      throw new BadRequestException(
        'scheduledAt is required when status is scheduled',
      );
    }

    assertText(name, 'name', 200);
    const title = normalizeTitle(name);
    assertTitleRule(title);
    // The schema requires a non-empty description (a missing one used to come back as a 500); sellers must write at least 20 characters.
    assertDescriptionRule(description);
    assertText(description, 'description', 20000);
    if (status !== undefined) assertSellerStatus(status);
    const scheduledDate = status === 'scheduled' ? parseScheduledAt(scheduledAt) : null;
    const cleanTags = tags === undefined ? [] : assertStringArray(tags, 'tags', { maxItems: 30, maxLength: 60 });
    const cleanImages = images === undefined ? [] : assertStringArray(images, 'images', { maxItems: 20, maxLength: 2048 });

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

    const categoryId = await this.resolveRootCategoryId(store.categoryId, body.categoryId);

    const validSubCategoryId = await this.resolveSubCategoryId(categoryId, subCategoryId);
    const digitalConfig = digital ? await this.buildDigitalConfig(sellerId, digital, null) : null;
    const delivery = cleanDeliveryFormat(body, null);
    await this.assertCourseReady(null, delivery.deliveryFormat, status ? resolveSellerPublishStatus(status, null) : 'draft');

    // Owner rule R3 (normal sale vs Premium discount), on the base price and every license tier.
    await assertPremiumGap(this.premiumService, store as any, premiumFieldsFromBody(body).premiumDiscountPercent, [
      { price, compareAtPrice: compareAtPrice ?? null },
      ...(Array.isArray(body.licenseTiers) ? body.licenseTiers.map((t: any) => ({ price: Number(t?.price), compareAtPrice: t?.compareAtPrice ?? null })).filter((t: any) => Number.isFinite(t.price)) : []),
    ], premiumFieldsFromBody(body).premiumOptOut === true);

    const campaignIds = body.campaignIds === undefined ? [] : await this.marketingService.resolveProductCampaignIds(String(store._id), body.campaignIds);
    // Owner rule R3: a product is in a platform sale OR has a Premium offer, never both.
    assertOfferExclusive(store as any, { ...premiumFieldsFromBody(body), campaignIds });
    const slug = await generateProductSlug(productModel, title);
    const learnMeta = cleanLearningMeta(body);
    const quality = this.checkListing({ title, type: 'digital', description, classFrom: learnMeta.classFrom, classTo: learnMeta.classTo, requestedStatus: status });
    const requestedStatus = status ? resolveSellerPublishStatus(status, null) : 'draft';
    // Contact details in the text: saved, but held for admin review (never rejected, never published unseen).
    const finalStatus = quality.scan.flagged && requestedStatus !== 'draft' && requestedStatus !== 'inactive' ? 'pending_review' : requestedStatus;

    const product: any = await (productModel as any).create({
      sellerId,
      storeId: store._id.toString(),
      name: title,
      slug,
      ...this.qualityFields(quality.scan),
      campaignIds,
      ...premiumFieldsFromBody(body),
      description: description ?? null,
      productType: finalProductType,
      type: 'digital',
      categoryId,
      subCategoryId: validSubCategoryId,
      educationLevel: finalEducationLevel,
      customLevel: normalizedFields.customLevel,
      normalizedCustomLevel: normalizedFields.normalizedCustomLevel,
      images: cleanImages,
      tags: cleanTags,
      digital: digitalConfig,
      isListedOnEdudeen: isListedOnEdudeen ?? false,
      ...learnMeta,
      ...delivery,
      // A first publish goes to admin review (see resolveSellerPublishStatus).
      status: finalStatus,
      scheduledAt: scheduledDate,
    });

    const [sku] = await allocateSkus(this.databaseService.repositories.storeModel, store as any, 1);

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

    // Classroom / school licenses at their own prices.
    if (body.licenseTiers !== undefined) {
      const tiers = cleanLicenseTiers(body.licenseTiers);
      if (tiers.length) await this.syncLicenseVariants(product, digitalConfig?.licenseType ?? 'personal', tiers, store.baseCurrency ?? 'PKR');
    }

    void this.fillPdfPageCounts(String(product._id));

    void scanImagesForContactInfo(String(product._id), cleanImages); // TODO(OCR) no-op hook - see contact-info.util.ts
    return {
      success: true,
      message: 'Digital product created successfully' + this.contactNote(quality.scan),
      data: { product, defaultVariant, warnings: quality.warnings, contactFlag: quality.scan.flagged ? { matches: quality.scan.matches, reason: quality.scan.reason } : null },
    };
  }

  /**
   * Quality checks shared by every create/edit: class range (needed to go live for digital/educational), the non-blocking
   * title warnings, and the off-platform contact scan of the seller-written text.
   */
  private checkListing(opts: { title: string; type: 'physical' | 'digital'; description?: unknown; classFrom?: string | null; classTo?: string | null; requestedStatus?: string | null; fields?: Record<string, unknown> }) {
    const goingLive = opts.requestedStatus === 'active' || opts.requestedStatus === 'scheduled';
    assertClassRangeRule({ type: opts.type, classFrom: opts.classFrom, classTo: opts.classTo, goingLive });
    return {
      warnings: productWarnings(opts.title, opts.classFrom, opts.classTo),
      scan: scanListingText(opts.fields ?? { name: opts.title, description: opts.description }),
    };
  }

  /** Mongo fields for the contact_info review flag (set when flagged, cleared when the text is clean). */
  private qualityFields(scan: { flagged: boolean; matches: string[]; reason: string | null }) {
    return scan.flagged
      ? { flags: [CONTACT_FLAG], contactMatches: scan.matches, flagReason: scan.reason }
      : { flags: [] as string[], contactMatches: [] as string[], flagReason: null };
  }

  private contactNote(scan: { flagged: boolean }): string {
    return scan.flagged ? ' - it contains contact details (phone, WhatsApp or email), so it was sent to review instead of going live. Remove them and save again, or wait for our team.' : '';
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

    let variants: any[] = await productVariantModel
      .find({
        productId,
        isDelete: false,
      })
      .lean();
    const heldVariants = (product as any).pendingEdit?.changes?.__variants as Record<string, Record<string, unknown>> | undefined;
    if (heldVariants) variants = variants.map((v) => (heldVariants[String(v._id)] ? { ...v, ...heldVariants[String(v._id)] } : v));

    let defaultVariant: any =
      variants.find((v: any) => v.isDefault) || variants[0] || null;
    const pendingChanges: any = (product as any).pendingEdit?.changes;
    if (defaultVariant && pendingChanges && ('__price' in pendingChanges || '__compareAtPrice' in pendingChanges)) {
      // The seller's own pending price shows in the form (buyers still pay the live price).
      defaultVariant = { ...defaultVariant, ...('__price' in pendingChanges ? { price: pendingChanges.__price } : {}), ...('__compareAtPrice' in pendingChanges ? { compareAtPrice: pendingChanges.__compareAtPrice } : {}) };
    }

    return {
      success: true,
      message: 'Product fetched successfully',
      // The seller sees their own pending edit in the form; buyers still see the live version.
      data: { product: (product as any).pendingEdit?.changes ? overlayPendingEdit(product as any) : product, variants, defaultVariant },
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

    const page = clampInt(query.page, 1, 1, 100000);
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

    if (name !== undefined) assertText(name, 'name', 200);
    const newTitle = name === undefined ? undefined : normalizeTitle(name);
    if (newTitle !== undefined && newTitle !== product.name) {
      assertTitleRule(newTitle);
      // Clean slug from the full title; the old one is remembered so old links keep working (redirected).
      const slug = await generateProductSlug(productModel, newTitle, { excludeId: productId });
      productUpdate.name = newTitle;
      if (slug !== product.slug) {
        productUpdate.slug = slug;
        productUpdate.previousSlugs = nextPreviousSlugs((product as any).previousSlugs, product.slug, slug);
      }
    }
    if (description !== undefined && description !== null) assertDescriptionRule(description);
    if (description !== undefined) productUpdate.description = description === null ? null : assertText(description, 'description', 20000);
    let effectiveCategoryId = product.categoryId;
    if (body.categoryId !== undefined && body.categoryId !== null && body.categoryId !== '' && body.categoryId !== product.categoryId) {
      effectiveCategoryId = await this.resolveRootCategoryId(product.categoryId, body.categoryId);
      productUpdate.categoryId = effectiveCategoryId;
      productUpdate.subCategoryId = null;
    }
    if (subCategoryId !== undefined)
      productUpdate.subCategoryId = await this.resolveSubCategoryId(effectiveCategoryId, subCategoryId);
    if (images !== undefined) productUpdate.images = assertStringArray(images, 'images', { maxItems: 20, maxLength: 2048 });
    if (tags !== undefined) productUpdate.tags = assertStringArray(tags, 'tags', { maxItems: 30, maxLength: 60 });
    if (isListedOnEdudeen !== undefined)
      productUpdate.isListedOnEdudeen = isListedOnEdudeen;
    if (body.campaignIds !== undefined)
      productUpdate.campaignIds = await this.marketingService.resolveProductCampaignIds(product.storeId, body.campaignIds);
    Object.assign(productUpdate, premiumFieldsFromBody(body)); // seller-funded Premium member price override (1-50 or null) + opt-out
    // Owner rule R3: platform sale XOR Premium offer (checked only when this request touches one of them).
    if (body.campaignIds !== undefined || body.premiumDiscountPercent !== undefined || body.premiumOptOut !== undefined) {
      const offerStore = await this.databaseService.repositories.storeModel.findById(product.storeId).select('premiumDiscount').lean();
      assertOfferExclusive(offerStore as any, {
        premiumDiscountPercent: productUpdate.premiumDiscountPercent !== undefined ? productUpdate.premiumDiscountPercent : (product as any).premiumDiscountPercent,
        premiumOptOut: productUpdate.premiumOptOut !== undefined ? productUpdate.premiumOptOut : (product as any).premiumOptOut,
        campaignIds: productUpdate.campaignIds ?? (product as any).campaignIds,
      });
    }
    if (status !== undefined) {
      assertSellerStatus(status);
      productUpdate.status = resolveSellerPublishStatus(status, product);
      productUpdate.scheduledAt = status === 'scheduled' ? parseScheduledAt(scheduledAt) : null;
    }
    if (digital !== undefined && product.type === 'digital') {
      productUpdate.digital = await this.buildDigitalConfig(sellerId, digital, product.digital ?? null);
    }
    Object.assign(productUpdate, cleanLearningMeta(body));
    if (product.type === 'digital') {
      Object.assign(productUpdate, cleanDeliveryFormat(body, product as any));
      await this.assertCourseReady(productId, productUpdate.deliveryFormat ?? (product as any).deliveryFormat, productUpdate.status ?? (productUpdate.deliveryFormat ? product.status : null));
    }
    {
      const nextMin = productUpdate.ageMin !== undefined ? productUpdate.ageMin : product.ageMin;
      const nextMax = productUpdate.ageMax !== undefined ? productUpdate.ageMax : product.ageMax;
      if (nextMin != null && nextMax != null && nextMin > nextMax) throw new BadRequestException('ageMin cannot be more than ageMax');
      if (productUpdate.classFrom !== undefined || productUpdate.classTo !== undefined) {
        let cf = productUpdate.classFrom !== undefined ? productUpdate.classFrom : product.classFrom;
        let ct = productUpdate.classTo !== undefined ? productUpdate.classTo : product.classTo;
        if (cf && !ct) ct = cf;
        if (ct && !cf) cf = ct;
        if (cf && ct && classIndex(cf) > classIndex(ct)) throw new BadRequestException('classFrom cannot be after classTo');
        productUpdate.classFrom = cf ?? null;
        productUpdate.classTo = ct ?? null;
      }
    }

    // Title warnings, class range (to go live) and the contact-info scan - only for what this request touches.
    let editWarnings: string[] = [];
    let editScan: { flagged: boolean; matches: string[]; reason: string | null } | null = null;
    let flaggedStatusBefore: { had: boolean; value?: string } | null = null;
    {
      const effTitle = productUpdate.name ?? product.name;
      const effFrom = productUpdate.classFrom !== undefined ? productUpdate.classFrom : product.classFrom;
      const effTo = productUpdate.classTo !== undefined ? productUpdate.classTo : product.classTo;
      const effDescription = description !== undefined ? description : product.description;
      const quality = this.checkListing({ title: effTitle, type: product.type === 'physical' ? 'physical' : 'digital', classFrom: effFrom, classTo: effTo, requestedStatus: status, fields: { name: effTitle, description: effDescription } });
      editWarnings = quality.warnings;
      if (name !== undefined || description !== undefined) {
        editScan = quality.scan;
        Object.assign(productUpdate, this.qualityFields(quality.scan));
        // Held for review instead of staying/going live while it shows contact details.
        if (quality.scan.flagged && ['active', 'scheduled'].includes(productUpdate.status ?? product.status)) {
          flaggedStatusBefore = { had: productUpdate.status !== undefined, value: productUpdate.status };
          productUpdate.status = 'pending_review';
        }
      }
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
        } else if (!product.customLevel || product.educationLevel !== EducationLevel.OTHER) {
          // Moving TO "other" must bring its own customLevel — a stale one left from an earlier
          // "other" (or none at all) is not accepted silently.
          throw new BadRequestException(
            'customLevel is required when educationLevel is "other"',
          );
        }
      } else if (productUpdate.educationLevel !== undefined) {
        productUpdate.customLevel = null;
        productUpdate.normalizedCustomLevel = null;
      }
    }

    // Price rules (digital/educational default variant): compare-at above price, no negatives, PKR whole rupees. Checked before anything is written.
    if (product.type !== 'physical' && (price !== undefined || compareAtPrice !== undefined)) {
      const ruleStore = await this.databaseService.repositories.storeModel.findById(product.storeId).select('baseCurrency').lean();
      const curVariant: any = price !== undefined && compareAtPrice !== undefined ? null : await productVariantModel.findOne({ productId, isDefault: true, isDelete: false }).select('price compareAtPrice').lean();
      assertPriceRules({
        price: price !== undefined ? price : curVariant?.price,
        compareAtPrice: compareAtPrice !== undefined ? compareAtPrice : curVariant?.compareAtPrice,
        currency: (ruleStore as any)?.baseCurrency,
      });
    }

    // Owner rule R3 - only when this request touches prices / the Premium percent (never for unrelated edits of an
    // existing product, so legacy listings stay editable).
    if (this.premiumService && (price !== undefined || compareAtPrice !== undefined || body.premiumDiscountPercent !== undefined || body.premiumOptOut !== undefined || body.licenseTiers !== undefined)) {
      const gapStore = await this.databaseService.repositories.storeModel.findById(product.storeId).select('premiumDiscount').lean();
      const own = body.premiumDiscountPercent !== undefined ? premiumFieldsFromBody(body).premiumDiscountPercent : (product as any).premiumDiscountPercent;
      const current: any[] = await productVariantModel.find({ productId, isDelete: false, status: 'active' }).select('price compareAtPrice isDefault options').lean();
      const prices: Array<{ price: number; compareAtPrice?: number | null }> = current.map((v) =>
        product.type !== 'physical' && v.isDefault
          ? { price: price !== undefined ? price : v.price, compareAtPrice: compareAtPrice !== undefined ? compareAtPrice : v.compareAtPrice }
          : { price: v.price, compareAtPrice: v.compareAtPrice });
      if (Array.isArray(body.licenseTiers)) {
        for (const t of body.licenseTiers) if (Number.isFinite(Number(t?.price))) prices.push({ price: Number(t.price), compareAtPrice: t?.compareAtPrice ?? null });
      }
      await assertPremiumGap(this.premiumService, gapStore as any, own, prices, (productUpdate.premiumOptOut !== undefined ? productUpdate.premiumOptOut : (product as any).premiumOptOut) === true);
    }

    // An approved listing that is live: content edits wait for admin approval, buyers keep seeing the old version.
    const productPlain = (product as any).toObject ? (product as any).toObject() : (product as any);
    const split = splitEditForReview(productPlain, productUpdate);
    let writeUpdate: any = productUpdate;
    let editSentForReview = false;
    // Price of a digital/educational listing lives on its default variant: a changed price waits for approval too.
    const heldPrice: Record<string, unknown> = {};
    let heldVariantView: any = null;
    if (split.hold && product.type !== 'physical' && (price !== undefined || compareAtPrice !== undefined)) {
      const dv: any = await productVariantModel.findOne({ productId, isDefault: true, isDelete: false }).lean();
      if (dv) {
        if (price !== undefined && Number(price) !== Number(dv.price)) heldPrice.__price = Number(price);
        if (compareAtPrice !== undefined && (compareAtPrice ?? null) !== (dv.compareAtPrice ?? null)) heldPrice.__compareAtPrice = compareAtPrice ?? null;
        if (Object.keys(heldPrice).length) heldVariantView = { ...dv, ...(heldPrice.__price !== undefined ? { price: heldPrice.__price } : {}), ...('__compareAtPrice' in heldPrice ? { compareAtPrice: heldPrice.__compareAtPrice } : {}) };
      }
    }
    const priceHeld = Object.keys(heldPrice).length > 0;
    if (split.hold) {
      writeUpdate = { ...split.immediate };
      const priorChanges: Record<string, unknown> = productPlain.pendingEdit?.changes ?? {};
      const heldNow = { ...split.held, ...heldPrice };
      const mergedChanges = { ...priorChanges, ...heldNow };
      if (Object.keys(heldNow).length > 0) {
        // The contact-info flag moved into the held content, so the live listing is not pulled off the shelf by it.
        if (flaggedStatusBefore) { if (flaggedStatusBefore.had) writeUpdate.status = flaggedStatusBefore.value; else delete writeUpdate.status; }
        editSentForReview = true;
        if (JSON.stringify(mergedChanges) !== JSON.stringify(priorChanges)) {
          const fields = Object.keys(mergedChanges).filter((k) => !['slug', 'previousSlugs', 'normalizedCustomLevel', 'flags', 'contactMatches', 'flagReason'].includes(k));
          writeUpdate.pendingEdit = { changes: mergedChanges, fields, submittedAt: new Date() };
          writeUpdate.lastEditRejection = null;
          this.activityLogService.log({
            storeId: product.storeId, category: 'products', action: 'listing_edit_submitted',
            description: `Seller edited live listing "${product.name}" (${fields.join(', ')}) - waiting for admin review`,
            actorId: sellerId, actorRole: 'seller', targetId: productId, targetType: 'product',
          } as any);
        }
      }
    }
    if (!split.hold && productPlain.pendingEdit) writeUpdate = { ...writeUpdate, pendingEdit: null }; // drop any old held edit
    let updatedProduct: any =
      Object.keys(writeUpdate).length > 0
        ? await productModel.findByIdAndUpdate(productId, writeUpdate, {
            runValidators: true,
            returnDocument: 'after',
          })
        : product;
    if (writeUpdate.digital) void this.fillPdfPageCounts(productId);

    // Digital/educational products still have exactly one (default) variant
    // and no dedicated variant-management endpoints — price/compareAtPrice
    // edits for them stay routed through here. Physical products manage
    // price per-variant exclusively via the product-variants module now.
    let updatedVariant: any = heldVariantView ?? undefined;
    if (product.type !== 'physical' && (price !== undefined || compareAtPrice !== undefined) && !priceHeld) {
      if (price !== undefined) assertValidPrice(price, 'Price');
      if (compareAtPrice !== undefined) assertValidPrice(compareAtPrice, 'compareAtPrice', { nullable: true });
      const variantUpdate: any = {};
      if (price !== undefined) variantUpdate.price = price;
      if (compareAtPrice !== undefined) variantUpdate.compareAtPrice = compareAtPrice;
      updatedVariant = await productVariantModel.findOneAndUpdate(
        { productId, isDefault: true, isDelete: false },
        variantUpdate,
        { returnDocument: 'after' },
      );
    }

    // Classroom / school licenses (digital only). `null` or [] removes them.
    if (body.licenseTiers !== undefined && product.type === 'digital') {
      const tiers = cleanLicenseTiers(body.licenseTiers);
      const store = await this.databaseService.repositories.storeModel.findById(product.storeId).select('baseCurrency').lean();
      const baseLicense = (updatedProduct as any)?.digital?.licenseType ?? product.digital?.licenseType ?? 'personal';
      await this.syncLicenseVariants(updatedProduct ?? product, baseLicense, tiers, (store as any)?.baseCurrency ?? 'PKR');
    }

    void scanImagesForContactInfo(productId, Array.isArray(images) ? images : (product as any).images ?? []); // TODO(OCR) no-op hook
    const pendingNow = !!(updatedProduct as any)?.pendingEdit?.changes;
    const outProduct = pendingNow ? overlayPendingEdit(typeof (updatedProduct as any)?.toObject === 'function' ? (updatedProduct as any).toObject() : updatedProduct) : updatedProduct;
    return {
      success: true,
      message: editSentForReview || pendingNow
        ? 'Your changes were sent to Edudeen for review. The live listing stays as it is until they are approved.'
        : 'Product updated successfully' + (editScan ? this.contactNote(editScan) : ''),
      data: { product: outProduct, pendingReview: editSentForReview || pendingNow, variant: updatedVariant, warnings: editWarnings, contactFlag: editScan?.flagged ? { matches: editScan.matches, reason: editScan.reason } : null },
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
