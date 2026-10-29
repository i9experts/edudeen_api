/* eslint-disable prettier/prettier */
import { courseTotals } from '../classroom/course.util';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { escapeRegex } from '../common/query-safety.util';
import { isStoreLive } from '../common/store-live.util';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { UploadService } from '../upload/upload.service';
import { StoreService } from '../store/store.service';
import { isQualityStore } from '../store/featured-stores.util';
import { RedisService } from '../redis/redis.service';
import { MarketplaceListingQueryDto } from './dto/marketplace-listing-query.dto';
import { LeadsQueryDto } from './dto/leads-query.dto';
import { mergeTrustBadges } from '../products/trust-badges.util';
import { buildEditDiff } from '../products/product-edit-review.util';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AdminMarketplaceService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly notificationsService: NotificationsService,
    private readonly uploadService: UploadService,
    private readonly storeService: StoreService,
    private readonly redis: RedisService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private log(action: string, description: string, meta: AuditMeta, targetId?: string, targetType: 'product' | 'store' = 'product') {
    this.activityLogService.log({
      storeId: 'platform',
      category: 'products',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      targetId,
      targetType,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async getStats() {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [total, active, flagged, gmvRows] = await Promise.all([
      this.r.productModel.countDocuments({ isDelete: false }),
      this.r.productModel.countDocuments({ isDelete: false, status: 'active' }),
      this.r.reportModel.countDocuments({ targetType: 'listing', status: { $ne: 'resolved' } }),
      this.r.orderModel.aggregate([
        // Paid and not refunded; grouped per currency - PKR and USD totals are never added together.
        { $match: { isPaid: true, paymentStatus: { $ne: 'refunded' }, status: { $nin: ['refunded', 'cancelled'] }, createdAt: { $gte: startOfMonth } } },
        { $group: { _id: { $ifNull: ['$currency', 'USD'] }, gmv: { $sum: '$totalAmount' } } },
      ]),
    ]);

    return {
      success: true,
      data: {
        totalListings: total,
        active,
        flagged,
        // gmvThisMonth = USD orders only (kept for older clients); every currency is in gmvByCurrency.
        gmvThisMonth: gmvRows.find((r: any) => r._id === 'USD')?.gmv ?? 0,
        gmvByCurrency: gmvRows.map((r: any) => ({ currency: r._id as string, gmv: Math.round((r.gmv ?? 0) * 100) / 100 })),
      },
    };
  }

  async getListings(query: MarketplaceListingQueryDto) {
    const filter: Record<string, unknown> = { isDelete: false };

    if (query.categoryId) filter.categoryId = query.categoryId;
    if (query.search) filter.name = { $regex: escapeRegex(query.search), $options: 'i' };

    let flaggedProductIds: string[] | null = null;
    if (query.status === 'flagged') {
      const reports = await this.r.reportModel.find({ targetType: 'listing', status: { $ne: 'resolved' } }, { targetId: 1 });
      flaggedProductIds = reports.map((r) => r.targetId).filter((id) => isValidObjectId(id));
      filter._id = { $in: flaggedProductIds };
    } else if (query.status === 'pending_review') {
      // New listings AND seller edits to live listings both wait in the review queue.
      filter.$or = [{ status: 'pending_review' }, { 'pendingEdit.submittedAt': { $type: 'date' } }];
    } else if (query.status) {
      filter.status = query.status;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [products, total] = await Promise.all([
      this.r.productModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      this.r.productModel.countDocuments(filter),
    ]);

    const productIds = products.map((p) => String(p._id));
    const sellerIds = [...new Set(products.map((p) => p.sellerId))];
    const storeIds = [...new Set(products.map((p) => p.storeId).filter(Boolean))];
    const [sellers, stores, openReports, priceRows] = await Promise.all([
      this.r.sellerModel.find({ _id: { $in: sellerIds } }, { name: 1 }),
      this.r.storeModel.find({ _id: { $in: storeIds } }, { badges: 1, fulfillmentMode: 1 }),
      this.r.reportModel.find(
        { targetType: 'listing', status: { $ne: 'resolved' }, targetId: { $in: productIds } },
        { targetId: 1 },
      ),
      this.r.productVariantModel.aggregate([
        // The price the seller set = the DEFAULT variant (not the minimum over every variant, which also picked up
        // deleted variants and license-tier variants and could show 0).
        { $match: { productId: { $in: productIds }, isDelete: { $ne: true } } },
        { $sort: { isDefault: -1, price: 1 } },
        { $group: { _id: '$productId', minPrice: { $first: '$price' }, currency: { $first: '$currency' } } },
      ]),
    ]);
    const sellerNameById = new Map(sellers.map((s) => [String(s._id), s.name]));
    const badgesByStoreId = new Map(stores.map((s) => [String(s._id), s.badges ?? []]));
    const fulfillmentByStoreId = new Map(stores.map((s: any) => [String(s._id), s.fulfillmentMode ?? 'seller']));
    const flaggedIdSet = new Set(openReports.map((r) => r.targetId));
    const priceByProductId = new Map(priceRows.map((row) => [row._id, row.minPrice]));
    const currencyByProductId = new Map(priceRows.map((row) => [row._id, row.currency ?? 'PKR']));

    const items = products.map((p) => ({
      id: p._id,
      title: p.name,
      sellerId: p.sellerId,
      sellerName: sellerNameById.get(p.sellerId) ?? 'Unknown',
      storeId: p.storeId,
      storeBadges: badgesByStoreId.get(p.storeId) ?? [],
      storeFulfillmentMode: fulfillmentByStoreId.get(p.storeId) ?? 'seller',
      categoryId: p.categoryId,
      price: priceByProductId.get(String(p._id)) ?? null,
      currency: currencyByProductId.get(String(p._id)) ?? 'PKR',
      purchaseCount: p.purchaseCount,
      status: flaggedIdSet.has(String(p._id)) ? 'flagged' : p.status,
      isFeatured: p.isFeatured,
      isTest: (p as any).isTest === true,
      // Server review flags (e.g. 'contact_info') + the matched text, shown as a badge in the review queue.
      flags: (p as any).flags ?? [],
      contactMatches: (p as any).contactMatches ?? [],
      reviewNote: (p as any).reviewNote ?? null,
      hasPendingEdit: !!(p as any).pendingEdit?.submittedAt,
      createdAt: (p as any).createdAt,
    }));

    return { success: true, data: { items, total, page, limit } };
  }

  private async findProductOrThrow(id: string) {
    const product = await this.r.productModel.findOne({ _id: id, isDelete: false });
    if (!product) throw new NotFoundException('Listing not found');
    return product;
  }

  async setFeatured(id: string, isFeatured: boolean, meta: AuditMeta) {
    const product = await this.findProductOrThrow(id);
    // Only a listing buyers can actually see may be featured — featuring a draft / inactive / off-market listing
    // put it into featured rails. Unfeaturing is always allowed.
    if (isFeatured && (product as any).isTest === true) throw new BadRequestException('A test listing cannot be featured - unmark it as a test first');
    if (isFeatured && (product.status !== 'active' || !(await isStoreLive(this.r.storeModel, product.storeId)))) {
      throw new BadRequestException('Only active listings from a live store can be featured');
    }
    await this.r.productModel.findByIdAndUpdate(id, { $set: { isFeatured } });
    this.log(
      isFeatured ? 'listing_featured' : 'listing_unfeatured',
      `Listing "${product.name}" ${isFeatured ? 'featured' : 'unfeatured'}`,
      meta,
      id,
    );
    return { success: true, message: isFeatured ? 'Listing featured' : 'Listing unfeatured' };
  }

  /** QA flag: a test listing is hidden from every public query (browse, search, rails, sitemap...). Marking it also drops the featured flag. */
  async setTest(id: string, isTest: boolean, meta: AuditMeta) {
    const product = await this.findProductOrThrow(id);
    await this.r.productModel.findByIdAndUpdate(id, { $set: isTest ? { isTest: true, isFeatured: false } : { isTest: false } });
    this.log(isTest ? 'listing_marked_test' : 'listing_unmarked_test', `Listing "${product.name}" ${isTest ? 'marked as test (hidden from the public)' : 'unmarked as test'}`, meta, id);
    return { success: true, message: isTest ? 'Marked as test - hidden from the public' : 'Test mark removed' };
  }

  /** Sets the admin trust badges (scholar reviewed, age-appropriate range) on a listing. Omitted fields are kept. */
  async setTrustBadges(id: string, input: { scholarReviewed?: boolean; ageAppropriateMin?: number | null; ageAppropriateMax?: number | null }, meta: AuditMeta) {
    const product: any = await this.findProductOrThrow(id);
    let next;
    try {
      next = mergeTrustBadges(product.trust, input);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Invalid trust badges');
    }
    await this.r.productModel.findByIdAndUpdate(id, { $set: { trust: { ...next, reviewedAt: new Date(), reviewedBy: meta.adminId } } });
    this.log('listing_trust_updated', `Trust badges on "${product.name}" updated (scholar reviewed: ${next.scholarReviewed}, ages: ${next.ageAppropriateMin ?? '-'}-${next.ageAppropriateMax ?? '-'})`, meta, id);
    return { success: true, message: 'Trust badges updated', data: next };
  }

  async remove(id: string, meta: AuditMeta, reason?: string) {
    const why = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    if (why.length < 3) throw new BadRequestException('A reason is required to remove a listing');
    const product = await this.findProductOrThrow(id);
    // Also drops the featured flag, or a removed listing kept its slot in featured rails.
    await this.r.productModel.findByIdAndUpdate(id, { $set: { isDelete: true, status: 'inactive', isFeatured: false, removedByAdmin: true, removalReason: why } });
    // A removed listing must not linger where buyers still hold it: pull it out of every cart and wishlist.
    const [carts, wishes] = await Promise.all([
      this.r.cartModel.updateMany({ 'items.productId': id }, { $pull: { items: { productId: id } } }),
      this.r.wishListModel.deleteMany({ productId: id }),
    ]);
    this.log('listing_removed', `Listing "${product.name}" removed by admin: ${why} (${carts.modifiedCount} cart(s), ${wishes.deletedCount} wishlist entr(ies) cleaned)`, meta, id);
    this.notifySeller(product, NOTIFICATION_TYPES.LISTING_REJECTED, `Your listing "${product.name}" was removed`, `Reason: ${why}`);
    return { success: true, message: 'Listing removed' };
  }

  // ── Listing review ────────────────────────────────────────────────────────
  // A seller's first publish waits as 'pending_review' (see
  // resolveSellerPublishStatus) until an admin approves or rejects it here.

  async getReviewCount() {
    const pending = await this.r.productModel.countDocuments({
      isDelete: false,
      $or: [{ status: 'pending_review' }, { 'pendingEdit.submittedAt': { $type: 'date' } }],
    });
    return { success: true, data: { pending } };
  }

  /** Everything a reviewer needs on one screen, including short-lived links to the actual files. */
  async getListingForReview(id: string) {
    const product: any = await this.r.productModel.findOne({ _id: id, isDelete: false }).lean();
    if (!product) throw new NotFoundException('Listing not found');
    const [variants, seller, store, category, subCategory] = await Promise.all([
      this.r.productVariantModel.find({ productId: String(product._id), isDelete: false }).lean(),
      this.r.sellerModel.findById(product.sellerId).select('name email').lean(),
      product.storeId ? this.r.storeModel.findById(product.storeId).select('name slug status badges').lean() : null,
      product.categoryId ? this.r.categoryModel.findById(product.categoryId).select('name').lean() : null,
      product.subCategoryId ? this.r.categoryModel.findById(product.subCategoryId).select('name').lean() : null,
    ]);
    const ch = product.pendingEdit?.changes ?? {};
    const [editCat, editSub]: any[] = await Promise.all([
      ch.categoryId ? this.r.categoryModel.findById(ch.categoryId).select('name').lean() : null,
      ch.subCategoryId ? this.r.categoryModel.findById(ch.subCategoryId).select('name').lean() : null,
    ]);
    // Course reviewers see what is actually being sold: curriculum outline (never lesson files), outcomes, instructor.
    const courseDoc: any = product.deliveryFormat === 'course' ? await (this.r as any).courseModel.findOne({ productId: String(product._id) }).lean() : null;
    const course = product.deliveryFormat === 'course'
      ? {
          ...courseTotals(courseDoc?.sections),
          sections: (courseDoc?.sections ?? []).map((s: any) => ({ title: s.title, lessons: (s.lessons ?? []).map((l: any) => ({ title: l.title, type: l.type, minutes: l.durationMinutes ?? null, isPreview: !!l.isPreview })) })),
          outcomes: courseDoc?.outcomes ?? [],
          instructor: courseDoc?.instructor ?? { name: '', bio: '' },
          accessDays: courseDoc?.accessDays ?? null,
          certificateEnabled: courseDoc?.certificateEnabled ?? false,
        }
      : null;
    const editCategory: string | undefined = editCat?.name;
    const editSubCategory: string | undefined = editSub?.name;
    const files = (product.digital?.files ?? []).map((f: any) => {
      const mime = this.uploadService.resolveMimeType(f.name ?? '', f.mimeType ?? 'application/octet-stream');
      const resourceType = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : 'raw';
      return { name: f.name, size: f.size, mimeType: mime, viewUrl: this.uploadService.generateSignedUrl(f.url, resourceType, 600, f.name, true) };
    });
    return {
      success: true,
      data: {
        id: product._id,
        name: product.name,
        slug: product.slug,
        description: product.description,
        images: product.images ?? [],
        tags: product.tags ?? [],
        type: product.type,
        productType: product.productType,
        deliveryFormat: product.deliveryFormat ?? 'download',
        liveSession: product.deliveryFormat === 'live_class' ? (product.liveSession ?? null) : null,
        course,
        educationLevel: product.educationLevel,
        customLevel: product.customLevel,
        classFrom: product.classFrom ?? null,
        classTo: product.classTo ?? null,
        status: product.status,
        scheduledAt: product.scheduledAt,
        reviewNote: product.reviewNote ?? null,
        flags: product.flags ?? [],
        contactMatches: product.contactMatches ?? [],
        flagReason: product.flagReason ?? null,
        ageMin: product.ageMin ?? null,
        ageMax: product.ageMax ?? null,
        trust: product.trust ?? null,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        category: (category as any)?.name ?? null,
        subCategory: (subCategory as any)?.name ?? null,
        seller: seller ? { id: String((seller as any)._id), name: (seller as any).name, email: (seller as any).email } : null,
        store: store ? { id: String((store as any)._id), name: (store as any).name, slug: (store as any).slug, status: (store as any).status, badges: (store as any).badges ?? [] } : null,
        // Seller edit waiting for approval: before/after rows (the fields above are still the LIVE version).
        pendingEdit: product.pendingEdit?.changes ? { submittedAt: product.pendingEdit.submittedAt, diff: buildEditDiff(product, product.pendingEdit.changes, { category: editCategory, subCategory: editSubCategory, variant: (variants as any[]).find((v) => v.isDefault) ?? (variants as any[])[0] ?? null, variants: variants as any[] }) } : null,
        variants: variants.map((v: any) => ({ id: String(v._id), price: v.price, compareAtPrice: v.compareAtPrice ?? null, currency: v.currency ?? 'PKR', options: v.options ?? [], stock: v.stock, isDefault: !!v.isDefault })),
        digital: product.digital ? {
          licenseType: product.digital.licenseType, downloadLimit: product.digital.downloadLimit,
          pdfStampingEnabled: !!product.digital.pdfStampingEnabled, files,
        } : null,
      },
    };
  }

  private notifySeller(product: any, type: string, title: string, body: string) {
    if (!product?.sellerId) return;
    void this.notificationsService.notify({
      recipientId: String(product.sellerId),
      recipientRole: 'seller',
      type,
      title,
      body,
      data: { productId: String(product._id), storeId: product.storeId, link: product.storeId ? `/store/${product.storeId}/products` : undefined },
    });
  }

  async approveListing(id: string, note: string | undefined, meta: AuditMeta) {
    const now = new Date();
    const current = await this.findProductOrThrow(id);
    // A suspended / rejected / closed store cannot get listings published: approving would make them live on a store buyers can't reach.
    if (!(await isStoreLive(this.r.storeModel, (current as any).storeId))) {
      throw new ConflictException('This listing belongs to a store that is not active (suspended or closed) - it cannot be approved');
    }
    // A seller's edit to a live listing: publish the held changes, status stays as it is.
    const pending = (current as any).pendingEdit as { changes?: Record<string, unknown>; submittedAt?: Date } | null;
    if (pending?.changes && pending.submittedAt) {
      const { __price, __compareAtPrice, __variants, ...contentChanges } = pending.changes as Record<string, unknown>;
      const edited = await this.r.productModel.findOneAndUpdate(
        { _id: id, isDelete: false, 'pendingEdit.submittedAt': pending.submittedAt },
        { $set: { ...contentChanges, pendingEdit: null, lastEditRejection: null, reviewedAt: now, reviewNote: note?.trim() || null, flags: [], contactMatches: [], flagReason: null } },
        { returnDocument: 'after' },
      );
      if (!edited) throw new ConflictException('Someone else just reviewed this listing — refresh the queue');
      if (__price !== undefined || __compareAtPrice !== undefined) {
        await this.r.productVariantModel.findOneAndUpdate(
          { productId: id, isDefault: true, isDelete: false },
          { $set: { ...(__price !== undefined ? { price: __price } : {}), ...(__compareAtPrice !== undefined ? { compareAtPrice: __compareAtPrice } : {}) } },
        );
      }
      for (const [vid, ch] of Object.entries((__variants ?? {}) as Record<string, { price?: number; compareAtPrice?: number | null }>)) {
        await this.r.productVariantModel.findOneAndUpdate(
          { _id: vid, productId: id, isDelete: false },
          { $set: { ...(ch.price !== undefined ? { price: ch.price } : {}), ...('compareAtPrice' in ch ? { compareAtPrice: ch.compareAtPrice } : {}) } },
        );
      }
      this.log('listing_edit_approved', `Edit of listing "${edited.name}" approved and published`, meta, id);
      this.notifySeller(edited, NOTIFICATION_TYPES.LISTING_APPROVED, `Changes to "${edited.name}" are live`, 'Your edit was approved and is now visible on Edudeen.');
      return { success: true, message: 'Changes approved — now live', data: { status: edited.status } };
    }
    if (current.status !== 'pending_review' && current.status !== 'rejected') {
      throw new ConflictException('This listing is not waiting for review');
    }
    // A listing the seller scheduled for later keeps that date.
    const nextStatus = current.scheduledAt && new Date(current.scheduledAt) > now ? 'scheduled' : 'active';
    // Claimed atomically, so two reviewers can't both act on it.
    const product = await this.r.productModel.findOneAndUpdate(
      { _id: id, isDelete: false, status: current.status },
      { $set: { status: nextStatus, approvedAt: now, reviewedAt: now, reviewNote: note?.trim() || null, flags: [], contactMatches: [], flagReason: null } },
      { returnDocument: 'after' },
    );
    if (!product) throw new ConflictException('Someone else just reviewed this listing — refresh the queue');
    this.log('listing_approved', `Listing "${product.name}" approved`, meta, id);
    this.notifySeller(product, NOTIFICATION_TYPES.LISTING_APPROVED,
      `"${product.name}" is approved`,
      nextStatus === 'scheduled' ? 'It will go live on the date you scheduled.' : 'It is now live on Edudeen.');
    return { success: true, message: nextStatus === 'scheduled' ? 'Approved — goes live on its scheduled date' : 'Approved — now live', data: { status: nextStatus } };
  }

  async rejectListing(id: string, reason: string, meta: AuditMeta) {
    const now = new Date();
    // A seller's edit to a live listing: drop it, the listing keeps its previous (approved) content.
    const held: any = await this.r.productModel.findOne({ _id: id, isDelete: false }).select('pendingEdit').lean();
    if (held?.pendingEdit?.submittedAt) {
      const kept = await this.r.productModel.findOneAndUpdate(
        { _id: id, isDelete: false, 'pendingEdit.submittedAt': held.pendingEdit.submittedAt },
        { $set: { pendingEdit: null, lastEditRejection: { reason: reason.trim(), at: now }, reviewedAt: now } },
        { returnDocument: 'after' },
      );
      if (!kept) throw new ConflictException('Someone else just reviewed this listing — refresh the queue');
      this.log('listing_edit_rejected', `Edit of listing "${kept.name}" declined: ${reason.trim()}`, meta, id);
      this.notifySeller(kept, NOTIFICATION_TYPES.LISTING_REJECTED,
        `Changes to "${kept.name}" were not approved`,
        `${reason.trim()} Your listing stays live with its previous content. Edit it again to resubmit.`);
      return { success: true, message: 'Changes declined — the live listing is unchanged', data: { status: kept.status } };
    }
    const product = await this.r.productModel.findOneAndUpdate(
      { _id: id, isDelete: false, status: 'pending_review' },
      { $set: { status: 'rejected', reviewedAt: now, reviewNote: reason.trim(), isFeatured: false } },
      { returnDocument: 'after' },
    );
    if (!product) {
      await this.findProductOrThrow(id);
      throw new ConflictException('This listing is not waiting for review');
    }
    this.log('listing_rejected', `Listing "${product.name}" sent back: ${reason.trim()}`, meta, id);
    this.notifySeller(product, NOTIFICATION_TYPES.LISTING_REJECTED,
      `"${product.name}" needs changes`,
      `${reason.trim()} Edit the listing and publish it again to resubmit.`);
    return { success: true, message: 'Sent back to the seller', data: { status: 'rejected' } };
  }

  /** Grants/revokes a trust badge (e.g. 'verified_educator') on a store — reuses
   *  the existing `Store.badges: string[]` field the marketplace listing/store
   *  UI already reads; this is just the first admin action that writes it. */
  async setStoreBadge(storeId: string, badge: string, grant: boolean, meta: AuditMeta) {
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');

    // Atomic set operations: the old read-modify-write lost a concurrent grant/revoke of another badge.
    const updated = await this.r.storeModel.findOneAndUpdate(
      { _id: storeId, isDelete: false },
      grant ? { $addToSet: { badges: badge } } : { $pull: { badges: badge } },
      { returnDocument: 'after' },
    );
    const next: string[] = updated?.badges ?? [];

    this.log(
      grant ? 'store_badge_granted' : 'store_badge_revoked',
      `Badge "${badge}" ${grant ? 'granted to' : 'revoked from'} store "${store.name}"`,
      meta,
      storeId,
      'store',
    );
    return { success: true, message: grant ? 'Badge granted' : 'Badge revoked', data: { badges: next } };
  }

  /** Admin override of who ships a store's physical orders (see Store.fulfillmentMode). New orders only. */
  async setFulfillmentMode(storeId: string, fulfillmentMode: 'seller' | 'platform', meta: AuditMeta) {
    const updated = await this.r.storeModel.findOneAndUpdate(
      { _id: storeId, isDelete: false },
      { $set: { fulfillmentMode } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new NotFoundException('Store not found');
    this.log(
      'store_fulfillment_mode_set',
      `Fulfillment mode of store "${updated.name}" set to ${fulfillmentMode} (applies to new orders only)`,
      meta,
      storeId,
      'store',
    );
    return { success: true, message: 'Fulfillment mode updated', data: { fulfillmentMode } };
  }

  /** Active stores ranked exactly like the home rail (pinned first, then Featured score) so the admin sees what buyers see. */
  async getFeaturedStores() {
    const stores = await this.r.storeModel.find({ status: 'active', isDelete: false }).sort({ averageRating: -1 }).limit(300).lean();
    const scored = await this.storeService.scoreFeaturedCandidates(stores);
    const ranked = [...scored].sort((a, b) => {
      const ap = typeof a.featuredRank === 'number', bp = typeof b.featuredRank === 'number';
      if (ap !== bp) return ap ? -1 : 1;
      if (ap && bp) return (a.featuredRank! - b.featuredRank!) || (b.score - a.score);
      return b.score - a.score;
    });
    return {
      success: true,
      data: {
        stores: ranked.map((r) => ({
          storeId: r.storeId, name: r.store.name, slug: r.store.slug, logo: r.store.logo ?? null,
          score: r.score, featuredRank: r.featuredRank, publishedProducts: r.publishedProducts, soldCount: r.soldCount,
          averageRating: r.store.averageRating ?? 0, reviewCount: r.store.reviewCount ?? 0, followersCount: r.store.followersCount ?? 0,
          qualityOk: isQualityStore(r),
        })),
      },
    };
  }

  /** Pin a store to the front of the home Featured sellers rail (rank 1 = first) or unpin it (null). */
  async setFeaturedRank(storeId: string, rank: number | null, meta: AuditMeta) {
    const updated = await this.r.storeModel.findOneAndUpdate(
      { _id: storeId, isDelete: false, status: 'active' },
      { $set: { featuredRank: rank } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new NotFoundException('Store not found or not active');
    await Promise.all([6, 8, 10, 12, 16, 20, 24, 30, 40, 50].map((n) => this.redis.del(`top-stores:v6:${n}`).catch(() => undefined)));
    this.log(
      rank === null ? 'store_featured_unpinned' : 'store_featured_pinned',
      rank === null ? `Store "${updated.name}" unpinned from Featured sellers` : `Store "${updated.name}" pinned to Featured sellers rank ${rank}`,
      meta,
      storeId,
      'store',
    );
    return { success: true, message: rank === null ? 'Unpinned' : 'Pinned', data: { featuredRank: rank } };
  }

  /** Store approvals queue (legacy). New stores are live immediately now, so this only lists stores whose
   *  marketplace `status` is `pending` (created before business verification was removed). Filter by `status`
   *  (default `pending`; `all` removes the filter). */
  async getLeads(query: LeadsQueryDto) {
    const filter: Record<string, unknown> = { isDelete: false };
    const status = query.status ?? 'pending';
    if (status !== 'all') filter.status = status;
    if (query.search) filter.name = { $regex: escapeRegex(query.search), $options: 'i' };

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [stores, total] = await Promise.all([
      this.r.storeModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.storeModel.countDocuments(filter),
    ]);

    const sellerIds = [...new Set(stores.map((s: any) => s.sellerId))];
    const categoryIds = [...new Set(stores.map((s: any) => s.categoryId).filter(Boolean))];
    const [sellers, categories] = await Promise.all([
      this.r.sellerModel.find({ _id: { $in: sellerIds } }, { name: 1, email: 1, phone: 1, address: 1 }).lean(),
      this.r.categoryModel.find({ _id: { $in: categoryIds } }, { name: 1 }).lean(),
    ]);
    const sellerById = new Map(sellers.map((s: any) => [String(s._id), s]));
    const categoryNameById = new Map(categories.map((c: any) => [String(c._id), c.name]));

    const items = stores.map((s: any) => {
      const seller = sellerById.get(s.sellerId);
      return {
        id: s._id,
        storeName: s.name,
        logo: s.logo,
        description: s.description,
        categoryId: s.categoryId,
        categoryName: s.categoryId ? categoryNameById.get(s.categoryId) ?? null : null,
        sellerType: s.sellerType,
        productTypes: s.productTypes,
        baseCurrency: s.baseCurrency,
        submittedAt: s.createdAt,
        storeStatus: s.status,
        country: s.country ?? 'PK',
        seller: {
          id: s.sellerId,
          name: seller?.name ?? 'Unknown',
          email: seller?.email ?? null,
          phone: seller?.phone ?? null,
          address: seller?.address ?? null,
        },
      };
    });

    return { success: true, data: { items, total, page, limit } };
  }

  async getLeadDetail(id: string) {
    const store = await this.r.storeModel.findOne({ _id: id, isDelete: false });
    if (!store) throw new NotFoundException('Lead not found');

    const [seller, category] = await Promise.all([
      this.r.sellerModel.findById(store.sellerId, { name: 1, email: 1, phone: 1, address: 1 }).lean(),
      store.categoryId ? this.r.categoryModel.findById(store.categoryId, { name: 1 }).lean() : null,
    ]);

    return {
      success: true,
      data: {
        id: store._id,
        storeName: store.name,
        logo: store.logo,
        description: store.description,
        categoryName: (category as any)?.name ?? null,
        sellerType: store.sellerType,
        productTypes: store.productTypes,
        storeStatus: store.status,
        rejectionReason: store.rejectionReason,
        submittedAt: (store as any).createdAt,
        seller: {
          id: store.sellerId,
          name: seller?.name ?? 'Unknown',
          email: seller?.email ?? null,
          phone: seller?.phone ?? null,
          address: seller?.address ?? null,
        },
        country: store.country ?? 'PK',
        canApprove: store.status === 'pending' || store.status === 'rejected',
      },
    };
  }

  /** Approve = store goes live (status -> active). A suspended store is never re-activated here. */
  async approveLead(id: string, meta: AuditMeta) {
    const store = await this.r.storeModel.findOne({ _id: id, isDelete: false });
    if (!store) throw new NotFoundException('Lead not found');

    // A store of a suspended seller must not go live (the suspension cascade only touched stores that were active).
    const owner = await this.r.sellerModel.findOne({ _id: store.sellerId, isDelete: false }, { status: 1 }).lean();
    if (!owner || owner.status === 'suspended') {
      throw new ConflictException('The seller account is suspended or missing — unsuspend the seller before approving this store');
    }

    const approved = await this.r.storeModel.findOneAndUpdate(
      { _id: id, isDelete: false, status: { $in: ['pending', 'rejected'] } },
      { $set: { status: 'active', reviewedAt: new Date(), rejectionReason: null } },
    );
    if (!approved) throw new BadRequestException('This store was already reviewed, or it is suspended');

    this.log('lead_approved', `Store "${store.name}" approved and is now live`, meta, id, 'store');
    this.notificationsService.notify({
      recipientId: store.sellerId,
      recipientRole: 'seller',
      type: NOTIFICATION_TYPES.STORE_APPROVED,
      title: 'Your store is live!',
      body: `"${store.name}" has been approved and is now visible on the marketplace.`,
      data: { storeId: id },
    }).catch(() => {});

    return { success: true, message: 'Store approved — it is now live' };
  }

  /** `reason` is mandatory (enforced by `RejectLeadDto`). */
  async rejectLead(id: string, reason: string, meta: AuditMeta) {
    const store = await this.r.storeModel.findOne({ _id: id, isDelete: false });
    if (!store) throw new NotFoundException('Lead not found');

    const rejected = await this.r.storeModel.findOneAndUpdate(
      { _id: id, isDelete: false, status: 'pending' },
      { $set: { status: 'rejected', rejectionReason: reason, reviewedAt: new Date() } },
    );
    if (!rejected) throw new BadRequestException('This store was already reviewed, or it is suspended');

    this.log('lead_rejected', `Store "${store.name}" rejected: ${reason}`, meta, id, 'store');
    this.notificationsService.notify({
      recipientId: store.sellerId,
      recipientRole: 'seller',
      type: NOTIFICATION_TYPES.STORE_REJECTED,
      title: 'Your store application was rejected',
      body: `"${store.name}" was rejected: ${reason}.`,
      data: { storeId: id },
    }).catch(() => {});

    return { success: true, message: 'Store rejected' };
  }
}