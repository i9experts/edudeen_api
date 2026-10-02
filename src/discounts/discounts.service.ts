/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { CreateAutomaticDiscountDto } from './dto/create-automatic-discount.dto';
import { UpdateAutomaticDiscountDto } from './dto/update-automatic-discount.dto';

@Injectable()
export class DiscountsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  private validateTargeting(dto: { target: string; categoryIds?: string[]; productIds?: string[] }) {
    if (dto.target === 'category' && (!dto.categoryIds || dto.categoryIds.length === 0)) {
      throw new BadRequestException('Select at least one category for a category-targeted discount');
    }
    if (dto.target === 'products' && (!dto.productIds || dto.productIds.length === 0)) {
      throw new BadRequestException('Select at least one product for a product-targeted discount');
    }
  }

  async createDiscount(sellerId: string, storeId: string, dto: CreateAutomaticDiscountDto) {
    const store = await this.verifyStoreOwnership(storeId, sellerId);
    this.validateTargeting(dto);
    if (dto.discountType === 'percentage' && dto.discountValue > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100');
    }

    const discount = await this.r.automaticDiscountModel.create({
      storeId,
      name: dto.name,
      discountType: dto.discountType,
      discountValue: dto.discountValue,
      currency: dto.discountType === 'fixed' ? (store.baseCurrency ?? 'USD') : null,
      target: dto.target,
      categoryIds: dto.target === 'category' ? dto.categoryIds : [],
      productIds: dto.target === 'products' ? dto.productIds : [],
      minOrderAmount: dto.minOrderAmount ?? null,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
    });

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'automatic_discount_created',
      description: `${dto.name} — ${dto.discountType === 'percentage' ? `${dto.discountValue}%` : `${store.baseCurrency ?? 'USD'} ${dto.discountValue}`} off (${dto.target})`,
      actorId: sellerId, actorRole: 'seller', targetId: String(discount._id), targetType: 'automatic_discount',
    });

    return { success: true, message: 'Discount created', data: discount };
  }

  async listDiscounts(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const discounts = await this.r.automaticDiscountModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).lean();
    return { success: true, message: 'Discounts', data: discounts };
  }

  async updateDiscount(sellerId: string, storeId: string, discountId: string, dto: UpdateAutomaticDiscountDto) {
    const store = await this.verifyStoreOwnership(storeId, sellerId);
    if (dto.target) this.validateTargeting(dto as any);

    const current = await this.r.automaticDiscountModel.findOne({ _id: discountId, storeId, isDelete: false });
    if (!current) throw new NotFoundException('Discount not found');
    // Validate the MERGED type+value: patching only discountValue on a
    // percentage discount used to skip the >100 check entirely.
    const mergedType = dto.discountType ?? current.discountType;
    const mergedValue = dto.discountValue ?? current.discountValue;
    if (!Number.isFinite(mergedValue) || mergedValue <= 0) throw new BadRequestException('Discount value must be greater than 0');
    if (mergedType === 'percentage' && mergedValue > 100) throw new BadRequestException('Percentage discount cannot exceed 100');

    // Only fields actually sent (an own-`undefined` key would $set null-ish).
    const patch: any = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    if (dto.discountType !== undefined) patch.currency = dto.discountType === 'fixed' ? (store.baseCurrency ?? 'USD') : null;
    if (dto.startsAt !== undefined) patch.startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    if (dto.endsAt !== undefined) patch.endsAt = dto.endsAt ? new Date(dto.endsAt) : null;

    const discount = await this.r.automaticDiscountModel.findOneAndUpdate(
      { _id: discountId, storeId, isDelete: false },
      { $set: patch },
      { returnDocument: 'after' },
    );
    if (!discount) throw new NotFoundException('Discount not found');

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'automatic_discount_updated',
      description: `${discount.name} updated`, actorId: sellerId, actorRole: 'seller',
      targetId: discountId, targetType: 'automatic_discount',
    });

    return { success: true, message: 'Discount updated', data: discount };
  }

  async deleteDiscount(sellerId: string, storeId: string, discountId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const discount = await this.r.automaticDiscountModel.findOneAndUpdate(
      { _id: discountId, storeId, isDelete: false },
      { isDelete: true, isActive: false },
      { returnDocument: 'after' },
    );
    if (!discount) throw new NotFoundException('Discount not found');

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'automatic_discount_deleted',
      description: `${discount.name} deleted`, actorId: sellerId, actorRole: 'seller',
      targetId: discountId, targetType: 'automatic_discount',
    });

    return { success: true, message: 'Discount deleted' };
  }

  /** One query for any number of stores, mirroring
   *  MarketingService.getActiveCampaignsForStores — called once per checkout
   *  creation for every store in the cart, never per-item. */
  async getActiveDiscountsForStores(storeIds: string[]): Promise<Map<string, any[]>> {
    const map = new Map<string, any[]>();
    if (storeIds.length === 0) return map;

    const uniqueIds = [...new Set(storeIds)];
    const now = new Date();
    const discounts = await this.r.automaticDiscountModel
      .find({
        storeId: { $in: uniqueIds },
        isActive: true,
        isDelete: false,
        $and: [
          { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
          { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
        ],
      })
      .lean();

    // A seller's bundles compete in the same one-best-per-store pass, as a
    // percentage discount that only applies once every bundle item is in the cart.
    const bundles = await this.r.bundleModel
      .find({ storeId: { $in: uniqueIds }, isActive: true, isDelete: false })
      .lean();
    const bundleCandidates = bundles.map((b: any) => ({
      _id: b._id, storeId: b.storeId, name: b.name, target: 'bundle', discountType: 'percentage',
      discountValue: b.discountPercent, productIds: b.productIds, categoryIds: [], minOrderAmount: null,
    }));

    for (const d of [...discounts, ...bundleCandidates]) {
      const existing = map.get(d.storeId);
      if (existing) existing.push(d);
      else map.set(d.storeId, [d]);
    }
    return map;
  }
}
