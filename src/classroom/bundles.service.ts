/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { ProductsService } from '../products/products.service';
import { sanitizeDigitalForPublicView } from '../products/product-public-view.util';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { cleanBundleInput, round } from './bundle.util';

@Injectable()
export class BundlesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly productsService: ProductsService,
  ) {}

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
    const products = await this.r.productModel.find({ _id: { $in: ids } }).select('_id name images status').lean();
    const byId = new Map(products.map((p: any) => [String(p._id), { _id: String(p._id), name: p.name, image: p.images?.[0] ?? null, status: p.status }]));
    return { success: true, data: bundles.map(b => ({ ...b, products: b.productIds.map(id => byId.get(id)).filter(Boolean) })) };
  }

  async create(storeId: string, sellerId: string, body: any) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const input = cleanBundleInput(body);
    await this.assertOwnProducts(storeId, input.productIds!);
    const count = await this.r.bundleModel.countDocuments({ storeId, isDelete: false });
    if (count >= 50) throw new BadRequestException('A store can have up to 50 bundles');
    const base = input.name!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'bundle';
    const bundle = await this.r.bundleModel.create({ ...input, storeId, sellerId, slug: `${base}-${randomBytes(3).toString('hex')}` });
    return { success: true, message: 'Bundle created', data: bundle };
  }

  async update(storeId: string, sellerId: string, id: string, body: any) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    if (!isValidObjectId(id)) throw new NotFoundException('Bundle not found');
    const input = cleanBundleInput(body, true);
    if (input.productIds) await this.assertOwnProducts(storeId, input.productIds);
    const bundle = await this.r.bundleModel.findOneAndUpdate({ _id: id, storeId, isDelete: false }, { $set: input }, { returnDocument: 'after' });
    if (!bundle) throw new NotFoundException('Bundle not found');
    return { success: true, message: 'Bundle updated', data: bundle };
  }

  async remove(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    if (!isValidObjectId(id)) throw new NotFoundException('Bundle not found');
    const bundle = await this.r.bundleModel.findOneAndUpdate({ _id: id, storeId, isDelete: false }, { $set: { isDelete: true, isActive: false } });
    if (!bundle) throw new NotFoundException('Bundle not found');
    return { success: true, message: 'Bundle deleted' };
  }

  /** Shapes a bundle for buyers — live products only; a bundle missing any product is not offered. */
  private async shape(bundle: any, viewerId?: string | null) {
    const products = (await this.productsService.getShapedProductsByIds(bundle.productIds, viewerId ?? null)).map((p: any) => sanitizeDigitalForPublicView(p));
    if (products.length !== bundle.productIds.length) return null;
    let currency = 'PKR';
    const total = products.reduce((s: number, p: any) => {
      const v = (p.variants ?? []).find((x: any) => x.isDefault) ?? p.variants?.[0];
      if (v?.currency) currency = v.currency;
      return s + (v?.price ?? 0);
    }, 0);
    const store: any = await this.r.storeModel.findById(bundle.storeId).select('name slug').lean();
    return {
      _id: bundle._id, name: bundle.name, slug: bundle.slug, description: bundle.description, discountPercent: bundle.discountPercent,
      storeId: bundle.storeId, storeName: store?.name ?? null, storeSlug: store?.slug ?? null,
      currency, totalPrice: round(total), bundlePrice: round(total * (1 - bundle.discountPercent / 100)), savings: round(total * bundle.discountPercent / 100),
      products,
    };
  }

  async forProduct(productId: string, viewerId?: string | null) {
    if (!isValidObjectId(productId)) return { success: true, data: [] };
    const bundles = await this.r.bundleModel.find({ productIds: productId, isActive: true, isDelete: false }).limit(3).lean();
    const shaped = (await Promise.all(bundles.map(b => this.shape(b, viewerId)))).filter(Boolean);
    return { success: true, data: shaped };
  }

  async bySlug(slug: string, viewerId?: string | null) {
    const bundle = await this.r.bundleModel.findOne({ slug: String(slug ?? ''), isActive: true, isDelete: false }).lean();
    const shaped = bundle ? await this.shape(bundle, viewerId) : null;
    if (!shaped) throw new NotFoundException('This bundle is no longer available');
    return { success: true, data: shaped };
  }
}
