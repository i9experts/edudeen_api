import {
  Injectable,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';

import {
  clampInt,
  escapeRegex,
  searchTerm,
} from 'src/common/query-safety.util';
const LOW_STOCK_THRESHOLD = 10;

@Injectable()
export class InventoryService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getStoreInventory(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const { productModel, productVariantModel, storeModel } =
      this.databaseService.repositories;

    // seller ka store he ya nahi
    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    // filters
    const filter: any = { storeId, sellerId, isDelete: false };
    if (query.type && query.type !== 'all') filter.type = query.type;
    if (query.status && query.status !== 'all') filter.status = query.status;

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

    const totalProducts = await productModel.countDocuments(filter);
    const totalPages = Math.ceil(totalProducts / limit);

    const products = await productModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // har product ke variants fetch karo
    const productIds = products.map((p: any) => p._id.toString());
    const allVariants = await productVariantModel
      .find({ productId: { $in: productIds }, isDelete: false })
      .lean();

    // productId → variants map
    const variantMap: Record<string, any[]> = {};
    for (const v of allVariants) {
      if (!variantMap[v.productId]) variantMap[v.productId] = [];
      variantMap[v.productId].push(v);
    }

    // Store-wide, unfiltered stats (one query + one threshold; see computeStockStats)
    const stats = await this.computeStockStats(storeId, sellerId);

    const productList = products.map((product: any) => {
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
        else if (totalStock <= LOW_STOCK_THRESHOLD) stockStatus = 'low_stock';
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
        images: product.images ?? [],
        type: product.type,
        productType: product.productType,
        stock: stockDisplay,
        stockStatus,
        status: product.status,
        scheduledAt: product.scheduledAt ?? null,
        // Why an admin sent the listing back (status 'rejected').
        reviewNote: (product as any).reviewNote ?? null,
        // A seller edit of this live listing is waiting for admin approval / was declined.
        hasPendingEdit: !!(product as any).pendingEdit?.submittedAt,
        editRejection: (product as any).lastEditRejection?.reason ?? null,
        price,
        compareAtPrice: defaultVariant?.compareAtPrice ?? null,
        allTimeSales: product.purchaseCount || 0,
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
        threshold: LOW_STOCK_THRESHOLD,
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
    const { stats } = await this.scanStock(storeId, sellerId);
    return stats;
  }

  private async scanStock(storeId: string, sellerId: string) {
    const { productModel, productVariantModel } = this.databaseService.repositories;
    const products = await productModel
      .find({ storeId, sellerId, isDelete: false })
      .select('name type')
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
    const items: { productId: any; name: string; stock: number }[] = [];
    for (const p of products as any[]) {
      const id = p._id.toString();
      if (p.type === 'digital' || unlimitedProducts.has(id)) {
        stats.unlimited++;
        continue;
      }
      const stock = stockByProduct.get(id) ?? 0;
      if (stock <= 0) stats.outOfStock++;
      else if (stock <= LOW_STOCK_THRESHOLD) {
        stats.lowStock++;
        items.push({ productId: p._id, name: p.name, stock });
      } else stats.inStock++;
    }
    items.sort((x, y) => x.stock - y.stock);
    return { stats, items };
  }}
