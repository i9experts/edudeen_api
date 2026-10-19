import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PremiumEntitlementsService } from 'src/premium/premium-entitlements.service';
import { assertPremiumGap } from 'src/premium/premium-gap';
import { assertPriceRules, assertStockRule, cleanShippingWeight } from 'src/products/price-rules.util';
import { DatabaseService } from 'src/database/databaseservice';
import { CreateVariantDto } from './dto/create-variant.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { optionNameSet, optionsKey, VariantOptionInput } from '../products/variant-options.util';
import { allocateSkus, cleanSku } from '../products/sku.util';

@Injectable()
export class ProductVariantsService {
  constructor(
    private readonly databaseService: DatabaseService,
    // Optional: absent = no sale-vs-Premium rule (behaves exactly as before).
    @Optional() private readonly premium?: PremiumEntitlementsService,
  ) {}

  private async loadOwnedPhysicalProduct(sellerId: string, productId: string) {
    const { productModel } = this.databaseService.repositories;
    const product = await productModel.findOne({ _id: productId, isDelete: false });
    if (!product) throw new NotFoundException('Product not found');
    if (product.sellerId !== sellerId) {
      throw new ForbiddenException('You are not authorized to manage this product');
    }
    if (product.type !== 'physical') {
      throw new BadRequestException('Only physical products support variants');
    }
    return product;
  }

  private async getActiveVariants(productId: string, excludeVariantId?: string) {
    const { productVariantModel } = this.databaseService.repositories;
    const filter: any = { productId, isDelete: false };
    if (excludeVariantId) filter._id = { $ne: excludeVariantId };
    return productVariantModel.find(filter).lean();
  }

  private assertConsistentAndUnique(
    existing: { options: VariantOptionInput[] }[],
    incoming: VariantOptionInput[],
  ) {
    const incomingKey = optionsKey(incoming);
    const incomingNameSet = optionNameSet(incoming);

    if (existing.length > 0) {
      const existingNameSet = optionNameSet(existing[0].options ?? []);
      if (incomingNameSet !== existingNameSet) {
        throw new BadRequestException(
          "This product's variants must all use the same attributes",
        );
      }
      const duplicate = existing.some((v) => optionsKey(v.options ?? []) === incomingKey);
      if (duplicate) {
        throw new BadRequestException(
          'A variant with this exact combination of attributes already exists',
        );
      }
    }
  }

  private async reassignDefault(productId: string, newDefaultVariantId: string) {
    const { productVariantModel } = this.databaseService.repositories;
    await productVariantModel.updateMany(
      { productId, _id: { $ne: newDefaultVariantId } },
      { isDefault: false },
    );
    await productVariantModel.findByIdAndUpdate(newDefaultVariantId, { isDefault: true });
  }

