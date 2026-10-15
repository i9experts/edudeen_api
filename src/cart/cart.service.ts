/* eslint-disable prettier/prettier */
import { campaignsInCurrency, CampaignLinePrice, CartCampaignDiscount, pickBestCampaignForLine } from '../marketing/campaign-pricing.util';
import { campaignsForProduct } from '../marketing/campaign-eligibility.util';
import { isValidObjectId } from 'mongoose';
import { sanitizeDigitalForPublicView } from 'src/products/product-public-view.util';
import { Injectable, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';

import { DatabaseService } from 'src/database/databaseservice';
import { ExchangeRateService } from 'src/exchange-rate/exchange-rate.service';
import { SUPPORTED_CURRENCIES } from 'src/exchange-rate/schemas/exchange-rate.schema';
import { AddToCartDto, MAX_CART_LINE_QUANTITY } from './dto/add-to-cart.dto';
import { PremiumEntitlementsService } from 'src/premium/premium-entitlements.service';
import { premiumLinePrice, premiumPercentFor } from 'src/premium/premium.util';

/** Per-user cap so a wishlist can't grow without bound. */
const MAX_WISHLIST_ITEMS = 200;

/** Upper bound on store carts read in one request (checkout's own cap is lower, see Phase 2). */
const MAX_UNIFIED_CART_STORES = 100;

@Injectable()
export class CartService {
  // ExchangeRateService is optional so unit tests can build the service with only the database.
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional() private readonly exchangeRateService?: ExchangeRateService,
    @Optional() private readonly premium?: PremiumEntitlementsService,
  ) {}

  async addToCart(userId: string, requestedStoreId: string | undefined, dto: AddToCartDto) {
    try {
      const cartModel = this.databaseService.repositories.cartModel;
      const productModel = this.databaseService.repositories.productModel;
      const variantModel =
        this.databaseService.repositories.productVariantModel;

      // 1️⃣ Get product
      const product = await productModel.findById(dto.productId).lean();
      if (!product || product.isDelete || product.status !== 'active') {
        throw new BadRequestException('Product not found');
      }

      // The cart always belongs to the product's own store — a storefront
      // may only add its own products, and the main marketplace site
      // (no storeId) files each item under whichever store sells it.
      const storeId = product.storeId;
      if (requestedStoreId && requestedStoreId !== storeId) {
        throw new BadRequestException('This product is not sold by this store');
      }
      // Items of a pending/suspended store can't be added (checkout refuses them anyway, but they used to sit in carts).
      const storeLive = await this.databaseService.repositories.storeModel.exists({ _id: storeId, status: 'active', isDelete: false });
      if (!storeLive) throw new BadRequestException('Product not found');

      // 2️⃣ Get variant
      const variant = await variantModel.findById(dto.productVariantId).lean();
      if (!variant || variant.isDelete || variant.status !== 'active' || variant.productId !== dto.productId) {
        throw new BadRequestException('Product variant not found');
      }

      // 3️⃣ find cart — scoped to this store, so the same buyer's cart on a
      // different store's subdomain is a separate document
      let cart = await cartModel.findOne({ userId, storeId, isDelete: false });

      // 4️⃣ prepare cart item
      // Variant images are optional overrides — most variants have none, so
      // fall back to the product's images or the cart renders imageless items.
      const itemImages =
        variant.images && variant.images.length > 0
          ? variant.images
          : product.images || [];

      // Service-level guard as well as the DTO: a zero, negative or
      // fractional quantity would flow straight into checkout totals.
      const quantity = dto.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_CART_LINE_QUANTITY) {
        throw new BadRequestException(`Quantity must be a whole number between 1 and ${MAX_CART_LINE_QUANTITY}`);
      }

      const newItem = {
        productId: dto.productId,
        productVariantId: dto.productVariantId,
        name: product.name,
        quantity,
        price: variant.price,
        currency: variant.currency ?? null,
        images: itemImages,
        options: variant.options ?? [],
      };

      // 5️⃣ create cart if not exists
      if (!cart) {
        cart = await cartModel.create({
          userId,
          storeId,
          items: [newItem],
        });

        return {
          message: 'Cart created and item added successfully',
          data: cart,
        };
      }

      // 6️⃣ check existing item
      const existingIndex = cart.items.findIndex(
        (item) =>
          item.productId === dto.productId &&
          item.productVariantId === dto.productVariantId,
      );

      if (existingIndex > -1) {
        const merged = cart.items[existingIndex].quantity + quantity;
        if (merged > MAX_CART_LINE_QUANTITY) {
          throw new BadRequestException(`Quantity cannot exceed ${MAX_CART_LINE_QUANTITY}`);
        }
        cart.items[existingIndex].quantity = merged;
      } else {
        cart.items.push(newItem as any);
      }

      // 7️⃣ save cart
      await cart.save();

      return {
        message: 'Product added to cart successfully',
        data: cart,
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to add product to cart',
      );
    }
  }

  async updateCartQuantity(userId: string, storeId: string, requestBody: any) {
    try {
      const cartModel = this.databaseService.repositories.cartModel;

      const { productId, productVariantId, action } = requestBody;

      const cart = await cartModel.findOne({
        userId,
        storeId,
        isDelete: false,
      });

      if (!cart) {
        throw new BadRequestException('Cart not found');
      }

      const itemIndex = cart.items.findIndex(
        (item) =>
          item.productId === productId &&
          item.productVariantId === productVariantId,
      );

      if (itemIndex === -1) {
        throw new BadRequestException('Item not found in cart');
      }

      // 1️⃣ update quantity
      if (action === 'increase') {
        if (cart.items[itemIndex].quantity >= MAX_CART_LINE_QUANTITY) {
          throw new BadRequestException(`Quantity cannot exceed ${MAX_CART_LINE_QUANTITY}`);
        }
        cart.items[itemIndex].quantity += 1;
      } else if (action === 'decrease') {
        if (cart.items[itemIndex].quantity <= 1) {
          throw new BadRequestException('Quantity cannot be less than 1');
        }
        cart.items[itemIndex].quantity -= 1;
      } else {
        throw new BadRequestException('Invalid action');
      }

      await cart.save();

      // 2️⃣ sirf updated item return karo
      const updatedItem = cart.items[itemIndex];

      return {
        message: 'Cart quantity updated successfully',
        data: updatedItem,
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to update quantity',
      );
    }
  }
  async getCart(userId: string, storeId: string) {
    try {
      // User ka cart find karo (is store ke liye)
      const cart = await this.databaseService.repositories.cartModel.findOne({
        userId,
        storeId,
        isDelete: false,
      });

      // Agar cart nahi mila
      if (!cart) {
        return {
          message: 'Cart is empty',
          data: {
            userId,
            storeId,
            items: [],
            totalItems: 0,
            totalPrice: 0,
          },
        };
      }

      let totalItems = 0;
      let totalPrice = 0;

      // Cart items only snapshot name/price/images — sellerId isn't stored on
      // the item, so every item's product doc is batch-fetched (also backfills
      // `images` for items stored before the add-to-cart image fallback existed).
      const productIds = [
        ...new Set(cart.items.map((item: any) => item.productId)),
      ];
      const products = productIds.length
        ? await this.databaseService.repositories.productModel
            .find({ _id: { $in: productIds } })
            .select('images sellerId status isDelete storeId type premiumDiscountPercent premiumOptOut campaignIds')
            .lean()
        : [];
      const productById = new Map(
        (products as any[]).map((p) => [p._id.toString(), p]),
      );

      const sellerIds = [
        ...new Set(
          (products as any[]).map((p) => p.sellerId).filter(Boolean),
        ),
      ];
      const sellers = sellerIds.length
        ? await this.databaseService.repositories.sellerModel
            .find({ _id: { $in: sellerIds } })
            .select('name isVerified')
            .lean()
        : [];
      const sellerMap = new Map(
        sellers.map((s: any) => [s._id.toString(), s]),
      );

      // A listing an admin removed (or that is no longer active) must not stay in the cart, priced and counted.
      const liveItems = cart.items.filter((item: any) => {
        const p = productById.get(item.productId);
        return !!p && !p.isDelete && p.status === 'active';
      });

      // Price from the variant's CURRENT price (the same source checkout charges), not the
      // snapshot taken when the item was added — a sale started/ended since then must show here.
      const variantIds = [...new Set(liveItems.map((item: any) => item.productVariantId))];
      const variants = variantIds.length
        ? await this.databaseService.repositories.productVariantModel
            .find({ _id: { $in: variantIds } })
            .select('price currency compareAtPrice')
            .lean()
        : [];
      const livePriceByVariant = new Map((variants as any[]).map((v) => [v._id.toString(), v.price as number]));
      const compareAtByVariant = new Map((variants as any[]).map((v) => [v._id.toString(), (v.compareAtPrice as number | null) ?? null]));
      const liveCurrencyByVariant = new Map((variants as any[]).map((v) => [v._id.toString(), (v.currency as string | null) ?? null]));
      // A store sells in ONE currency, so the cart has one: the currency every amount in this response is in.
      const cartCurrency: string =
        liveItems.map((i: any) => liveCurrencyByVariant.get(i.productVariantId) ?? i.currency).find((c) => !!c) ?? 'PKR';

      // Cart items map karo
      const items = liveItems.map((item) => {
        const unitPrice = livePriceByVariant.get(item.productVariantId) ?? item.price;
        // Ek item ka total
        const itemTotal = unitPrice * item.quantity;

        // Overall totals me add karo
        totalItems += item.quantity;
        totalPrice += itemTotal;

        const product = productById.get(item.productId);
        const seller = product
          ? sellerMap.get(product.sellerId?.toString())
          : undefined;

        const images =
          item.images && item.images.length > 0
            ? item.images
            : product?.images || [];

        return {
          productId: item.productId,
          productVariantId: item.productVariantId,

          name: item.name,
          sellerName: seller ? seller.name : null,
          sellerVerified: seller ? !!seller.isVerified : false,

          image: images,
          options: (item as any).options ?? [],

          currency: (item as any).currency ?? null,
          // physical | digital, from the product itself: checkout skips the address steps for an all-digital cart, so
          // this must not depend on what this browser remembers.
          type: product?.type === 'physical' || product?.type === 'digital' ? product.type : undefined,
          unitPrice, // single product price (live)
          quantity: item.quantity, // quantity
          itemTotal: itemTotal, // quantity × price
        };
      });

      // The store's running sales (admin campaigns) - the same rules checkout applies, priced PER LINE (owner rules R1/R2):
      // only products the seller ticked for the campaign are in it, the offer is computed from the LIST price
      // (compare-at when above the price) and applies only when strictly cheaper than the normal price.
      const realNow = new Date();
      // Premium early access: an active member's cart already prices a campaign that starts within their earlyAccessHours.
      const premiumEnt = this.premium ? await this.premium.getEntitlements(userId) : null;
      const now = premiumEnt?.isPremium && premiumEnt.earlyAccessHours > 0 ? new Date(realNow.getTime() + premiumEnt.earlyAccessHours * 3_600_000) : realNow;
      // Edudeen Premium price per line (owner rules R1/R2): a member's line is priced at LIST x (1 - seller% - platform%) and gets
      // no campaign / compare-at sale on top - checkout charges the same number and is the source of truth.
      const premiumStores = this.premium ? await this.premium.loadStoreSettings([storeId]) : new Map<string, any>();
      const premiumTerms = this.premium ? await this.premium.getTerms() : null;
      const lineKey = (i: { productId: string; productVariantId: string }) => `${i.productId}:${i.productVariantId}`;
      const premiumLines = new Map<string, { calc: ReturnType<typeof premiumLinePrice>; sellerPct: number }>();
      const sellerPctOf = (productId: string) => (this.premium ? premiumPercentFor(productById.get(productId) as any, premiumStores.get(String(storeId))) : 0);
      const rawCampaigns = await this.databaseService.repositories.campaignModel
        .find({
          isDelete: false, status: 'active', startDate: { $lte: now }, endDate: { $gte: realNow },
          $or: [{ sponsorType: 'platform' }, { participatingStoreIds: { $in: [storeId] } }],
        })
        .select('name endDate discountType discountValue currency sponsorType')
        .lean();
      const cartCampaigns = await campaignsInCurrency(
        rawCampaigns as any[], cartCurrency,
        this.exchangeRateService ? (amount, from, to) => this.exchangeRateService!.convert(amount, from, to) : undefined,
      );
      const campaignMeta = new Map(cartCampaigns.map((c) => [c.campaignId, c]));
      const campaignLines = new Map<string, CampaignLinePrice>();
      for (const i of items) {
        const mine = campaignsForProduct(cartCampaigns, (productById.get(i.productId) as any)?.campaignIds);
        const r = pickBestCampaignForLine(mine, i.unitPrice, compareAtByVariant.get(i.productVariantId) ?? null);
        if (r) campaignLines.set(lineKey(i), r);
      }
      // Premium competes with the normal pipeline: a member's line gets the premium price only when it is strictly lower than
      // what a normal buyer pays for the same line (the campaign price when one applies); otherwise the campaign price shows.
      // Checkout makes the same comparison.
      if (premiumEnt?.isPremium && premiumTerms) {
        for (const i of items) {
          const sellerPct = sellerPctOf(i.productId);
          if (!sellerPct) continue;
          const calc = premiumLinePrice(i.unitPrice, compareAtByVariant.get(i.productVariantId), sellerPct, premiumTerms.platformPercent);
          if (!calc.applies) continue;
          const normalUnit = campaignLines.get(lineKey(i))?.unit ?? i.unitPrice;
          if (calc.unit < normalUnit) { premiumLines.set(lineKey(i), { calc, sellerPct }); campaignLines.delete(lineKey(i)); }
        }
      }
      // Cart summary: one total; the label is the campaign that contributes the most.
      const campaignTotals = new Map<string, number>();
      let campaignAmount = 0;
      for (const i of items) {
        const r = campaignLines.get(lineKey(i));
        if (!r) continue;
        const amt = Math.round(r.discount * i.quantity * 100) / 100;
        campaignAmount = Math.round((campaignAmount + amt) * 100) / 100;
        campaignTotals.set(r.campaign.campaignId, Math.round(((campaignTotals.get(r.campaign.campaignId) ?? 0) + amt) * 100) / 100);
      }
      const topCampaignId = [...campaignTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const topCampaign = topCampaignId ? campaignMeta.get(topCampaignId) : undefined;
      const campaignDiscount: CartCampaignDiscount | null = topCampaign && campaignAmount > 0
        ? { campaignId: topCampaign.campaignId, name: topCampaign.name, amount: campaignAmount, currency: cartCurrency, discountType: topCampaign.discountType, discountValue: topCampaign.origValue, valueCurrency: topCampaign.valueCurrency }
        : null;
      // Edudeen Premium: the seller's chosen member discount. Everyone gets the teaser `premiumPercent`; only an active
      // member gets `premiumUnitPrice` / `premiumDiscountPercent` (display only - checkout is the source of truth).
      let premiumSavings = 0;
      let premiumPlatformFunded = 0;
      const itemsWithFlag = items.map((i) => {
        const pl = premiumLines.get(lineKey(i));
        const cl = campaignLines.get(lineKey(i));
        const base = {
          ...i, onCampaign: !pl && !!cl,
          ...(!pl && cl ? { campaignId: cl.campaign.campaignId, campaignUnitPrice: cl.unit, campaignItemTotal: Math.round(cl.unit * i.quantity * 100) / 100, listPrice: cl.listUnit } : {}),
        };
        const pct = sellerPctOf(i.productId);
        if (!pct) return base;
        // Teaser for everyone: seller% + platform% combined, with the breakdown.
        const teaser = { premiumPercent: Math.round((pct + (premiumTerms?.platformPercent ?? 0)) * 100) / 100, premiumSellerPercent: pct, premiumPlatformPercent: premiumTerms?.platformPercent ?? 0 };
        if (!pl) return { ...base, ...teaser };
        const unit = pl.calc.unit;
        premiumSavings += (i.unitPrice - unit) * i.quantity;
        premiumPlatformFunded += pl.calc.platformUnitDiscount * i.quantity;
        return {
          ...base, ...teaser, premiumDiscountPercent: pl.calc.totalPercent, premiumUnitPrice: unit,
          premiumItemTotal: Math.round(unit * i.quantity * 100) / 100, listPrice: pl.calc.listUnit,
        };
      });
      // Final response
      return {
        message: 'Cart fetched successfully',
        data: {
          userId,
          storeId,
          items: itemsWithFlag,
          totalItems,
          totalPrice,
          currency: cartCurrency,
          campaignDiscount,
          totalAfterDiscount: Math.round((totalPrice - (campaignDiscount?.amount ?? 0)) * 100) / 100,
          ...(premiumEnt?.isPremium ? { isPremium: true, premiumSavings: Math.round(premiumSavings * 100) / 100, premiumPlatformFunded: Math.round(premiumPlatformFunded * 100) / 100 } : {}),
        },
      };
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to fetch cart');
    }
  }

  /** Every non-empty cart the buyer has, one per store (the shared source for
   *  `getMyCarts` and `getUnifiedCart`). Carts of deleted stores are skipped. */
  private async collectStoreCarts(userId: string) {
    const carts = await this.databaseService.repositories.cartModel
      .find({ userId, isDelete: false, 'items.0': { $exists: true } })
      .select('storeId')
      .sort({ updatedAt: -1 })
      .limit(MAX_UNIFIED_CART_STORES)
      .lean();
    const storeIds = [...new Set((carts as any[]).map((c) => c.storeId).filter(Boolean))];
    if (storeIds.length === 0) return [];

    const stores = await this.databaseService.repositories.storeModel
      .find({ _id: { $in: storeIds }, isDelete: false })
      .select('name slug logo status baseCurrency')
      .lean();
    const storeById = new Map((stores as any[]).map((s) => [s._id.toString(), s]));

    const rows: { cart: any; store: any; storeId: string }[] = [];
    for (const storeId of storeIds) {
      const store = storeById.get(storeId);
      if (!store) continue;
      const { data: cart } = await this.getCart(userId, storeId);
      rows.push({ cart, store, storeId });
    }
    return rows;
  }

  /** Every non-empty cart the buyer has, one per store — the main
   *  marketplace site shows them together. */
  async getMyCarts(userId: string) {
    const rows = await this.collectStoreCarts(userId);
    if (rows.length === 0) return { message: 'Cart is empty', data: [] };
    const data = rows.map(({ cart, store, storeId }) => ({
      ...cart,
      store: { storeId, name: store.name, slug: store.slug, logo: store.logo ?? null, isActive: store.status === 'active' },
    }));
    return { message: 'Carts fetched successfully', data };
  }

  /** The buyer's display currency: an explicit, allow-listed request, else
   *  their saved preference (PKR for buyers who never set one — same default
   *  as checkout). Never trusted blindly from the client. */
  private async resolveDisplayCurrency(userId: string, requested?: string): Promise<string> {
    if (requested) {
      if (!SUPPORTED_CURRENCIES.includes(requested as any)) {
        throw new BadRequestException(
          `Unsupported currency "${requested}" — must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
        );
      }
      return requested;
    }
    const user = await this.databaseService.repositories.userModel.findById(userId).select('currencyPreference').lean();
    return (user as any)?.currencyPreference ?? 'PKR';
  }

  /** One flat list of every line across all of the buyer's store carts, with
   *  per-store subtotals and a grand total in the buyer's display currency.
   *  Read-only view over the existing per-store carts; prices are the
   *  add-to-cart snapshots (like `get-cart`) — checkout re-prices from the DB.
   *  If no usable exchange rates exist for a mixed-currency cart, lines keep
   *  their native currency and the converted totals are null rather than the
   *  whole cart failing to load. */
  async getUnifiedCart(userId: string, requestedCurrency?: string) {
    const displayCurrency = await this.resolveDisplayCurrency(userId, requestedCurrency);
    const rows = await this.collectStoreCarts(userId);
    if (rows.length === 0) {
      return {
        message: 'Cart is empty',
        data: { displayCurrency, conversionAvailable: true, items: [], stores: [], totalItems: 0, grandTotal: 0 },
      };
    }

    const lineCurrency = (item: any, store: any) => item.currency ?? store.baseCurrency ?? displayCurrency;
    const currencies = new Set<string>([displayCurrency]);
    for (const { cart, store } of rows) {
      for (const item of cart.items) currencies.add(lineCurrency(item, store));
    }

    let snapshots: any[] | null = null;
    try {
      snapshots = await this.exchangeRateService!.buildSnapshots([...currencies]);
    } catch {
      snapshots = null; // stale/missing rates — fall back to native amounts
    }
    const convert = (amount: number, from: string): number | null => {
      if (from === displayCurrency) return amount;
      if (!snapshots) return null;
      try {
        return this.exchangeRateService!.convertWithSnapshots(amount, from, displayCurrency, snapshots);
      } catch {
        return null;
      }
    };

    const items: any[] = [];
    const stores: any[] = [];
    let totalItems = 0;
    let grandTotal: number | null = 0;

    for (const { cart, store, storeId } of rows) {
      const storeInfo = { storeId, name: store.name, slug: store.slug, logo: store.logo ?? null, isActive: store.status === 'active' };
      let storeSubtotal: number | null = 0;
      let storeItemCount = 0;
      for (const item of cart.items) {
        const currency = lineCurrency(item, store);
        const displayItemTotal = convert(item.itemTotal, currency);
        const displayUnitPrice = convert(item.unitPrice, currency);
        storeSubtotal = storeSubtotal === null || displayItemTotal === null ? null : storeSubtotal + displayItemTotal;
        storeItemCount += item.quantity;
        items.push({ ...item, currency, storeId, store: storeInfo, displayUnitPrice, displayItemTotal });
      }
      storeSubtotal = storeSubtotal === null ? null : Math.round(storeSubtotal * 100) / 100;
      grandTotal = grandTotal === null || storeSubtotal === null ? null : grandTotal + storeSubtotal;
      totalItems += storeItemCount;
      stores.push({ ...storeInfo, totalItems: storeItemCount, subtotal: storeSubtotal });
    }
    if (grandTotal !== null) grandTotal = Math.round(grandTotal * 100) / 100;

    return {
      message: 'Unified cart fetched successfully',
      data: { displayCurrency, conversionAvailable: grandTotal !== null, items, stores, totalItems, grandTotal },
    };
  }

  /** Empties every cart the buyer owns (all stores). Owner-scoped by userId. */
  async clearAllCarts(userId: string) {
    const res = await this.databaseService.repositories.cartModel.updateMany(
      { userId, isDelete: false, 'items.0': { $exists: true } },
      { $set: { items: [] } },
    );
    return { message: 'All carts cleared successfully', data: { cartsCleared: res.modifiedCount } };
  }

  async removeCartItem(userId: string, storeId: string, requestBody: any) {
    try {
      const cartModel = this.databaseService.repositories.cartModel;

      const { productId, productVariantId } = requestBody;

      const cart = await cartModel.findOne({
        userId,
        storeId,
        isDelete: false,
      });

      if (!cart) {
        throw new BadRequestException('Cart not found');
      }

      // 1️⃣ find item index
      const itemIndex = cart.items.findIndex(
        (item) =>
          item.productId === productId &&
          item.productVariantId === productVariantId,
      );

      if (itemIndex === -1) {
        throw new BadRequestException('Item not found in cart');
      }

      // 2️⃣ remove item
      cart.items.splice(itemIndex, 1);

      // 3️⃣ save cart
      await cart.save();

      return {
        message: 'Item removed from cart successfully',
        data: cart.items, // sirf updated cart items return
      };
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to remove item');
    }
  }

  async clearCart(userId: string, storeId: string) {
    try {
      const cartModel = this.databaseService.repositories.cartModel;

      const cart = await cartModel.findOne({
        userId,
        storeId,
        isDelete: false,
      });

      if (!cart) {
        throw new BadRequestException('Cart not found');
      }

      // 🗑️ sare cart items remove
      cart.items = [];

      await cart.save();

      return {
        message: 'Cart cleared successfully',
        data: cart.items,
      };
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to clear cart');
    }
  }

  /** The product exactly as a public browser may see it: live product, live store, no private digital data.
   *  (The wishlist used to return raw `findById` documents — file manifests and delivery messages included —
   *  for drafts, deleted and admin-removed products alike.) */
  private async loadViewableProduct(productId: string) {
    if (typeof productId !== 'string' || !isValidObjectId(productId)) return null;
    const { productModel, storeModel } = this.databaseService.repositories;
    const product = await productModel.findOne({ _id: productId, status: 'active', isDelete: false }).lean();
    if (!product) return null;
    const live = await storeModel.exists({ _id: product.storeId, status: 'active', isDelete: false });
    return live ? sanitizeDigitalForPublicView(product) : null;
  }

  private async loadVariantLean(variantId: string) {
    if (typeof variantId !== 'string' || !isValidObjectId(variantId)) return null;
    return this.databaseService.repositories.productVariantModel.findOne({ _id: variantId, isDelete: false }).lean();
  }

  // Wishlist is saved per store (the item's own store), but the buyer's
  // main-site wishlist spans every store — so storeId is taken from the
  // product when adding, and optional (= all stores) when reading/removing.
  async addToWishlist(userId: string, storeId: string | undefined, body: any) {
    try {
      const { productId, productVariantId } = body ?? {};

      // Validate what is being wishlisted: a real, live product; a variant OF that product; and the store is
      // taken from the product (a mismatched client storeId used to slip past the unique index and inflate
      // wishlistCount on any product). Capped per user.
      const product = await this.loadViewableProduct(productId);
      if (!product) throw new BadRequestException('Product not found');
      if (storeId && storeId !== product.storeId) throw new BadRequestException('This product is not sold by this store');
      const variant = await this.loadVariantLean(productVariantId);
      if (!variant || variant.productId !== productId || variant.status !== 'active') {
        throw new BadRequestException('Product variant not found');
      }
      storeId = product.storeId;

      const { wishListModel, productModel } = this.databaseService.repositories;
      const view = () => ({ product, variant });

      const wishlistItem = await wishListModel.findOne({ userId, storeId, productId, productVariantId });
      if (wishlistItem) {
        return { message: 'Product already in wishlist', data: { wishlist: wishlistItem, ...view() } };
      }
      if ((await wishListModel.countDocuments({ userId })) >= MAX_WISHLIST_ITEMS) {
        throw new BadRequestException(`Your wishlist is full (${MAX_WISHLIST_ITEMS} items) — remove something first`);
      }

      // Guarded by a unique index on {userId, storeId, productId, productVariantId} for the race window
      // between the findOne above and this create() (e.g. a double-tap).
      let newItem;
      try {
        newItem = await wishListModel.create({ userId, storeId, productId, productVariantId });
      } catch (err: any) {
        if (err?.code === 11000) {
          const existing = await wishListModel.findOne({ userId, storeId, productId, productVariantId });
          return { message: 'Product already in wishlist', data: { wishlist: existing, ...view() } };
        }
        throw err;
      }

      await productModel.findByIdAndUpdate(productId, { $inc: { wishlistCount: 1 }, lastWishlistedAt: new Date() });

      return { message: 'Product added to wishlist successfully', data: { wishlist: newItem, ...view() } };
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to add to wishlist');
    }
  }

  async getWishlist(userId: string, storeId?: string) {
    try {
      // User wishlist — one store, or every store on the main site.
      const wishlist = await this.databaseService.repositories.wishListModel
        .find({ userId, ...(storeId ? { storeId } : {}) })
        .sort({ createdAt: -1 })
        .limit(MAX_WISHLIST_ITEMS);

      const groupedWishlist: any[] = [];
      for (const item of wishlist) {
        // Removed / draft / suspended-store products silently drop out instead of being served.
        const product = await this.loadViewableProduct(item.productId);
        if (!product) continue;
        const variant = await this.loadVariantLean(item.productVariantId);

        const existingProduct = groupedWishlist.find((data) => data.product._id.toString() === product._id.toString());
        if (existingProduct) {
          if (variant) existingProduct.variants.push(variant);
        } else {
          groupedWishlist.push({ product, variants: variant ? [variant] : [] });
        }
      }

      return { message: 'Wishlist fetched successfully', data: groupedWishlist };
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to fetch wishlist');
    }
  }

  async getWishlistItem(userId: string, storeId: string | undefined, query: any) {
    try {
      const productId = typeof query?.productId === 'string' ? query.productId : undefined;
      const productVariantId = typeof query?.productVariantId === 'string' ? query.productVariantId : undefined;
      if (!productId || !productVariantId) throw new BadRequestException('productId and productVariantId are required');

      const wishlistItem = await this.databaseService.repositories.wishListModel.findOne({
        userId, ...(storeId ? { storeId } : {}), productId, productVariantId,
      });
      if (!wishlistItem) return { message: 'Wishlist item not found', data: null };

      const product = await this.loadViewableProduct(productId);
      const variant = await this.loadVariantLean(productVariantId);
      return { message: 'Wishlist item fetched successfully', data: { wishlist: wishlistItem, product, variant } };
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to fetch wishlist item');
    }
  }

  async removeFromWishlist(userId: string, storeId: string | undefined, wishlistId: string) {
    try {
      // 1. find wishlist item
      const wishlistItem =
        await this.databaseService.repositories.wishListModel.findById(
          wishlistId,
        );

      if (!wishlistItem) {
        throw new BadRequestException('Wishlist item not found');
      }
      if (wishlistItem.userId !== userId || (storeId && wishlistItem.storeId !== storeId)) {
        throw new ForbiddenException('Access denied');
      }

      // 2. delete wishlist item
      await this.databaseService.repositories.wishListModel.findByIdAndDelete(
        wishlistId,
      );

      // 3. decrease wishlist count in product
      await this.databaseService.repositories.productModel.findByIdAndUpdate(
        wishlistItem.productId,
        {
          $inc: { wishlistCount: -1 },
        },
      );

      return {
        message: 'Product removed from wishlist successfully',
        data: {
          removedWishlistId: wishlistId,
          productId: wishlistItem.productId,
        },
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to remove from wishlist',
      );
    }
  }

  async clearWishlist(userId: string, storeId?: string) {
    try {
      const wishlistModel = this.databaseService.repositories.wishListModel;
      const scope = { userId, ...(storeId ? { storeId } : {}) };

      // 🔍 check if user has any wishlist items (in this store, or anywhere)
      const wishlistItems = await wishlistModel.find(scope);

      if (!wishlistItems.length) {
        throw new BadRequestException('Wishlist is already empty');
      }

      // 🗑️ delete all wishlist items of this user (in this store, or anywhere)
      await wishlistModel.deleteMany(scope);

      // 📉 update wishlist count in all related products
      const productModel = this.databaseService.repositories.productModel;

      for (const item of wishlistItems) {
        await productModel.findByIdAndUpdate(item.productId, {
          $inc: { wishlistCount: -1 },
        });
      }

      return {
        message: 'Wishlist cleared successfully',
        data: {
          deletedCount: wishlistItems.length,
        },
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to clear wishlist',
      );
    }
  }
}
