/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { isValidObjectId } from 'mongoose';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { ProductsService } from '../products/products.service';
import { sanitizeDigitalForPublicView } from '../products/product-public-view.util';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { cleanBundleInput, bundleQuote } from './bundle.util';
import { BUNDLE_MAX_ITEMS, BUNDLE_MAX_PERCENT, BUNDLE_MIN_ITEMS } from './schemas/bundle.schema';

@Injectable()
export class BundlesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly productsService: ProductsService,
    @Optional() private readonly activityLog?: ActivityLogService,
  ) {}

  private audit(storeId: string, sellerId: string, action: string, bundleId: string | null, description: string) {
    // Awaited by callers' flow only loosely: a failed audit write never blocks the seller (ActivityLogService retries + logs).
    return this.activityLog?.log({
      storeId, category: 'marketing', action, description, actorId: sellerId, actorRole: 'seller',
      targetId: bundleId, targetType: 'bundle',
    } as any);
  }

  private get r() {
    return this.databaseService.repositories;
  }

  private async assertOwnProducts(storeId: string, productIds: string[]) {
    const n = await this.r.productModel.countDocuments({ _id: { $in: productIds }, storeId, isDelete: false });
    if (n !== productIds.length) throw new BadRequestException('Every product in a bundle must be from your own store');
  }

  async listForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const bundles = await this.r.bundleModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).lean();
    const ids = [...new Set(bundles.flatMap(b => b.productIds))];
    const products = await this.r.productModel.find({ _id: { $in: ids } }).select('_id name images status isDelete isTest').lean();
    const byId = new Map(products.map((p: any) => [String(p._id), { _id: String(p._id), name: p.name, image: p.images?.[0] ?? null, status: p.status, isDelete: !!p.isDelete, isTest: !!p.isTest }]));
    const variants: any[] = ids.length
      ? await this.r.productVariantModel.find({ productId: { $in: ids }, status: 'active', isDelete: false }).select('productId price currency isDefault').lean()
      : [];
    const defaultByProduct = new Map<string, any>();
    for (const v of variants) { if (!defaultByProduct.has(v.productId) || v.isDefault) defaultByProduct.set(v.productId, v); }
    return {
      success: true,
      data: bundles.map((b: any) => {
        const items = b.productIds.map((id: string) => byId.get(id)).filter(Boolean) as any[];
        const valid = items.filter((p) => !p.isDelete && p.status === 'active' && !p.isTest);
        // Read-time only: nothing is rewritten. Fewer than 2 live products = shown as a draft (hidden from buyers).
        const displayStatus = !b.isActive || valid.length < BUNDLE_MIN_ITEMS ? 'draft' : valid.length < b.productIds.length ? 'incomplete' : 'active';
        const prices = b.productIds.map((id: string) => defaultByProduct.get(id)?.price ?? 0);
        const currency = b.productIds.map((id: string) => defaultByProduct.get(id)?.currency).find(Boolean) ?? null;
        return {
          ...b, products: items, validCount: valid.length, displayStatus, currency,
          ...bundleQuote(prices, b.discountPercent),
        };
      }),
    };
  }

  /** Read-only quote for the modal's sticky summary: the SAME arithmetic as the public bundle card and the cart. */
  async quote(storeId: string, sellerId: string, productIds: string[], discountPercent: number) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const ids = [...new Set((productIds ?? []).filter((x) => typeof x === 'string' && isValidObjectId(x)))].slice(0, BUNDLE_MAX_ITEMS);
    const pct = Number(discountPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > BUNDLE_MAX_PERCENT) throw new BadRequestException('discountPercent is out of range');
    await this.assertOwnProducts(storeId, ids);
    const variants: any[] = ids.length
      ? await this.r.productVariantModel.find({ productId: { $in: ids }, status: 'active', isDelete: false }).select('productId price currency isDefault').lean()
      : [];
    const by = new Map<string, any>();
    for (const v of variants) { if (!by.has(v.productId) || v.isDefault) by.set(v.productId, v); }
    const currency = [...by.values()].map((v) => v.currency).find(Boolean) ?? null;
    return { success: true, data: { currency, itemCount: ids.length, ...bundleQuote(ids.map((id) => by.get(id)?.price ?? 0), pct) } };
  }

  /** Up to 6 products worth adding: same sub-category as the picked ones, or bought together with them in THIS store's
   *  own orders. Always scoped to storeId — another store's product can never be returned. */
  async suggestions(storeId: string, sellerId: string, productIds: string[]) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const picked = [...new Set((productIds ?? []).filter((x) => typeof x === 'string' && isValidObjectId(x)))].slice(0, BUNDLE_MAX_ITEMS);
    if (picked.length === 0) return { success: true, data: [] };
    const base = { storeId, isDelete: false, status: 'active', isTest: { $ne: true }, _id: { $nin: picked } };
    const pickedDocs: any[] = await this.r.productModel.find({ _id: { $in: picked }, storeId }).select('subCategoryId').lean();
    const subs = [...new Set(pickedDocs.map((p) => p.subCategoryId).filter(Boolean))];

    const together: { _id: string; n: number }[] = await this.r.orderModel.aggregate([
      { $match: { 'sellerOrders.storeId': storeId } },
      { $sort: { createdAt: -1 } },
      { $limit: 500 },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': storeId, 'sellerOrders.items.productId': { $in: picked } } },
      { $unwind: '$sellerOrders.items' },
      { $match: { 'sellerOrders.items.productId': { $nin: picked } } },
      { $group: { _id: '$sellerOrders.items.productId', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 12 },
    ]);
    const togetherIds = together.map((t) => String(t._id)).filter((id) => isValidObjectId(id));

    const out: any[] = [];
    const seen = new Set<string>();
    const push = (docs: any[], reason: string) => {
      for (const d of docs) {
        const id = String(d._id);
        if (seen.has(id) || out.length >= 6) continue;
        seen.add(id);
        out.push({ _id: id, name: d.name, image: d.images?.[0] ?? null, reason });
      }
    };
    if (togetherIds.length) {
      const docs: any[] = await this.r.productModel.find({ ...base, _id: { $in: togetherIds, $nin: picked } }).select('name images').lean();
      const order = new Map(togetherIds.map((id, i) => [id, i]));
      docs.sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));
      push(docs, 'Bought together');
    }
    if (out.length < 6 && subs.length) {
      push(await this.r.productModel.find({ ...base, subCategoryId: { $in: subs } }).select('name images').sort({ purchaseCount: -1, createdAt: -1 }).limit(12).lean(), 'Same subject');
    }
    return { success: true, data: out };
  }

  /** Copy as a DRAFT (inactive) so the seller can adjust it before it goes live. */
  async duplicate(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    if (!isValidObjectId(id)) throw new NotFoundException('Bundle not found');
    const src: any = await this.r.bundleModel.findOne({ _id: id, storeId, isDelete: false }).lean();
    if (!src) throw new NotFoundException('Bundle not found');
    const count = await this.r.bundleModel.countDocuments({ storeId, isDelete: false });
    if (count >= 50) throw new BadRequestException('A store can have up to 50 bundles');
    const name = `${src.name} (copy)`.slice(0, 100);
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'bundle';
    const bundle = await this.r.bundleModel.create({
      storeId, sellerId, name, nameUr: src.nameUr ?? null, coverImage: src.coverImage ?? null, description: src.description ?? '',
      productIds: src.productIds, discountPercent: src.discountPercent, isActive: false, slug: `${base}-${randomBytes(3).toString('hex')}`,
    });
    await this.audit(storeId, sellerId, 'bundle_duplicated', String(bundle._id), name);
    return { success: true, message: 'Bundle duplicated as a draft', data: bundle };
  }

  /** A store's live bundles for its public page (all products live, store active). Read-only. */
  async forStore(storeId: string, viewerId?: string | null) {
    if (!isValidObjectId(storeId)) return { success: true, data: [] };
    if (!(await this.r.storeModel.exists({ _id: storeId, status: 'active', isDelete: false }))) return { success: true, data: [] };
    const bundles = await this.r.bundleModel.find({ storeId, isActive: true, isDelete: false }).sort({ createdAt: -1 }).limit(12).lean();
    const shaped = (await Promise.all(bundles.map(b => this.shape(b, viewerId)))).filter(Boolean);
    return { success: true, data: shaped };
  }

  async create(storeId: string, sellerId: string, body: any) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const input = cleanBundleInput(body);
    await this.assertOwnProducts(storeId, input.productIds!);
    const count = await this.r.bundleModel.countDocuments({ storeId, isDelete: false });
    if (count >= 50) throw new BadRequestException('A store can have up to 50 bundles');
    const base = input.name!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'bundle';
    const bundle = await this.r.bundleModel.create({ ...input, storeId, sellerId, slug: `${base}-${randomBytes(3).toString('hex')}` });
    await this.audit(storeId, sellerId, 'bundle_created', String(bundle._id), input.name!);
    return { success: true, message: 'Bundle created', data: bundle };
  }

  async update(storeId: string, sellerId: string, id: string, body: any) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    if (!isValidObjectId(id)) throw new NotFoundException('Bundle not found');
    const input = cleanBundleInput(body, true);
    if (input.productIds) await this.assertOwnProducts(storeId, input.productIds);
    const bundle = await this.r.bundleModel.findOneAndUpdate({ _id: id, storeId, isDelete: false }, { $set: input }, { returnDocument: 'after' });
    if (!bundle) throw new NotFoundException('Bundle not found');
    await this.audit(storeId, sellerId, 'bundle_updated', id, bundle.name);
    return { success: true, message: 'Bundle updated', data: bundle };
  }

  async remove(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    if (!isValidObjectId(id)) throw new NotFoundException('Bundle not found');
    const bundle = await this.r.bundleModel.findOneAndUpdate({ _id: id, storeId, isDelete: false }, { $set: { isDelete: true, isActive: false } });
    if (!bundle) throw new NotFoundException('Bundle not found');
    await this.audit(storeId, sellerId, 'bundle_deleted', id, (bundle as any).name ?? '');
    return { success: true, message: 'Bundle deleted' };
  }

  /** Shapes a bundle for buyers — live products only; a bundle missing any product is not offered. */
  private async shape(bundle: any, viewerId?: string | null) {
    const products = (await this.productsService.getShapedProductsByIds(bundle.productIds, viewerId ?? null)).map((p: any) => sanitizeDigitalForPublicView(p));
    if (products.length !== bundle.productIds.length) return null;
    let currency = 'PKR';
    const unitPrices = products.map((p: any) => {
      const v = (p.variants ?? []).find((x: any) => x.isDefault) ?? p.variants?.[0];
      if (v?.currency) currency = v.currency;
      return v?.price ?? 0;
    });
    const store: any = await this.r.storeModel.findById(bundle.storeId).select('name slug').lean();
    return {
      _id: bundle._id, name: bundle.name, nameUr: bundle.nameUr ?? null, coverImage: bundle.coverImage ?? null, slug: bundle.slug, description: bundle.description, discountPercent: bundle.discountPercent,
      storeId: bundle.storeId, storeName: store?.name ?? null, storeSlug: store?.slug ?? null,
      currency, ...bundleQuote(unitPrices, bundle.discountPercent),
      products,
    };
  }

  async forProduct(productId: string, viewerId?: string | null) {
    if (!isValidObjectId(productId)) return { success: true, data: [] };
    const bundles = await this.r.bundleModel.find({ productIds: productId, isActive: true, isDelete: false }).limit(3).lean();
    const shaped = (await Promise.all(bundles.map(b => this.shape(b, viewerId)))).filter(Boolean);
    return { success: true, data: shaped };
  }

  /** Home-page shelf: the newest active bundles whose products are all still live (bundles of suspended stores or with a missing product are skipped). */
  async listPublic(limit = 6, viewerId?: string | null) {
    const lim = Math.min(12, Math.max(1, Math.floor(limit) || 6));
    const activeStores = new Set((await this.r.storeModel.find({ status: 'active', isDelete: false }).select('_id').lean()).map((s: any) => String(s._id)));
    const bundles = (await this.r.bundleModel.find({ isActive: true, isDelete: false }).sort({ createdAt: -1 }).limit(lim * 3).lean())
      .filter((b: any) => activeStores.has(String(b.storeId)));
    const shaped: any[] = [];
    for (const b of bundles) {
      if (shaped.length >= lim) break;
      const s = await this.shape(b, viewerId);
      if (s) shaped.push(s);
    }
    return { success: true, data: shaped };
  }

  async bySlug(slug: string, viewerId?: string | null) {
    const bundle = await this.r.bundleModel.findOne({ slug: String(slug ?? ''), isActive: true, isDelete: false }).lean();
    const shaped = bundle ? await this.shape(bundle, viewerId) : null;
    if (!shaped) throw new NotFoundException('This bundle is no longer available');
    return { success: true, data: shaped };
  }
}