  async addVariant(sellerId: string, productId: string, dto: CreateVariantDto) {
    const { productVariantModel, storeModel } = this.databaseService.repositories;
    const product = await this.loadOwnedPhysicalProduct(sellerId, productId);

    // Stamped from the owning store's own pricing currency, not the
    // product/a sibling variant — same rule as ProductsService's
    // addPhysicalProduct/addDigitalProduct. Looked up fresh rather than
    // copied from an existing sibling variant so this stays correct even
    // if a legacy pre-migration variant's `currency` were ever null.
    const store = await storeModel.findOne({ _id: product.storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');

    assertPriceRules({ price: dto.price, compareAtPrice: dto.compareAtPrice, currency: store.baseCurrency });
    assertStockRule(dto.stock, !!dto.unlimitedStock);
    const weight = cleanShippingWeight(dto.shippingWeight, true);
    const options = dto.options ?? [];
    const existing = await this.getActiveVariants(productId);
    this.assertConsistentAndUnique(existing as any, options);
    await assertPremiumGap(this.premium, store as any, (product as any).premiumDiscountPercent, [{ price: dto.price, compareAtPrice: dto.compareAtPrice ?? null }]);

    const sku = cleanSku(dto.sku) || (await allocateSkus(storeModel, store as any, 1))[0];

    const variant = await productVariantModel.create({
      productId,
      sku,
      price: dto.price,
      currency: store.baseCurrency,
      compareAtPrice: dto.compareAtPrice ?? null,
      options,
      stock: dto.stock ?? 0,
      unlimitedStock: !!dto.unlimitedStock,
      shippingWeight: weight,
      images: dto.images ?? [],
      isDefault: existing.length === 0,
    });

    if (dto.isDefault && existing.length > 0) {
      await this.reassignDefault(productId, variant._id.toString());
    }

    return {
      success: true,
      message: 'Variant added successfully',
      data: await productVariantModel.findById(variant._id),
    };
  }

  async updateVariant(
    sellerId: string,
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
  ) {
    const { productVariantModel, storeModel } = this.databaseService.repositories;
    const ownedProduct = await this.loadOwnedPhysicalProduct(sellerId, productId);

    const variant = await productVariantModel.findOne({
      _id: variantId,
      productId,
      isDelete: false,
    });
    if (!variant) throw new NotFoundException('Variant not found');

    if (dto.price !== undefined || dto.compareAtPrice !== undefined) {
      const ruleStore = await storeModel.findOne({ _id: ownedProduct.storeId, isDelete: false }).select('baseCurrency').lean();
      assertPriceRules({
        price: dto.price !== undefined ? dto.price : (variant as any).price,
        compareAtPrice: dto.compareAtPrice !== undefined ? dto.compareAtPrice : (variant as any).compareAtPrice,
        currency: (ruleStore as any)?.baseCurrency,
      });
    }

    if (this.premium && (dto.price !== undefined || dto.compareAtPrice !== undefined)) {
      const store = await storeModel.findOne({ _id: ownedProduct.storeId, isDelete: false }).select('premiumDiscount').lean();
      await assertPremiumGap(this.premium, store as any, (ownedProduct as any).premiumDiscountPercent, [{
        price: dto.price !== undefined ? dto.price : (variant as any).price,
        compareAtPrice: dto.compareAtPrice !== undefined ? dto.compareAtPrice : (variant as any).compareAtPrice,
      }]);
    }

    if (dto.options !== undefined) {
      const others = await this.getActiveVariants(productId, variantId);
      this.assertConsistentAndUnique(others as any, dto.options);
    }

    if (dto.isDefault === false && variant.isDefault) {
      throw new BadRequestException(
        'Cannot unset the default variant directly — set another variant as default instead',
      );
    }

    const update: any = {};
    if (dto.price !== undefined) update.price = dto.price;
    if (dto.compareAtPrice !== undefined) update.compareAtPrice = dto.compareAtPrice;
    if (dto.options !== undefined) update.options = dto.options;
    if (dto.stock !== undefined) update.stock = dto.stock;
    if (dto.unlimitedStock !== undefined) update.unlimitedStock = !!dto.unlimitedStock;
    // Only checked when the request sends it, so old products without a weight stay editable; clearing it is rejected.
    if (dto.shippingWeight !== undefined) update.shippingWeight = cleanShippingWeight(dto.shippingWeight, true);
    if (dto.stock !== undefined) assertStockRule(dto.stock, dto.unlimitedStock !== undefined ? !!dto.unlimitedStock : !!(variant as any).unlimitedStock);
    if (dto.images !== undefined) update.images = dto.images;

    const updated =
      Object.keys(update).length > 0
        ? await productVariantModel.findByIdAndUpdate(variantId, update, { returnDocument: 'after' })
        : variant;

    if (dto.isDefault === true && !variant.isDefault) {
      await this.reassignDefault(productId, variantId);
      return {
        success: true,
        message: 'Variant updated successfully',
        data: await productVariantModel.findById(variantId),
      };
    }

    return { success: true, message: 'Variant updated successfully', data: updated };
  }

  async deleteVariant(sellerId: string, productId: string, variantId: string) {
    const { productVariantModel } = this.databaseService.repositories;
    await this.loadOwnedPhysicalProduct(sellerId, productId);

    const variant = await productVariantModel.findOne({
      _id: variantId,
      productId,
      isDelete: false,
    });
    if (!variant) throw new NotFoundException('Variant not found');

    const remaining = await this.getActiveVariants(productId, variantId);
    if (remaining.length === 0) {
      throw new BadRequestException(
        'Cannot delete the last variant — a product must have at least one variant',
      );
    }

    await productVariantModel.findByIdAndUpdate(variantId, {
      isDelete: true,
      isDefault: false,
    });

    if (variant.isDefault) {
      const cheapest = (remaining as any[]).reduce((a, b) => (a.price < b.price ? a : b));
      await this.reassignDefault(productId, cheapest._id.toString());
    }

    return {
      success: true,
      message: 'Variant deleted successfully',
      data: await this.getActiveVariants(productId),
    };
  }

  async listVariants(sellerId: string, productId: string) {
    await this.loadOwnedPhysicalProduct(sellerId, productId);
    return {
      success: true,
      message: 'Variants fetched successfully',
      data: await this.getActiveVariants(productId),
    };
  }
}
