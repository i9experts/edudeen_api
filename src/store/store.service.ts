/* eslint-disable prettier/prettier */
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { promises as dns } from 'dns';
import { DatabaseService } from 'src/database/databaseservice';
import {
  SellerType, ProductType, resolveTools,
  BUSINESS_TYPES, ID_DOCUMENT_TYPES, VERIFICATION_DOCUMENT_TYPES,
  determineVerificationLevel, assertValidVerificationTransition,
  type BusinessType, type VerificationDocumentType, type VerificationDocument,
  type VerificationStatus,
} from './schemas/store.schema';
import { getVerificationRequirements, isFieldSatisfied } from './verification-requirements.config';
import { UploadService } from 'src/upload/upload.service';
import { SUPPORTED_CURRENCIES } from 'src/exchange-rate/schemas/exchange-rate.schema';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { UpdateStoreCustomerDto } from './dto/update-store-customer.dto';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { SellerPlatformSubscriptionsService } from 'src/platform-plans/seller-platform-subscriptions.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import { RedisService } from 'src/redis/redis.service';
import { MarketingService } from 'src/marketing/marketing.service';
import { pickPrimaryCampaignForBadge } from 'src/marketing/campaign-pricing.util';
import { AdminConfigService } from 'src/admin-config/admin-config.service';
import { StoreThemeService } from '../store-theme/store-theme.service';
import { StorePagesService } from '../store-pages/store-pages.service';
import { CollectionsService } from '../collections/collections.service';

// Store slugs render at the site root (`edudeen.com/:slug`) — these are the
// frontend's top-level static route segments (router/index.tsx), reserved so
// a store can never claim a URL that collides with a real app page.
const RESERVED_STORE_SLUGS = new Set([
  'pricing', 'sellers', 'faq', 'privacy-policy', 'terms-of-service', 'cookie-policy',
  'contact-us', 'account', 'marketplace', 'cart', 'checkout', 'order-success',
  'educationmarketplace', 'education', 'product', 'maintenance', 'login', 'register', 'onboard',
  'forgot-password', 'verify-otp', 'new-password', 'seller', 'admin', 'store',
]);

// The CNAME target every seller's custom domain must point at — the ONE
// source of truth for this string, shown verbatim in the seller-facing DNS
// instructions (`DomainWhiteLabelCard`, kept in sync by hand since the
// frontend can't import a backend constant) and checked against in
// `verifyCustomDomain`. Changing this value requires actually re-pointing
// the platform's real infrastructure at it too (see that method's docblock
// for the ops step this does NOT automate).
export const CUSTOM_DOMAIN_CNAME_TARGET = 'stores.edudeen.com';

