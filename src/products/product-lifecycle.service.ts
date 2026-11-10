/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { generateProductSlug } from '../common/slug.util';
import { allocateSkus } from './sku.util';

/** Content fields a copy inherits. Everything else (sales counters, ratings, offers, flags, review/plan markers, slugs) starts fresh. */
export const DUPLICATE_COPY_FIELDS = [
  'description', 'productType', 'type', 'categoryId', 'subCategoryId', 'educationLevel', 'customLevel', 'normalizedCustomLevel',
  'curricula', 'ageMin', 'ageMax', 'classFrom', 'classTo', 'language', 'coverStyle', 'parcelType', 'dispatchDaysOverride',
  'packageCm', 'deliveryFormat', 'images', 'tags', 'digital', 'isListedOnEdudeen', 'nameUr', 'descriptionUr',
] as const;
export const VARIANT_COPY_FIELDS = ['price', 'compareAtPrice', 'currency', 'options', 'stock', 'unlimitedStock', 'shippingWeight', 'images', 'isDefault', 'status'] as const;
const NAME_MAX = 150;

export type VisibilityPlan =
  | { ok: true; from: 'active' | 'scheduled' | 'inactive'; to: 'inactive' | 'active' | 'scheduled' | 'pending_review' }
  | { ok: false; code: 400 | 403 | 409; message: string };

/** Pure rule table for the Activate / Deactivate toggle. */
export function planVisibilityChange(p: any, active: boolean, now: Date = new Date()): VisibilityPlan {
  if (!p || p.isDelete) return { ok: false, code: 400, message: 'Product not found' };
  if (p.pausedFromStatus) return { ok: false, code: 409, message: 'Paused - plan ended. Choose a plan in Plan & Billing and this product comes back on its own.' };
  if (!active) {
    if (p.status === 'active' || p.status === 'scheduled') return { ok: true, from: p.status, to: 'inactive' };
    return { ok: false, code: 409, message: 'Only a live or scheduled product can be deactivated.' };
  }
  if (p.status !== 'inactive') return { ok: false, code: 409, message: 'Only a deactivated product can be activated.' };
  if (p.removedByAdmin) return { ok: false, code: 403, message: 'This listing was removed by Edudeen and cannot be activated.' };
  const flagged = Array.isArray(p.flags) && p.flags.length > 0;
  if (!p.approvedAt || flagged) return { ok: true, from: 'inactive', to: 'pending_review' };
  const future = p.scheduledAt && new Date(p.scheduledAt).getTime() > now.getTime();
  return { ok: true, from: 'inactive', to: future ? 'scheduled' : 'active' };
}

@Injectable()
export class ProductLifecycleService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private async ownProduct(sellerId: string, productId: string) {
    if (!isValidObjectId(productId)) throw new BadRequestException('Invalid product id');
    const { productModel } = this.databaseService.repositories;
    const product: any = await productModel.findOne({ _id: productId, isDelete: false }).lean();
    if (!product) throw new NotFoundException('Product not found');
    if (String(product.sellerId) !== String(sellerId)) throw new ForbiddenException('You do not own this product');
    return product;
  }

  async duplicate(sellerId: string, productId: string) {
    const { productModel, productVariantModel, storeModel } = this.databaseService.repositories;
    const src = await this.ownProduct(sellerId, productId);
    if (src.deliveryFormat === 'course') throw new BadRequestException('Courses cannot be duplicated yet.');
    const store: any = await storeModel.findOne({ _id: src.storeId, sellerId }).select('name').lean();
    if (!store) throw new ForbiddenException('You do not own this store');
    await this.entitlements.assertCanCreateProduct(String(src.storeId));

    const variants: any[] = await productVariantModel.find({ productId, isDelete: false }).lean();
    const name = `${String(src.name).slice(0, NAME_MAX - 7).trimEnd()} (copy)`;
    const slug = await generateProductSlug(productModel, name);

    const doc: any = { sellerId: src.sellerId, storeId: src.storeId, name, slug, status: 'draft', isTest: false };
    for (const f of DUPLICATE_COPY_FIELDS) if (src[f] !== undefined) doc[f] = src[f];
    // Cloned arrays/objects must not share references with the source document.
    for (const k of ['images', 'tags', 'curricula', 'digital', 'packageCm']) if (doc[k] != null) doc[k] = JSON.parse(JSON.stringify(doc[k]));

    const created: any = await productModel.create(doc);
    try {
      if (variants.length) {
        const skus = await allocateSkus(storeModel as any, store, variants.length);
        const rows = variants.map((v, i) => {
          const row: any = { productId: String(created._id), sku: skus[i], barcode: null };
          for (const f of VARIANT_COPY_FIELDS) if (v[f] !== undefined) row[f] = JSON.parse(JSON.stringify(v[f]));
          return row;
        });
        await productVariantModel.insertMany(rows);
      }
    } catch (e) {
      await productModel.deleteOne({ _id: created._id }).catch(() => undefined);
      throw e;
    }
    await this.activityLogService.log({
      storeId: String(src.storeId), category: 'products', action: 'product_duplicated',
      description: `Product "${src.name}" duplicated as draft "${name}"`,
      actorId: sellerId, actorRole: 'seller', targetId: String(created._id), targetType: 'product',
      metadata: { sourceId: productId },
    } as any);
    return { success: true, message: 'Draft copy created', data: { productId: String(created._id), slug, name, status: 'draft' } };
  }

  async setVisibility(sellerId: string, productId: string, body: any) {
    if (typeof body?.active !== 'boolean') throw new BadRequestException('active must be true or false');
    const active: boolean = body.active;
    const { productModel } = this.databaseService.repositories;
    const product = await this.ownProduct(sellerId, productId);
    const plan = planVisibilityChange(product, active);
    if (plan.ok === false) {
      if (plan.code === 403) throw new ForbiddenException(plan.message);
      if (plan.code === 409) throw new ConflictException(plan.message);
      throw new BadRequestException(plan.message);
    }
    if (active) await this.entitlements.assertCanCreateProduct(String(product.storeId)); // expired / past_due / canceled plan blocked

    const res: any = await productModel.updateOne(
      { _id: productId, sellerId, isDelete: false, status: plan.from, pausedFromStatus: null },
      { $set: { status: plan.to } },
    );
    if (!(res?.modifiedCount ?? res?.nModified ?? 0)) throw new ConflictException('The product changed meanwhile. Refresh and try again.');
    await this.activityLogService.log({
      storeId: String(product.storeId), category: 'products', action: active ? 'product_activated' : 'product_deactivated',
      description: `Product "${product.name}" ${active ? (plan.to === 'pending_review' ? 'sent for review' : 'activated') : 'deactivated'}`,
      actorId: sellerId, actorRole: 'seller', targetId: productId, targetType: 'product',
      metadata: { from: plan.from, to: plan.to },
    } as any);
    return { success: true, message: plan.to === 'pending_review' ? 'Sent to Edudeen for review before it goes live.' : active ? 'Product is live again.' : 'Product deactivated.', data: { status: plan.to } };
  }
}