@Injectable()
export class StoreService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly subscriptionBenefits: SubscriptionBenefitsService,
    private readonly entitlementsService: EntitlementsService,
    private readonly sellerPlatformSubscriptionsService: SellerPlatformSubscriptionsService,
    private readonly notificationsService: NotificationsService,
    private readonly redisService: RedisService,
    private readonly marketingService: MarketingService,
    private readonly adminConfigService: AdminConfigService,
    private readonly uploadService: UploadService,
    private readonly storeThemeService: StoreThemeService,
    private readonly storePagesService: StorePagesService,
    private readonly collectionsService: CollectionsService,
  ) {}

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  // A store's category must be one of the admin-curated main categories —
  // not a subcategory, and not an arbitrary/made-up id.
  private async assertValidRootCategory(categoryId: string) {
    const category = await this.databaseService.repositories.categoryModel.findOne({
      _id: categoryId,
      status: 'active',
      isDelete: false,
    });
    if (!category) throw new BadRequestException('Selected category not found');
    if (category.parentId) throw new BadRequestException('Store category must be a main category, not a subcategory');
  }

  async createStore(sellerId: string, body: any) {
    const { name, logo, categoryId, description, sellerType, productTypes, baseCurrency } = body;

    if (!name) throw new BadRequestException('Store name is required');

    // Pricing currency is chosen once, here, and is locked forever the
    // moment this store has its first product (see ProductVariantsService/
    // ProductsService, which stamp every new variant's currency from this
    // field rather than letting it be picked per-product) — this is what
    // prevents a seller's price number from ever being silently
    // reinterpreted under a different currency later. The frontend
    // onboarding flow suggests a default from the seller's detected
    // country, but never forces it — this validation only enforces that
    // whatever was chosen is one of the currencies Edudeen actually
    // supports today.
    if (!baseCurrency || !SUPPORTED_CURRENCIES.includes(baseCurrency)) {
      throw new BadRequestException(
        `baseCurrency is required and must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
      );
    }

    if (categoryId) await this.assertValidRootCategory(categoryId);

    if (sellerType && !Object.values(SellerType).includes(sellerType)) {
      throw new BadRequestException('Invalid sellerType');
    }

    if (productTypes && Array.isArray(productTypes)) {
      const validTypes = Object.values(ProductType);
      for (const pt of productTypes) {
        if (!validTypes.includes(pt)) {
          throw new BadRequestException(`Invalid productType: ${pt}`);
        }
      }
    }

    // ✅ multiple stores allowed — koi "already have a store" check nahi

    const baseSlug = this.generateSlug(name);
    let slug = baseSlug;
    let count = 1;

    while (
      RESERVED_STORE_SLUGS.has(slug) ||
      (await this.databaseService.repositories.storeModel.findOne({ slug }))
    ) {
      slug = `${baseSlug}-${count}`;
      count++;
    }

    const finalProductTypes = productTypes ?? [];

    // Self-serve activation: a seller who completed the onboarding wizard's
    // Payment step already has a verified card on file (see
    // SellerPlatformSubscriptionsService.confirmOnboardingPaymentMethod) —
    // there's nothing left for an admin to gate, so the store goes straight
    // to `active` instead of the pending/admin-review Leads queue. A store
    // created any other way (e.g. a future non-onboarding path with no
    // payment method on file) still starts `pending`, same as before.
    const seller = await this.databaseService.repositories.sellerModel.findById(sellerId).lean();
    const selfServeActivation = !!(seller as any)?.hasPlatformPaymentMethod;

    const store = await this.databaseService.repositories.storeModel.create({
      sellerId,
      name,
      slug,
      logo: logo ?? null,
      categoryId: categoryId ?? null,
      description: description ?? null,
      sellerType: sellerType ?? null,
      productTypes: finalProductTypes,
      enabledTools: resolveTools(finalProductTypes),
      baseCurrency,
      status: selfServeActivation ? 'active' : 'pending',
      ...(selfServeActivation ? { reviewedAt: new Date() } : {}),
    });

    // ✅ seller pe sirf onboarded mark — storeId nahi rakhte (source of truth = Store.sellerId)
    // onboardingDraft cleared too — nothing left to resume once the store is real.
    await this.databaseService.repositories.sellerModel.findByIdAndUpdate(sellerId, {
      isOnboarded: true,
      onboardingDraft: null,
    });

    // Every store always has exactly one platform-plan subscription — auto
    // start on the free tier so onboarding has zero friction (see EntitlementsService).
    await this.sellerPlatformSubscriptionsService.ensureDefaultSubscription(store._id.toString(), sellerId);

    // Every store gets its own storefront chrome (theme/header/footer) and a
    // home page seeded at creation time, not lazily on first public visit —
    // lazy-on-a-public-GET would let two simultaneous buyer visits race on
    // creating the same home page. Both calls are idempotent upserts.
    await this.storeThemeService.ensureDefaultTheme(store._id.toString());
    await this.storePagesService.ensureHomePage(store._id.toString());

    return {
      success: true,
      message: 'Store created successfully',
      data: store,
    };
  }

  // ── Seller business verification (Leads review) ──────────────────────────
  // Store.status (marketplace listing) and Store.verificationStatus (KYC
  // review) are deliberately separate fields — see store.schema.ts. Every
  // method below reads/writes `verificationStatus`, never `status`, except
  // where a comment explicitly says otherwise (only admin approve/reject
  // ever touches both, because Edudeen has one review action, not two).

  private async findOwnedStoreOrThrow(sellerId: string, storeId: string, opts?: { withVerification?: boolean }) {
    const query = this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (opts?.withVerification) query.select('+verification');
    const store = await query;
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');
    return store;
  }

  /** Documents are stored as Cloudinary private-type publicIds (never a bare
   *  URL) — a signed, short-lived URL is generated fresh on every read so a
   *  sensitive document (ID, tax cert) is never permanently link-shareable. */
  private signedDocumentUrl(d: VerificationDocument) {
    return this.uploadService.generateSignedUrl(d.publicId, d.resourceType, 600, d.fileName);
  }

  /** THE evaluation used by getVerification (seller view), getLeadDetail
   *  (admin view — see AdminMarketplaceService), and submitVerification
   *  (the actual security gate) — one calculation, three consumers. Renders
   *  the FULL checklist (required + optional), each entry tagged with its
   *  current state, instead of just the list of what's missing, so the UI
   *  never has to re-derive "why is this shown" logic of its own. */
  private evaluateVerification(store: any) {
    const v = store.verification ?? {};
    const level = store.verificationLevel ?? determineVerificationLevel(store.businessType ?? null);
    const req = getVerificationRequirements(store.country ?? 'PK', store.businessType ?? null, level);

    const missingFields = req.requiredFields.filter((path) => !isFieldSatisfied(v, path));

    const uploadedByType = new Map<string, VerificationDocument>((v.documents ?? []).map((d: VerificationDocument) => [d.type, d]));
    const allDocTypes = [...new Set([...req.requiredDocuments, ...req.optionalDocuments])];
    const documents = allDocTypes.map((type) => {
      const uploaded = uploadedByType.get(type);
      const required = req.requiredDocuments.includes(type);
      return {
        type,
        required,
        state: uploaded ? 'uploaded' : (required ? 'missing' : 'not_required'),
        fileName: uploaded?.fileName ?? null,
        uploadedAt: uploaded?.uploadedAt ?? null,
        viewUrl: uploaded ? this.signedDocumentUrl(uploaded) : null,
      };
    });
    const missingDocuments = req.requiredDocuments.filter((t) => !uploadedByType.has(t));

    return {
      requirements: req,
      missingFields,
      missingDocuments,
      documents,
      canSubmit: missingFields.length === 0 && missingDocuments.length === 0,
    };
  }

  async getVerification(sellerId: string, storeId: string) {
    const store = await this.findOwnedStoreOrThrow(sellerId, storeId, { withVerification: true });
    const v: any = store.verification ?? {};
    const evaluation = this.evaluateVerification(store);

    return {
      success: true,
      data: {
        country: store.country ?? 'PK',
        businessType: store.businessType ?? null,
        verificationLevel: evaluation.requirements.verificationLevel,
        verificationStatus: store.verificationStatus ?? 'not_started',
        legalBusinessName: v.legalBusinessName ?? null,
        registrationNumber: v.registrationNumber ?? null,
        taxId: v.taxId ?? null,
        businessAddress: v.businessAddress ?? null,
        idDocumentType: v.idDocumentType ?? null,
        authorizedContact: v.authorizedContact ?? null,
        documents: evaluation.documents,
        missingFields: evaluation.missingFields,
        missingDocuments: evaluation.missingDocuments,
        canSubmit: evaluation.canSubmit,
        history: v.history ?? [],
        storeStatus: store.status,
        rejectionReason: store.rejectionReason ?? null,
      },
    };
  }

  /** Live preview — "what would I need to submit if I picked this country /
   *  business type?" — called as the seller fills in Business Info, before
   *  anything is saved. Falls back to the store's currently-persisted
   *  values when a param is omitted, so it also works as "what applies to
   *  me right now". Never trusts these query params for anything other
   *  than this preview — the actual gate (submitVerification) always
   *  recomputes from persisted data, never from a request param. */
  async getVerificationRequirements(sellerId: string, storeId: string, query: { country?: string; businessType?: string }) {
    const store = await this.findOwnedStoreOrThrow(sellerId, storeId);

    const businessType = (query.businessType as BusinessType) ?? store.businessType ?? null;
    if (businessType && !BUSINESS_TYPES.includes(businessType)) {
      throw new BadRequestException('Invalid businessType');
    }
    const country = query.country ?? store.country ?? 'PK';
    const level = determineVerificationLevel(businessType);

    return { success: true, data: getVerificationRequirements(country, businessType, level) };
  }

  /** Same preview, but usable BEFORE a store exists — onboarding doesn't
   *  create the store until the final submit step, so there's no storeId to
   *  scope `getVerificationRequirements` (above) to yet. Pure function of
   *  country+businessType, no DB read at all — no ownership check needed. */
  previewVerificationRequirementsStandalone(query: { country?: string; businessType?: string }) {
    const businessType = (query.businessType as BusinessType) ?? null;
    if (businessType && !BUSINESS_TYPES.includes(businessType)) {
      throw new BadRequestException('Invalid businessType');
    }
    const country = query.country ?? 'PK';
    const level = determineVerificationLevel(businessType);
    return { success: true, data: getVerificationRequirements(country, businessType, level) };
  }

  /** Draft-save — usable while verification is `not_started` (first pass)
   *  or `rejected` (fixing up before resubmitting). Locked once it's
   *  `pending`/`under_review`/`verified` so submitted data can't shift
   *  mid-review — this is a `verificationStatus` check, not `status`, so
   *  editing verification never depends on the store's marketplace state. */
  async updateVerification(sellerId: string, storeId: string, body: {
    country?: string;
    businessType?: BusinessType;
    legalBusinessName?: string;
    registrationNumber?: string;
    taxId?: string;
    businessAddress?: string;
    idDocumentType?: string;
    authorizedContact?: { name?: string; designation?: string; email?: string; phone?: string };
    documents?: { type: VerificationDocumentType; publicId: string; resourceType?: string; fileName: string }[];
  }) {
    const store = await this.findOwnedStoreOrThrow(sellerId, storeId, { withVerification: true });
    const verificationStatus: VerificationStatus = store.verificationStatus ?? 'not_started';
    if (!['not_started', 'rejected'].includes(verificationStatus)) {
      throw new BadRequestException('Verification details can no longer be edited once submitted for review');
    }

    if (body.businessType && !BUSINESS_TYPES.includes(body.businessType)) {
      throw new BadRequestException('Invalid businessType');
    }
    if (body.idDocumentType && !ID_DOCUMENT_TYPES.includes(body.idDocumentType as any)) {
      throw new BadRequestException('Invalid idDocumentType');
    }
    if (body.documents) {
      for (const d of body.documents) {
        if (!VERIFICATION_DOCUMENT_TYPES.includes(d.type)) throw new BadRequestException(`Invalid document type: ${d.type}`);
      }
    }

    // `store.verification` is a live Mongoose subdocument instance, not a
    // plain object — spreading it directly also captures Mongoose's own
    // internal bookkeeping properties (`_doc`, `$__`, `$__parent`) as
    // enumerable own-properties, and casting that polluted shape back
    // against the schema for `$set` silently falls back to the stale
    // internal `_doc` snapshot, discarding every field set below even
    // though the write reports success. `.toObject()` gives a genuinely
    // clean plain-object snapshot of just the real field values.
    const current: any = (store.verification as any)?.toObject?.() ?? store.verification ?? {};
    const next: Record<string, unknown> = { ...current };
    if (body.legalBusinessName !== undefined) next.legalBusinessName = body.legalBusinessName;
    if (body.registrationNumber !== undefined) next.registrationNumber = body.registrationNumber;
    if (body.taxId !== undefined) next.taxId = body.taxId;
    if (body.businessAddress !== undefined) next.businessAddress = body.businessAddress;
    if (body.idDocumentType !== undefined) next.idDocumentType = body.idDocumentType;
    if (body.authorizedContact !== undefined) {
      next.authorizedContact = { ...(current.authorizedContact ?? {}), ...body.authorizedContact };
    }
    if (body.documents !== undefined) {
      // Replace-by-type — re-uploading a document type overwrites the
      // previous one instead of accumulating duplicates. Nothing is ever
      // deleted just because a country/business-type change made a
      // previously-uploaded document no longer required (see section 12/13
      // of the spec this implements) — it simply stops appearing as
      // "required" in evaluateVerification's checklist.
      const byType = new Map<string, VerificationDocument>(
        (current.documents ?? []).map((d: VerificationDocument) => [d.type, d]),
      );
      for (const d of body.documents) {
        byType.set(d.type, { type: d.type, publicId: d.publicId, resourceType: d.resourceType ?? 'raw', fileName: d.fileName, uploadedAt: new Date() });
      }
      next.documents = [...byType.values()];
    }

    const update: Record<string, unknown> = { verification: next };
    // Country/businessType changes recompute the applicable level
    // server-side — never accepted as a client-supplied value.
    if (body.country !== undefined) update.country = body.country;
    if (body.businessType !== undefined) {
      update.businessType = body.businessType;
      update.verificationLevel = determineVerificationLevel(body.businessType);
    }

    await this.databaseService.repositories.storeModel.findByIdAndUpdate(storeId, { $set: update });
    return { success: true, message: 'Verification details saved' };
  }

  /** Called once at the end of the onboarding Documents step (first-time
   *  submission) or from the standalone verification page (resubmission
   *  after rejection) — independently recomputes the requirement set from
   *  the store's CURRENTLY PERSISTED country/businessType/level (never a
   *  client-cached list) and rejects with a structured error naming exactly
   *  what's missing if anything is absent. This is the real security
   *  boundary — the frontend's own checklist is UX only. */
  async submitVerification(sellerId: string, storeId: string) {
    const store = await this.findOwnedStoreOrThrow(sellerId, storeId, { withVerification: true });
    const verificationStatus: VerificationStatus = store.verificationStatus ?? 'not_started';
    if (!['not_started', 'rejected'].includes(verificationStatus)) {
      throw new BadRequestException('This store has already been submitted for review');
    }

    const evaluation = this.evaluateVerification(store);
    if (!evaluation.canSubmit) {
      throw new BadRequestException({
        message: 'Please complete every required field and document before submitting',
        missingFields: evaluation.missingFields,
        missingDocuments: evaluation.missingDocuments,
      });
    }

    const nextStatus: VerificationStatus = 'pending';
    assertValidVerificationTransition(verificationStatus, nextStatus);

    const wasRejected = verificationStatus === 'rejected';
    const historyEntry = {
      action: wasRejected ? 'resubmitted' : 'submitted',
      note: null,
      actorId: sellerId,
      actorRole: 'seller',
      at: new Date(),
    };

    await this.databaseService.repositories.storeModel.findByIdAndUpdate(storeId, {
      $set: {
        verificationStatus: nextStatus,
        rejectionReason: null,
      },
      $push: { 'verification.history': historyEntry },
    });

    return { success: true, message: wasRejected ? 'Resubmitted for review' : 'Submitted for review' };
  }

  /** Admin-only variant of evaluateVerification — no seller-ownership check
   *  (the caller is AdminMarketplaceService, already gated to admins by its
   *  own controller). Reused so the admin Leads detail view and the
   *  seller's own verification page render the exact same checklist logic
   *  instead of two independent implementations drifting apart. */
  async getVerificationEvaluationForAdmin(storeId: string) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).select('+verification');
    if (!store) throw new NotFoundException('Store not found');
    return this.evaluateVerification(store);
  }

  /** KYC document upload — thin wrapper so the frontend can upload straight
   *  to Cloudinary private storage via the existing upload pipeline, then
   *  attach the returned publicId to this store's verification record in
   *  the same call (instead of two separate requests the seller could
   *  abandon halfway through). */
  async attachVerificationDocument(sellerId: string, storeId: string, type: string, doc: { publicId: string; resourceType: string; fileName: string }) {
    if (!VERIFICATION_DOCUMENT_TYPES.includes(type as VerificationDocumentType)) {
      throw new BadRequestException(`Invalid document type: ${type}`);
    }
    return this.updateVerification(sellerId, storeId, {
      documents: [{ type: type as VerificationDocumentType, ...doc }],
    });
  }

  /** Platform-plan-gated: only stores on a plan with `customDomainAllowed` may set a custom domain. */
  async setCustomDomain(sellerId: string, storeId: string, domain: string | null) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    const normalized = domain ? domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
    if (normalized) {
      await this.entitlementsService.assertFeatureAllowed(storeId, 'customDomainAllowed', 'Custom domain');
      if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(normalized)) {
        throw new BadRequestException('Enter a valid domain, e.g. shop.yourbrand.com');
      }
      const clash = await this.databaseService.repositories.storeModel.findOne({
        customDomain: normalized, _id: { $ne: storeId }, isDelete: false,
      }).lean();
      if (clash) throw new BadRequestException('This domain is already connected to another store');
    }

    // Any change to the domain string invalidates whatever verification
    // already existed — a seller changing the value must re-prove control
    // of the NEW domain before it can serve as a live storefront.
    if (normalized !== store.customDomain) store.customDomainStatus = 'unverified';
    store.customDomain = normalized;
    await store.save();

    this.activityLogService.log({
      storeId, category: 'settings', action: 'custom_domain_updated',
      description: normalized ? `Custom domain set to ${normalized}` : 'Custom domain removed',
      actorId: sellerId, actorRole: 'seller',
    });

    return {
      success: true, message: 'Custom domain updated',
      data: { customDomain: store.customDomain, customDomainStatus: store.customDomainStatus, cnameTarget: CUSTOM_DOMAIN_CNAME_TARGET },
    };
  }

  /**
   * Confirms the seller actually controls the domain they entered by
   * checking its real DNS — the domain's CNAME chain must resolve to
   * `CUSTOM_DOMAIN_CNAME_TARGET`. Only a 'verified' domain is ever matched
   * by the public `getPublicStoreByDomain` lookup, so an unproven domain
   * claim can never serve as a live storefront.
   *
   * **Deliberately out of scope here (real infra/ops work, not application
   * logic):** this method only checks DNS — it does NOT provision anything.
   * For a verified custom domain to actually SERVE the storefront over
   * HTTPS, the platform's edge/reverse-proxy (whatever that is in
   * production — a CDN's custom-hostname feature, an nginx/Caddy config
   * with on-demand TLS, etc.) must separately be configured to (a) accept
   * traffic for arbitrary incoming Host headers pointed at
   * `CUSTOM_DOMAIN_CNAME_TARGET`, and (b) obtain a TLS certificate for each
   * one (e.g. via ACME DNS-01/HTTP-01 automation). That step depends on
   * whichever hosting provider is actually used and isn't something this
   * application code can wire up blindly.
   */
  async verifyCustomDomain(sellerId: string, storeId: string) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');
    if (!store.customDomain) throw new BadRequestException('No custom domain is set for this store yet');

    let verified = false;
    let reason = '';
    try {
      const cnames = await dns.resolveCname(store.customDomain);
      verified = cnames.some(c => c.toLowerCase().replace(/\.$/, '') === CUSTOM_DOMAIN_CNAME_TARGET);
      if (!verified) reason = `Found a CNAME, but it doesn't point to ${CUSTOM_DOMAIN_CNAME_TARGET} yet.`;
    } catch {
      reason = `No CNAME record found for ${store.customDomain} yet — DNS changes can take a few minutes to a few hours to propagate.`;
    }

    store.customDomainStatus = verified ? 'verified' : 'unverified';
    await store.save();

    this.activityLogService.log({
      storeId, category: 'settings', action: 'custom_domain_verify_attempted',
      description: verified ? `Custom domain ${store.customDomain} verified` : `Custom domain verification failed: ${reason}`,
      actorId: sellerId, actorRole: 'seller',
    });

    return {
      success: true,
      data: { customDomainStatus: store.customDomainStatus, verified, reason: verified ? null : reason, cnameTarget: CUSTOM_DOMAIN_CNAME_TARGET },
    };
  }

  /** Platform-plan-gated: only stores on a plan with `whiteLabelAllowed` may hide Edudeen branding. */
  async setWhiteLabel(sellerId: string, storeId: string, enabled: boolean) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    if (enabled) {
      await this.entitlementsService.assertFeatureAllowed(storeId, 'whiteLabelAllowed', 'White-label branding');
    }

    store.whiteLabelEnabled = enabled;
    await store.save();

    return { success: true, message: 'White-label setting updated', data: { whiteLabelEnabled: store.whiteLabelEnabled } };
  }

  async updatePinnedProducts(sellerId: string, storeId: string, productIds: string[]) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    const limit = await this.adminConfigService.getPlacementLimit('storeFeaturedProducts');
    store.pinnedProductIds = productIds.slice(0, limit);
    await store.save();

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'pinned_products_updated',
      description: `Pinned products updated (${store.pinnedProductIds.length} product(s))`,
      actorId: sellerId, actorRole: 'seller',
    });

    return { success: true, message: 'Pinned products updated', data: { pinnedProductIds: store.pinnedProductIds } };
  }

  async updateAnnouncementBar(sellerId: string, storeId: string, body: any) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    store.announcementBar = {
      message: body.message ?? null,
      type: body.type ?? 'info',
      ctaLabel: body.ctaLabel ?? null,
      ctaLink: body.ctaLink ?? null,
      isActive: !!body.isActive,
      startAt: body.startAt ? new Date(body.startAt) : null,
      endAt: body.endAt ? new Date(body.endAt) : null,
    };
    await store.save();

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'announcement_bar_updated',
      description: store.announcementBar.isActive ? 'Store announcement bar activated' : 'Store announcement bar updated',
      actorId: sellerId, actorRole: 'seller',
    });

    return { success: true, message: 'Announcement bar updated', data: store.announcementBar };
  }

  // seller ke saare stores
  async getMyStores(sellerId: string) {
    const { storeModel, sellerModel, productModel, orderModel } =
      this.databaseService.repositories;

    const stores = await storeModel.find({ sellerId, isDelete: false }).lean();

    const seller = await sellerModel.findById(sellerId).select('name email').lean();

    // Products use string storeIds (created via `store._id.toString()`), and
    // sellerOrders.storeId is a string too — match with string ids.
    const storeIds = stores.map((s: any) => s._id.toString());

    // Per-store product counts — one grouped aggregation instead of N counts.
    const productCounts = storeIds.length
      ? await productModel.aggregate([
          { $match: { storeId: { $in: storeIds }, isDelete: false } },
          { $group: { _id: '$storeId', count: { $sum: 1 } } },
        ])
      : [];
    const productCountByStore = new Map<string, number>(
      productCounts.map((r: any) => [r._id, r.count]),
    );

    // Per-store all-time sales — same revenue formula the seller analytics
    // uses (non-cancelled sellerOrders, item totals minus item refunds).
    const salesRows = storeIds.length
      ? await orderModel.aggregate([
          { $match: { isDelete: false } },
          { $unwind: '$sellerOrders' },
          {
            $match: {
              'sellerOrders.storeId': { $in: storeIds },
              'sellerOrders.status': { $ne: 'cancelled' },
            },
          },
          {
            $project: {
              storeId: '$sellerOrders.storeId',
              gross: { $sum: '$sellerOrders.items.totalPrice' },
              refunds: { $sum: '$sellerOrders.items.refundedAmount' },
            },
          },
          {
            $group: {
              _id: '$storeId',
              gross: { $sum: '$gross' },
              refunds: { $sum: '$refunds' },
            },
          },
        ])
      : [];
    const round = (n: number) => Math.round(n * 100) / 100;
    const salesByStore = new Map<string, number>(
      salesRows.map((r: any) => [r._id, round((r.gross ?? 0) - (r.refunds ?? 0))]),
    );

    const data = stores.map((store: any) => {
      const id = store._id.toString();
      return {
        ...store,
        sellerName: seller?.name ?? null,
        sellerEmail: seller?.email ?? null,
        productCount: productCountByStore.get(id) ?? 0,
        totalSalesUSD: salesByStore.get(id) ?? 0,
      };
    });

    // Header strip on the "Your Stores" screen — totals across every store.
    const summary = {
      storeCount: data.length,
      totalProducts: data.reduce((sum, s: any) => sum + s.productCount, 0),
      totalRevenueUSD: round(data.reduce((sum, s: any) => sum + s.totalSalesUSD, 0)),
    };

    return {
      success: true,
      count: data.length,
      summary,
      data,
    };
  }

  // `requestingUserId` is only ever non-null via `OptionalJwtAuthGuard` — this
  // endpoint itself has no mandatory auth (POS pin-login and other
  // shared-device flows fetch a store before any seller session exists), so
  // the seller-only contact/stat fields below must stay opt-in and
  // ownership-checked rather than always included, or they'd leak a seller's
  // email/phone to anyone who knows a storeId.
  async getStoreById(storeId: string, requestingUserId?: string | null) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    });

    if (!store) throw new NotFoundException('Store not found');

    if (!requestingUserId || store.sellerId !== requestingUserId) {
      return { success: true, data: store };
    }

    const { sellerModel, productModel, orderModel } = this.databaseService.repositories;

    const [seller, productCount, orderAgg] = await Promise.all([
      sellerModel.findById(store.sellerId).select('name email phone').lean(),
      productModel.countDocuments({ storeId, isDelete: false }),
      orderModel.aggregate([
        { $match: { isDelete: false } },
        { $unwind: '$sellerOrders' },
        { $match: { 'sellerOrders.storeId': storeId, 'sellerOrders.status': { $ne: 'cancelled' } } },
        // Two-stage project-then-group — same convention as `getMyStores`'
        // `salesRows` aggregation: `$sum` on an array field (`items.totalPrice`)
        // only flattens/sums correctly as a `$project` expression, not as a
        // `$group` accumulator, so gross/refunds must be computed per-document
        // first and then accumulated across documents in a second stage.
        {
          $project: {
            gross: { $sum: '$sellerOrders.items.totalPrice' },
            refunds: { $sum: '$sellerOrders.items.refundedAmount' },
          },
        },
        {
          $group: {
            _id: null,
            orderCount: { $sum: 1 },
            gross: { $sum: '$gross' },
            refunds: { $sum: '$refunds' },
          },
        },
      ]),
    ]);

    const agg = orderAgg[0] as { orderCount?: number; gross?: number; refunds?: number } | undefined;
    const round = (n: number) => Math.round(n * 100) / 100;

    return {
      success: true,
      data: {
        ...store.toObject(),
        sellerName: seller?.name ?? null,
        sellerEmail: seller?.email ?? null,
        sellerPhone: seller?.phone ?? null,
        productCount,
        orderCount: agg?.orderCount ?? 0,
        totalSalesUSD: round((agg?.gross ?? 0) - (agg?.refunds ?? 0)),
      },
    };
  }

  // ✅ ab storeId se update hota hai (multiple stores ke liye zaroori)
  // `status` is deliberately never read from `body` here — it's a lifecycle
  // field (active/inactive/suspended) that only admin actions or future
  // recovery flows should be able to change. Accepting it from the request
  // body would let a seller un-suspend their own store (see
  // usersService.deleteSellerAccount, which suspends stores on delete).
  async updateStore(sellerId: string, storeId: string, body: any) {
    const { name, logo, coverImage, description, tagline, contactEmail, contactPhone, sellerType, productTypes, codEnabled } = body;

    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    });

    if (!store) throw new NotFoundException('Store not found');

    if (store.sellerId !== sellerId)
      throw new UnauthorizedException('You are not authorized to edit this store');

    if (sellerType && !Object.values(SellerType).includes(sellerType)) {
      throw new BadRequestException('Invalid sellerType');
    }

    if (productTypes && Array.isArray(productTypes)) {
      const validTypes = Object.values(ProductType);
      for (const pt of productTypes) {
        if (!validTypes.includes(pt)) {
          throw new BadRequestException(`Invalid productType: ${pt}`);
        }
      }
    }

    const updateData: any = {};

    // Store.slug is the seller's live subdomain/custom-domain identity
    // (hello.edudeen.com) — unlike a Product's slug, breaking it takes
    // down the seller's entire storefront, not just one shared link.
    // Deliberately NOT regenerated when the display name changes any more;
    // it's only ever assigned once, at store creation (see createStore
    // above). A silent regeneration here previously broke a seller's DNS
    // subdomain/custom domain the moment they edited their store name.
    if (name && name !== store.name) {
      updateData.name = name;
    }

    if (logo !== undefined) updateData.logo = logo;
    if (coverImage !== undefined) updateData.coverImage = coverImage;
    if (description !== undefined) updateData.description = description;
    if (tagline !== undefined) updateData.tagline = tagline;
    if (contactEmail !== undefined) updateData.contactEmail = contactEmail;
    if (contactPhone !== undefined) updateData.contactPhone = contactPhone;
    if (sellerType !== undefined) updateData.sellerType = sellerType;
    if (codEnabled !== undefined) updateData.codEnabled = !!codEnabled;

    // productTypes change ho to enabledTools bhi refresh
    if (productTypes !== undefined) {
      updateData.productTypes = productTypes;
      updateData.enabledTools = resolveTools(productTypes);
    }

    if (body.categoryId !== undefined) {
      if (body.categoryId) await this.assertValidRootCategory(body.categoryId);
      updateData.categoryId = body.categoryId;
    }

    const updated = await this.databaseService.repositories.storeModel.findByIdAndUpdate(
      store._id,
      updateData,
      { new: true },
    );

    return {
      success: true,
      message: 'Store updated successfully',
      data: updated,
    };
  }

  // ── 1. Save builder config ────────────────────────────────────────────────
  async saveBuilderConfig(sellerId: string, body: any) {
    const { storeId, builderConfig, coverImage } = body;

    if (!storeId) throw new BadRequestException('storeId is required');
    if (!builderConfig) throw new BadRequestException('builderConfig is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    const updateData: any = { builderConfig };
    if (coverImage !== undefined) updateData.coverImage = coverImage;

    const updated = await this.databaseService.repositories.storeModel.findByIdAndUpdate(
      storeId,
      updateData,
      { new: true },
    );

    return { success: true, message: 'Builder config saved', data: updated };
  }

  // ── 2. Get builder config ─────────────────────────────────────────────────
  async getBuilderConfig(sellerId: string, storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    }).lean();
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    return {
      success: true,
      data: {
        builderConfig: store.builderConfig ?? null,
        coverImage: store.coverImage ?? null,
        storeName: store.name,
        description: store.description,
      },
    };
  }

  // ── 3. Public store by slug ───────────────────────────────────────────────
  async getPublicStore(slug: string) {
    if (!slug) throw new BadRequestException('slug is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      slug,
      isDelete: false,
      status: 'active',
    }).lean();
    if (!store) throw new NotFoundException('Store not found');

    return this.shapePublicStoreResponse(store);
  }

  /** Same public shape as `getPublicStore`, resolved by a seller's VERIFIED
   *  custom domain instead of their `edudeen.com` subdomain slug — this is
   *  what lets a request arriving on an arbitrary hostname (once the
   *  platform's edge is actually routing it here — see `verifyCustomDomain`'s
   *  docblock) still load the right store. An unverified domain never
   *  matches, so merely claiming a domain string is never enough to serve
   *  as a live storefront. */
  async getPublicStoreByDomain(host: string) {
    if (!host) throw new BadRequestException('host is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      customDomain: host.trim().toLowerCase(),
      customDomainStatus: 'verified',
      isDelete: false,
      status: 'active',
    }).lean();
    if (!store) throw new NotFoundException('No store is connected to this domain');

    return this.shapePublicStoreResponse(store);
  }

  private async shapePublicStoreResponse(store: any) {
    const campaigns = await this.marketingService.getActiveCampaignsForStore(store._id.toString());
    const primaryCampaign = pickPrimaryCampaignForBadge(campaigns);

    const bar = store.announcementBar;
    const now = Date.now();
    const announcementActive = !!bar?.isActive
      && (!bar.startAt || new Date(bar.startAt).getTime() <= now)
      && (!bar.endAt || new Date(bar.endAt).getTime() >= now);

    return {
      success: true,
      data: {
        storeId: store._id,
        sellerId: store.sellerId,
        name: store.name,
        slug: store.slug,
        logo: store.logo,
        coverImage: store.coverImage ?? null,
        description: store.description,
        tagline: store.tagline ?? null,
        contactEmail: store.contactEmail ?? null,
        contactPhone: store.contactPhone ?? null,
        categoryId: store.categoryId ?? null,
        followersCount: store.followersCount ?? 0,
        averageRating: store.averageRating ?? 0,
        reviewCount: store.reviewCount ?? 0,
        builderConfig: store.builderConfig ?? null,
        // Every product in this storefront is priced in this same currency
        // (locked per store, stamped onto every variant at creation) — the
        // frontend uses this to convert every listed price into the
        // buyer's own chosen display currency.
        baseCurrency: store.baseCurrency ?? 'PKR',
        sellerType: store.sellerType ?? null,
        badges: store.badges ?? [],
        createdAt: store.createdAt,
        announcementBar: announcementActive ? { message: bar.message, type: bar.type, ctaLabel: bar.ctaLabel, ctaLink: bar.ctaLink } : null,
        activeCampaign: primaryCampaign ? {
          campaignId: primaryCampaign.campaignId,
          name: primaryCampaign.name,
          discountType: primaryCampaign.discountType,
          discountValue: primaryCampaign.discountValue,
          currency: primaryCampaign.currency,
          endDate: primaryCampaign.endDate,
        } : null,
      },
    };
  }

  private shapeStoreListItem(
    store: any,
    productCount: number | null = null,
    activeCampaign: ReturnType<typeof pickPrimaryCampaignForBadge> = null,
  ): any {
    return {
      storeId: store._id,
      name: store.name,
      slug: store.slug,
      logo: store.logo ?? null,
      coverImage: store.coverImage ?? null,
      description: store.description ?? null,
      categoryId: store.categoryId ?? null,
      followersCount: store.followersCount ?? 0,
      averageRating: store.averageRating ?? 0,
      reviewCount: store.reviewCount ?? 0,
      sellerType: store.sellerType ?? null,
      badges: store.badges ?? [],
      ...(productCount !== null ? { productCount } : {}),
      activeCampaign: activeCampaign ? {
        campaignId: activeCampaign.campaignId,
        name: activeCampaign.name,
        discountType: activeCampaign.discountType,
        discountValue: activeCampaign.discountValue,
        currency: activeCampaign.currency,
        endDate: activeCampaign.endDate,
      } : null,
    };
  }

  // ── 3b. Public stores — browse / search ───────────────────────────────────
  // Backs both the buyer "Stores" browse screen and `api/search/stores`
  // (SearchService.searchStores delegates straight into this).
  async listPublicStores(query: any) {
    const { storeModel, productModel } = this.databaseService.repositories;

    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(50, parseInt(query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter: any = { status: 'active', isDelete: false };
    if (query.categoryId && query.categoryId !== 'all') filter.categoryId = query.categoryId;

    const term = (query.q || '').trim();
    if (term) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.name = new RegExp(escaped, 'i');
    }

    const sortMap: Record<string, any> = {
      rating: { averageRating: -1, reviewCount: -1 },
      followers: { followersCount: -1 },
      newest: { createdAt: -1 },
    };
    const sort = sortMap[query.sort] ?? sortMap.followers;

    const total = await storeModel.countDocuments(filter);
    const stores = await storeModel.find(filter).sort(sort).skip(skip).limit(limit).lean();

    const storeIds = stores.map((s: any) => s._id.toString());
    const productCounts = storeIds.length
      ? await productModel.aggregate([
          { $match: { storeId: { $in: storeIds }, isDelete: false } },
          { $group: { _id: '$storeId', count: { $sum: 1 } } },
        ])
      : [];
    const productCountByStore = new Map<string, number>(productCounts.map((r: any) => [r._id, r.count]));
    const campaignsByStore = await this.marketingService.getActiveCampaignsForStores(storeIds);

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        stores: stores.map((s: any) =>
          this.shapeStoreListItem(
            s,
            productCountByStore.get(s._id.toString()) ?? 0,
            pickPrimaryCampaignForBadge(campaignsByStore.get(s._id.toString()) ?? []),
          ),
        ),
      },
    };
  }

  // ── 3c. Top stores — cached for the home-screen row ───────────────────────
  async getTopStores(limit: number) {
    const cacheKey = `top-stores:v2:${limit}`;
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      return { success: true, data: { stores: JSON.parse(cached) } };
    }

    const { storeModel, productModel } = this.databaseService.repositories;
    const stores = await storeModel
      .find({ status: 'active', isDelete: false })
      .sort({ averageRating: -1, followersCount: -1 })
      .limit(limit)
      .lean();

    const storeIds = stores.map((s: any) => s._id.toString());
    const productCounts = storeIds.length
      ? await productModel.aggregate([
          { $match: { storeId: { $in: storeIds }, isDelete: false } },
          { $group: { _id: '$storeId', count: { $sum: 1 } } },
        ])
      : [];
    const productCountByStore = new Map<string, number>(productCounts.map((r: any) => [r._id, r.count]));
    const campaignsByStore = await this.marketingService.getActiveCampaignsForStores(storeIds);

    const shaped = stores.map((s: any) =>
      this.shapeStoreListItem(
        s,
        productCountByStore.get(s._id.toString()) ?? 0,
        pickPrimaryCampaignForBadge(campaignsByStore.get(s._id.toString()) ?? []),
      ),
    );
    await this.redisService.set(cacheKey, JSON.stringify(shaped), 600);

    return { success: true, data: { stores: shaped } };
  }

  // ── 3d. Platform-wide stats — homepage stat strip (real numbers, cached) ──
  async getPlatformStats() {
    const cacheKey = 'platform-stats:v1';
    const cached = await this.redisService.get(cacheKey);
    if (cached) return { success: true, data: JSON.parse(cached) };

    const { sellerModel, storeModel, userModel, orderModel, ratingModel } = this.databaseService.repositories;

    const [storesCount, sellersCount, buyersCount, gmvAgg, ratingAgg] = await Promise.all([
      storeModel.countDocuments({ isDelete: false, status: 'active' }),
      sellerModel.countDocuments({ isDelete: false, status: 'active' }),
      userModel.countDocuments({ isDelete: false }),
      orderModel.aggregate([
        { $match: { isPaid: true } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),
      ratingModel.aggregate([
        { $match: { isDelete: false, rating: { $ne: null } } },
        { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
      ]),
    ]);

    const data = {
      storesCount,
      sellersCount,
      buyersCount,
      gmv: gmvAgg[0]?.total ?? 0,
      avgRating: ratingAgg[0]?.avg ?? 0,
      ratingCount: ratingAgg[0]?.count ?? 0,
    };

    await this.redisService.set(cacheKey, JSON.stringify(data), 600);
    return { success: true, data };
  }

  // ── 4. Public store products ──────────────────────────────────────────────
  async getPublicStoreProducts(storeId: string, query: any, customerId?: string | null) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
      status: 'active',
    }).lean();
    if (!store) throw new NotFoundException('Store not found');

    const page  = parseInt(query.page)  || 1;
    const limit = parseInt(query.limit) || 12;
    const skip  = (page - 1) * limit;

    const filter: any = { storeId, isDelete: false, status: 'active' };
    if (query.type && query.type !== 'all') filter.type = query.type;
    // `Product.categoryId` is the store's single fixed root category — every
    // product in a store shares the exact same value there, so filtering on
    // it within one store's own listing is meaningless (matches either
    // everything or nothing). The only real per-product distinction inside
    // one store is `subCategoryId` — this param is still named `categoryId`
    // everywhere it's set (section settings, nav links, this query string)
    // since a seller only ever picks from their store's subcategories, but
    // it must be matched against `subCategoryId` here to actually filter
    // anything (a real, previously-silent no-op bug, not a new behavior).
    if (query.categoryId && query.categoryId !== 'all') filter.subCategoryId = query.categoryId;
    if (query.tag && query.tag !== 'all') filter.tags = query.tag;
    if (query.search && String(query.search).trim()) {
      filter.name = { $regex: String(query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }
    // Collection membership — resolved via CollectionsService (manual: the
    // seller's own ordered pick; automatic: category/tag rule, evaluated
    // fresh) so this endpoint's existing variant/seller/campaign-pricing
    // shaping pipeline is reused as-is rather than duplicated inside the
    // collections module.
    if (query.collectionId && query.collectionId !== 'all') {
      const ids = await this.collectionsService.resolveProductIds(storeId, query.collectionId);
      filter._id = { $in: ids.length ? ids : ['__none__'] };
    }
    // Same real "on sale" definition the product card's own discount badge
    // already uses (compareAtPrice > price). compareAtPrice/price live on
    // ProductVariant, not Product, so this resolves the matching product ids
    // up front (before pagination) rather than post-filtering the page —
    // otherwise `total`/skip/limit would silently disagree with what's
    // actually returned.
    if (query.onSale === true || query.onSale === 'true') {
      const storeProductIds = (
        await this.databaseService.repositories.productModel.find({ storeId, isDelete: false, status: 'active' }).select('_id').lean()
      ).map((p: any) => p._id.toString());
      const onSaleVariants = await this.databaseService.repositories.productVariantModel
        .find({ productId: { $in: storeProductIds }, status: 'active', isDelete: false, $expr: { $gt: ['$compareAtPrice', '$price'] } })
        .select('productId')
        .lean();
      const onSaleIds = [...new Set(onSaleVariants.map((v: any) => v.productId))];
      const already: string[] | undefined = filter._id?.$in;
      filter._id = { $in: already ? already.filter((id: string) => onSaleIds.includes(id)) : (onSaleIds.length ? onSaleIds : ['__none__']) };
    }

    const sortMap: Record<string, any> = {
      newest:     { createdAt: -1 },
      price_asc:  { 'variants.price': 1 },
      price_desc: { 'variants.price': -1 },
      best_rated: { averageRating: -1 },
      default:    { createdAt: -1 },
    };
    const sort = sortMap[query.sort] ?? sortMap['default'];

    const total    = await this.databaseService.repositories.productModel.countDocuments(filter);
    const products = await this.databaseService.repositories.productModel
      .find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean();

    // Cheapest active variant per product — powers the card price and, when
    // the buyer has an active subscription to this store, the member price.
    const productIds = products.map((p: any) => p._id.toString());
    const variants = await this.databaseService.repositories.productVariantModel.find({
      productId: { $in: productIds }, status: 'active', isDelete: false,
    }).sort({ price: 1 }).lean();
    const cheapestByProduct = new Map<string, any>();
    // Every active variant per product — the shared `variants[]` shape every
    // other listing endpoint returns (getProductsByCategoryId, search,
    // getShapedProductsByIds). `ProductModel`/`ProductCard` on the app side
    // derive price/currency/discount from THIS array, not from the flat
    // `defaultVariantPrice`/`compareAtPrice` fields below — omitting it here
    // silently rendered every storefront product card as "PKR 0".
    const variantsByProduct = new Map<string, any[]>();
    for (const v of variants) {
      if (!cheapestByProduct.has(v.productId)) cheapestByProduct.set(v.productId, v);
      if (!variantsByProduct.has(v.productId)) variantsByProduct.set(v.productId, []);
      variantsByProduct.get(v.productId)!.push(v);
    }

    // Every product on this page belongs to the same store/seller — one
    // lookup, not per-product. Same `sellerName`/`sellerVerified` fields the
    // generic `ProductCard` (app) reads on every other listing endpoint.
    const seller = await this.databaseService.repositories.sellerModel
      .findById(store.sellerId)
      .select('name isVerified')
      .lean();

    const benefits = await this.subscriptionBenefits.getActiveBenefits(customerId, storeId);

    // Every product on this page belongs to the same store, so this is one
    // lookup for the whole page, not per-product — same active-campaign
    // resolution checkout pricing uses.
    const storeCampaigns = await this.marketingService.getActiveCampaignsForStore(storeId);
    const primaryCampaign = pickPrimaryCampaignForBadge(storeCampaigns);
    const activeCampaignBadge = primaryCampaign ? {
      campaignId: primaryCampaign.campaignId,
      name: primaryCampaign.name,
      discountType: primaryCampaign.discountType,
      discountValue: primaryCampaign.discountValue,
      currency: primaryCampaign.currency,
      endDate: primaryCampaign.endDate,
    } : null;

    const enrichedProducts = products.map((p: any) => {
      const variant = cheapestByProduct.get(p._id.toString());
      const base: any = {
        ...p,
        variants:            variantsByProduct.get(p._id.toString()) ?? [],
        sellerName:          seller ? seller.name : null,
        sellerVerified:      seller ? !!seller.isVerified : false,
        defaultVariantPrice: variant?.price ?? null,
        variantId:           variant?._id ?? null,
        stock:               variant?.stock ?? null,
        compareAtPrice:      variant?.compareAtPrice ?? null,
        activeCampaign:      activeCampaignBadge,
      };
      if (variant && benefits) {
        const discount = this.subscriptionBenefits.resolveProductDiscount(benefits.benefits, p, variant.price);
        if (discount) {
          base.subscriberPrice = discount.subscriberPrice;
          base.youSaveUSD = discount.savingsUSD;
          base.discountPercent = discount.discountPercent;
          base.subscriberPlanName = benefits.planName;
        }
      }
      return base;
    });

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        products: enrichedProducts,
      },
    };
  }

  // ── 5. Public store filters (tags) ───────────────────────────────────────
  async getPublicStoreFilters(storeId: string) {
    // Same 600s Redis TTL convention as getTopStores/getPlatformStats — a
    // store's tag/category facets change only as often as products are
    // added/edited, so a request-per-page-view cost here is pure waste.
    const cacheKey = `store-filters:v1:${storeId}`;
    const cached = await this.redisService.get(cacheKey);
    if (cached) return { success: true, data: JSON.parse(cached) };

    const { productModel, categoryModel } = this.databaseService.repositories;
    const tags: string[] = await productModel.distinct('tags', {
      storeId,
      isDelete: false,
      status: 'active',
    });

    // Which subcategories this store's own active catalog actually uses —
    // powers both `featured_category_grid` and a "shop by category" facet
    // on the new /category browse route (Store Builder plan, Phase 11).
    // Deliberately NOT admin-root categories (a store only ever belongs to
    // one root — see assertValidRootCategory — so faceting by root would
    // always return exactly one, useless, entry).
    const categoryAgg = await productModel.aggregate([
      { $match: { storeId, isDelete: false, status: 'active', subCategoryId: { $ne: null } } },
      { $group: { _id: '$subCategoryId', count: { $sum: 1 } } },
    ]);
    const categoryIds = categoryAgg.map((c) => c._id).filter(Boolean);
    const categories = categoryIds.length
      ? await categoryModel.find({ _id: { $in: categoryIds }, isDelete: false }).select('name slug').lean()
      : [];
    const countById = new Map(categoryAgg.map((c) => [c._id, c.count]));
    const categoryFacets = categories
      .map((c: any) => ({ id: String(c._id), name: c.name, slug: c.slug, count: countById.get(String(c._id)) ?? 0 }))
      .sort((a, b) => b.count - a.count);

    const data = { tags: tags.filter(Boolean).sort(), categories: categoryFacets };
    await this.redisService.set(cacheKey, JSON.stringify(data), 600);
    return { success: true, data };
  }

  // ── 6. Follow / Unfollow store ────────────────────────────────────────────
  async followStore(userId: string, storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    });
    if (!store) throw new NotFoundException('Store not found');

    const existing = await this.databaseService.repositories.storeFollowerModel.findOne({
      userId,
      storeId,
    });

    if (existing) {
      await this.databaseService.repositories.storeFollowerModel.deleteOne({ userId, storeId });
      await this.databaseService.repositories.storeModel.findByIdAndUpdate(storeId, {
        $inc: { followersCount: -1 },
      });
      return { success: true, message: 'Unfollowed', data: { following: false } };
    }

    await this.databaseService.repositories.storeFollowerModel.create({ userId, storeId });
    await this.databaseService.repositories.storeModel.findByIdAndUpdate(storeId, {
      $inc: { followersCount: 1 },
    });

    this.notificationsService.notify({
      recipientId: store.sellerId,
      recipientRole: 'seller',
      type: NOTIFICATION_TYPES.NEW_FOLLOWER,
      title: 'New follower',
      body: `Someone just started following ${store.name}.`,
      data: { storeId },
    }).catch(() => {});

    return { success: true, message: 'Following', data: { following: true } };
  }

  // ── 7. Get store followers (seller only) ─────────────────────────────────
  async getStoreFollowers(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    }).lean();
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    const page  = parseInt(query.page)  || 1;
    const limit = parseInt(query.limit) || 20;
    const skip  = (page - 1) * limit;

    const total = await this.databaseService.repositories.storeFollowerModel
      .countDocuments({ storeId });

    const followers = await this.databaseService.repositories.storeFollowerModel
      .find({ storeId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const userIds = followers.map((f) => f.userId);
    const users = await this.databaseService.repositories.userModel
      .find({ _id: { $in: userIds } })
      .select('name email profileImage')
      .lean();

    const userMap: Record<string, any> = {};
    users.forEach((u: any) => { userMap[u._id.toString()] = u; });

    const data = followers.map((f) => ({
      followedAt: (f as any).createdAt,
      user: userMap[f.userId] ?? { _id: f.userId, name: 'Unknown' },
    }));

    return {
      success: true,
      data: {
        total,
        pagination: { page, limit, totalPages: Math.ceil(total / limit) },
        followers: data,
      },
    };
  }

  // ── 6. Get follow status ──────────────────────────────────────────────────
  async getFollowStatus(userId: string, storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const existing = await this.databaseService.repositories.storeFollowerModel.findOne({
      userId,
      storeId,
    }).lean();

    return {
      success: true,
      data: { following: !!existing },
    };
  }

  // ── 7. Store customers (staff-facing: only people who have ordered from this store) ────

  async getStoreCustomers(sellerId: string, storeId: string, query: any) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('You are not authorized to view this store\'s customers');

    const { orderModel, userModel } = this.databaseService.repositories;

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const skip = (page - 1) * limit;

    const customerIds = await orderModel.distinct('userId', { 'sellerOrders.storeId': storeId, isDelete: false });
    const total = customerIds.length;

    const matchStage = { $match: { userId: { $in: customerIds }, isDelete: false, 'sellerOrders.storeId': storeId } };
    const unwindStages = [
      matchStage,
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': storeId } },
    ];

    const [stats, [totals]] = await Promise.all([
      orderModel.aggregate([
        ...unwindStages,
        {
          $group: {
            _id: '$userId',
            orderCount: { $sum: 1 },
            totalSpent: { $sum: '$sellerOrders.subtotal' },
            lastOrderAt: { $max: '$createdAt' },
          },
        },
        { $sort: { lastOrderAt: -1 } },
        { $skip: skip },
        { $limit: limit },
      ]),
      orderModel.aggregate([
        ...unwindStages,
        { $group: { _id: null, totalOrders: { $sum: 1 }, totalRevenue: { $sum: '$sellerOrders.subtotal' } } },
      ]),
    ]);

    const pageIds = stats.map((s) => s._id);
    const users = await userModel.find({ _id: { $in: pageIds } }).select('name email phone createdAt').lean() as unknown as
      { _id: unknown; name: string; email: string; phone: string; createdAt: Date }[];
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const customers = stats.map((s) => {
      const u = userMap.get(String(s._id));
      return {
        _id: s._id,
        name: u?.name ?? 'Unknown',
        email: u?.email ?? '',
        phone: u?.phone ?? '',
        createdAt: u?.createdAt ?? null,
        orderCount: s.orderCount,
        totalSpent: s.totalSpent,
        lastOrderAt: s.lastOrderAt,
      };
    });

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        summary: { totalOrders: totals?.totalOrders ?? 0, totalRevenue: totals?.totalRevenue ?? 0 },
        customers,
      },
    };
  }

  async updateStoreCustomer(
    sellerId: string,
    storeId: string,
    customerId: string,
    dto: UpdateStoreCustomerDto,
    ip?: string,
    userAgent?: string,
  ) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('You are not authorized to edit this store\'s customers');

    const { orderModel, userModel } = this.databaseService.repositories;

    const hasOrderedHere = await orderModel.exists({ userId: customerId, 'sellerOrders.storeId': storeId, isDelete: false });
    if (!hasOrderedHere) throw new BadRequestException('This customer has no orders with your store');

    const update: any = {};
    if (dto.name !== undefined) update.name = dto.name;
    if (dto.phone !== undefined) update.phone = dto.phone;
    if (dto.email !== undefined) {
      update.email = dto.email;
      update.isVerified = false; // new email hasn't gone through OTP yet
    }

    if (Object.keys(update).length === 0) throw new BadRequestException('Nothing to update');

    const customer = await userModel
      .findByIdAndUpdate(customerId, update, { new: true, runValidators: true })
      .select('-password -otp -otpExpiresAt');

    if (!customer) throw new NotFoundException('Customer not found');

    this.activityLogService.log({
      storeId,
      category: 'customers',
      action: 'customer_profile_updated',
      description: `${(customer as any).name} — updated ${Object.keys(update).filter((k) => k !== 'isVerified').join(', ')}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: customerId,
      targetType: 'customer',
      ip,
      userAgent,
    });

    return { success: true, message: 'Customer updated', data: customer };
  }
}