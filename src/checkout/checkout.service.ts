import { bundleSavings } from '../classroom/bundle.util';
import { paidSeatFilter } from '../classroom/course.util';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { licenseFromVariant } from 'src/products/product-input.util';
import { DatabaseService } from 'src/database/databaseservice';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';
import { MarketingService } from 'src/marketing/marketing.service';
import { campaignsForProduct } from 'src/marketing/campaign-eligibility.util';
import { campaignsInCurrency, pickBestCampaignForLine } from 'src/marketing/campaign-pricing.util';
import { AdminConfigService } from 'src/admin-config/admin-config.service';
import { ExchangeRateService } from 'src/exchange-rate/exchange-rate.service';
import { SUPPORTED_CURRENCIES, FxSnapshot } from 'src/exchange-rate/schemas/exchange-rate.schema';
import { GiftCardsService } from 'src/gift-cards/gift-cards.service';
import { DiscountsService } from 'src/discounts/discounts.service';
import { configuredHostedProviderIds } from 'src/payment/providers/hosted-providers.registry';
import { DEFAULT_PK_ZONES, missingDefaultZones } from './default-pk-zones';
import { sanitizeGiftOptions } from './gift-options.util';
import { PremiumEntitlementsService } from 'src/premium/premium-entitlements.service';
import { applyPremiumToLine, DEFAULT_PREMIUM_TERMS, premiumPercentFor } from 'src/premium/premium.util';

// Shipping zones are a Pakistan-domestic geography feature (predates the
// PKR/USD split entirely) — ShippingZone.shippingPrice has no currency
// field of its own because every zone was always implicitly priced in PKR.
// Rather than add a schema field for something that's effectively one fixed
// currency by design, this constant documents that assumption at its one
// point of use (addShippingInCheckout) instead.
const SHIPPING_ZONE_CURRENCY = 'PKR';

/** Upper bounds on one multi-store checkout — each line costs several DB reads. */
export const MAX_CHECKOUT_STORES = 20;
export const MAX_CHECKOUT_LINES = 100;

@Injectable()
export class CheckoutService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly subscriptionBenefits: SubscriptionBenefitsService,
    private readonly marketingService: MarketingService,
    private readonly adminConfigService: AdminConfigService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly giftCardsService: GiftCardsService,
    private readonly discountsService: DiscountsService,
    // Edudeen Premium (member price + campaign early access). Optional: absent = everything behaves as before.
    @Optional() private readonly premium?: PremiumEntitlementsService,
  ) {}

  private round(n: number) {
    return Math.round(n * 100) / 100;
  }

  /** Sums `items[].totalPrice` (each still in its OWN native seller
   *  currency) by converting every line into `checkoutCurrency`
   *  individually first — never summing raw native-currency numbers across
   *  items that can belong to different-currency sellers. Uses the
   *  checkout's own already-frozen `fxSnapshots`, never a fresh live rate. */
  private convertedSubtotal(items: any[], checkoutCurrency: string, fxSnapshots: FxSnapshot[]) {
    return this.round(
      items.reduce(
        (sum, i) =>
          sum +
          this.exchangeRateService.convertWithSnapshots(
            i.totalPrice,
            i.currency ?? checkoutCurrency,
            checkoutCurrency,
            fxSnapshots ?? [],
          ),
        0,
      ),
    );
  }

  /** Digital/physical subtotal split — used so the app can show "pay this
   *  much online now" vs "this much COD on delivery" for a mixed cart. Both
   *  numbers are read straight off `item.totalPrice`, which already has
   *  subscriber/campaign/coupon discounts baked in, so this stays correct
   *  after `applyCoupon`/`removeCoupon` mutate `items` in place. */
  private splitSubtotalsByType(items: any[]) {
    const digitalSubtotal = this.round(
      items.filter((i) => i.type === 'digital').reduce((s, i) => s + i.totalPrice, 0),
    );
    const physicalSubtotal = this.round(
      items.filter((i) => i.type === 'physical').reduce((s, i) => s + i.totalPrice, 0),
    );
    return { digitalSubtotal, physicalSubtotal };
  }

  async deleteCheckout(userId: string, checkoutId: string) {
    const { checkoutModel } = this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });
    if (!checkout) throw new BadRequestException('Checkout not found');

    if (checkout.paymentType !== null)
      throw new BadRequestException(
        'Cannot delete checkout after payment attempt',
      );

    await checkoutModel.deleteOne({ _id: checkoutId });

    return { success: true, message: 'Checkout deleted successfully' };
  }

  /**
   * Resolves the buyer's checkout currency: an explicit request-time
   * preference wins, then the buyer's saved account preference (see
   * User.currencyPreference), then 'PKR' as the last resort (Edudeen is
   * Pakistan-origin, so this matches historical behavior most closely for
   * any caller that hasn't been updated to send a preference yet). Always
   * validated against the supported-currency allow-list — never trusted
   * blindly from the client.
   */
  private async resolveCheckoutCurrency(userId: string, requested?: string | null): Promise<string> {
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

  /** Validates the Buy Now selection from the request body (null when absent, 400 when malformed). */
  private parseBuyNow(raw: any): { productId: string; variantId: string; quantity: number } | null {
    if (raw === undefined || raw === null) return null;
    const productId = typeof raw.productId === 'string' ? raw.productId : '';
    const variantId = typeof raw.variantId === 'string' ? raw.variantId : '';
    const quantity = Number(raw.quantity ?? 1);
    if (!/^[a-f0-9]{24}$/i.test(productId) || !/^[a-f0-9]{24}$/i.test(variantId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new BadRequestException('Invalid Buy Now selection');
    }
    return { productId, variantId, quantity };
  }

  async createCheckout(userId: string, body: any = {}) {
    const {
      cartModel,
      productModel,
      productVariantModel,
      addressModel,
      checkoutModel,
      storeModel,
    } = this.databaseService.repositories;

    const checkoutCurrency = await this.resolveCheckoutCurrency(userId, body.currencyPreference);

    // Carts are stored one document per (buyer, store). With a storeId (a store's own
    // subdomain storefront) the checkout is that store's cart only — exactly as
    // before. Without one (the main marketplace) it spans ALL of the buyer's
    // non-empty carts, so a buyer pays once for items from any number of stores.
    const { storeId } = body;
    // Buy Now: exactly one line the buyer chose on the product page. It never touches the cart
    // (the cart may be empty, and nothing is added to or removed from it); stock, price, campaign
    // and Premium rules are applied to the line below like any other.
    const buyNowLine = this.parseBuyNow(body.buyNow);
    const unifiedCheckout = !storeId && !buyNowLine;
    let cartItems: any[];
    if (buyNowLine) {
      cartItems = [{ productId: buyNowLine.productId, productVariantId: buyNowLine.variantId, quantity: buyNowLine.quantity }];
    } else if (!unifiedCheckout) {
      const cart = await cartModel.findOne({
        userId,
        storeId,
        status: 'active',
        isDelete: false,
      });
      if (!cart) throw new BadRequestException('Cart not found');
      if (!cart.items || cart.items.length === 0)
        throw new BadRequestException('Cart is empty');
      cartItems = cart.items;
    } else {
      const carts = await cartModel
        .find({ userId, status: 'active', isDelete: false, 'items.0': { $exists: true } })
        .sort({ updatedAt: -1 })
        .limit(MAX_CHECKOUT_STORES + 1)
        .lean();
      if (carts.length === 0) throw new BadRequestException('Cart is empty');
      cartItems = (carts as any[]).flatMap((c) => c.items);
    }

    // agar items array diya to sirf woh, warna sab cart items
    // A selection may carry an explicit quantity (Buy Now: exactly what the buyer
    // chose, whatever else sits in the cart). Stock/price are still validated per
    // line below; the cart document itself is not modified here.
    const selectedItems: any[] =
      !buyNowLine && body.items && Array.isArray(body.items) && body.items.length > 0
        ? cartItems
            .map((cartItem: any) => {
              const sel = body.items.find(
                (s: any) => s.productId === cartItem.productId && s.variantId === cartItem.productVariantId,
              );
              if (!sel) return null;
              const q = Number(sel.quantity);
              return Number.isInteger(q) && q >= 1 && q <= 99 ? { ...(cartItem.toObject?.() ?? cartItem), quantity: q } : cartItem;
            })
            .filter(Boolean)
        : cartItems;

    if (selectedItems.length === 0)
      throw new BadRequestException('None of the provided items found in cart');

    // Bound the cost of one request (each line costs several DB reads). Checked
    // before any per-line work. Cart lines carry no storeId, so the store count is
    // checked again below, once each product's own store is known.
    if (unifiedCheckout && selectedItems.length > MAX_CHECKOUT_LINES) {
      throw new BadRequestException(
        `A checkout can have at most ${MAX_CHECKOUT_LINES} items — remove some, or select fewer items to check out`,
      );
    }

    const checkoutItems: any[] = [];
    let hasPhysical = false;

    // Cache one lookup per store so a multi-item cart from the same store
    // doesn't re-query the buyer's subscription per item.
    // Pre-filled in ONE batched query below (was one per store, plus again for shipping).
    const benefitsCache = new Map<
      string,
      { benefits: any[]; planName: string } | null
    >();
    const getBenefits = async (storeId: string) => benefitsCache.get(storeId) ?? null;

    let subscriberSavingsUSD = 0;

    // Store docs (status, COD flag, direct-payment details) for every store in the
    // cart + the checkout store, loaded once and reused below.
    const storeDocById = new Map<string, any>();
    const isStoreActive = async (storeId: string): Promise<boolean> => {
      const s = storeDocById.get(String(storeId));
      return !!s && !s.isDelete && s.status === 'active';
    };

    // Pass 1: resolve product/variant, validate stock, and compute each
    // store's RAW (pre-discount) subtotal. A discount benefit's
    // `minOrderValueUSD` must be checked against the order value, but the
    // order value isn't known until every line in the cart has been priced —
    // so resolving and applying the discount in a single pass (as before)
    // meant `minOrderValueUSD` was accepted by the API/DTO but never actually
    // enforced; every subscriber discount applied unconditionally regardless
    // of cart size.
    const rawItems: Array<{ product: any; variant: any; cartItem: any }> = [];
    const unavailableItems: Array<{ productId: string; variantId: string; storeId: string; name: string; reason: string }> = [];
    const storeSubtotals = new Map<string, number>();

    // One query for all products and one for all variants instead of two per cart line
    // (each round trip to the database costs real time on a hosted cluster).
    const [pricedProducts, pricedVariants] = await Promise.all([
      productModel.find({ _id: { $in: [...new Set(selectedItems.map((i: any) => i.productId))] }, status: 'active', isDelete: false }),
      productVariantModel.find({ _id: { $in: [...new Set(selectedItems.map((i: any) => i.productVariantId))] }, status: 'active', isDelete: false }),
    ]);
    const productById = new Map<string, any>(pricedProducts.map((p: any) => [p._id.toString(), p]));
    const variantById = new Map<string, any>(pricedVariants.map((v: any) => [v._id.toString(), v]));

    // Everything else the pricing passes need, fetched in parallel (one query each,
    // not one per store / per line).
    const prefetchStoreIds = [...new Set([...pricedProducts.map((p: any) => String(p.storeId)), String(storeId)])];
    const sellerIds = [...new Set(pricedProducts.map((p: any) => p.sellerId).filter(Boolean))];
    const [storeDocs, benefitsByStore, sellers] = await Promise.all([
      storeModel.find({ _id: { $in: prefetchStoreIds } }).select('status isDelete codEnabled directPayment name slug premiumDiscount').lean(),
      this.subscriptionBenefits.getActiveBenefitsBatch(userId, prefetchStoreIds),
      sellerIds.length
        ? this.databaseService.repositories.sellerModel.find({ _id: { $in: sellerIds } }).select('name isVerified').lean()
        : Promise.resolve([] as any[]),
    ]);
    for (const s of storeDocs as any[]) storeDocById.set(String(s._id), s);
    for (const sid of prefetchStoreIds) benefitsCache.set(sid, benefitsByStore.get(sid) ?? null);

    for (const cartItem of selectedItems) {
      // Defense in depth: carts saved before quantity validation existed may
      // hold 0/negative/fractional lines, which would subtract from totals.
      if (!Number.isInteger(cartItem.quantity) || cartItem.quantity < 1) {
        throw new BadRequestException(
          'Your cart contains an item with an invalid quantity. Please update it and try again.',
        );
      }

      const product = productById.get(String(cartItem.productId));
      if (!product)
        throw new BadRequestException(
          `Product not found: ${cartItem.productId}`,
        );

      // A seller/store can be suspended after an item was already sitting
      // in the buyer's cart — checkout must re-check store status at the
      // moment of purchase, not just at add-to-cart time.
      if (!(await isStoreActive(product.storeId))) {
        if (unifiedCheckout) {
          // One suspended store must not block the buyer's other stores: skip the
          // line and report it. Nothing is removed from the cart.
          unavailableItems.push({
            productId: product._id.toString(),
            variantId: cartItem.productVariantId,
            storeId: product.storeId,
            name: product.name,
            reason: 'store_inactive',
          });
          continue;
        }
        throw new BadRequestException(
          `"${product.name}" is no longer available for purchase because the seller's store is not active. Please remove it from your cart.`,
        );
      }

      const variant = variantById.get(String(cartItem.productVariantId));
      if (!variant)
        throw new BadRequestException(
          `Variant not found: ${cartItem.productVariantId}`,
        );
      if (variant.productId !== product._id.toString())
        throw new BadRequestException(
          `Variant does not belong to product: ${product.name}`,
        );

      if (product.type === 'physical') {
        hasPhysical = true;
        if (!variant.unlimitedStock && variant.stock < cartItem.quantity) {
          throw new BadRequestException(
            `Insufficient stock for: ${product.name}`,
          );
        }
      }

      rawItems.push({ product, variant, cartItem });
      storeSubtotals.set(
        product.storeId,
        this.round(
          (storeSubtotals.get(product.storeId) ?? 0) +
            variant.price * cartItem.quantity,
        ),
      );
    }

    if (rawItems.length === 0) {
      // Only reachable in a unified checkout where every selected line was skipped.
      throw new BadRequestException({
        message: 'None of the items in your cart can be purchased right now',
        unavailableItems,
      });
    }
    if (unifiedCheckout) {
      const storeCount = new Set(rawItems.map((r) => r.product.storeId)).size;
      if (storeCount > MAX_CHECKOUT_STORES) {
        throw new BadRequestException(
          `A checkout can include at most ${MAX_CHECKOUT_STORES} stores — select items from fewer stores`,
        );
      }
    }

    // Batch-resolve seller name + verification badge across every distinct
    // seller in this checkout — same one-query-instead-of-N pattern used on
    // the product listing endpoints.
    const sellerMap = new Map(sellers.map((s: any) => [s._id.toString(), s]));

    // Pass 2: resolve subscriber pricing now that each store's raw subtotal is known.
    for (const { product, variant, cartItem } of rawItems) {
      // Subscriber pricing is resolved server-side only — the client never
      // supplies a discount, it can only ever be computed from the buyer's
      // real active subscription to this product's store.
      const benefitsEntry = await getBenefits(product.storeId);
      let discount = benefitsEntry
        ? this.subscriptionBenefits.resolveProductDiscount(
            benefitsEntry.benefits,
            product,
            variant.price,
          )
        : null;

      if (
        discount?.minOrderValueUSD != null &&
        (storeSubtotals.get(product.storeId) ?? 0) < discount.minOrderValueUSD
      ) {
        discount = null; // cart doesn't meet this store's minimum order value for the discount
      }

      const unitPrice = discount?.subscriberPrice ?? variant.price;
      const lineDiscount = discount
        ? this.round(discount.savingsUSD * cartItem.quantity)
        : 0;
      subscriberSavingsUSD += lineDiscount;

      const seller = sellerMap.get(product.sellerId?.toString());

      // A live class can't be bought once it has ended, or when its seats are full.
      if (product.deliveryFormat === 'live_class' && product.liveSession) {
        const live = product.liveSession;
        const endsAt = new Date(live.startsAt).getTime() + (live.durationMinutes ?? 0) * 60000;
        if (endsAt < Date.now()) throw new BadRequestException(`"${product.name}" has already taken place`);
        if (live.capacity) {
          const taken = await this.databaseService.repositories.orderModel.countDocuments(paidSeatFilter(product._id.toString()));
          if (taken + cartItem.quantity > live.capacity) throw new BadRequestException(`"${product.name}" is full — no seats left`);
        }
      }

      checkoutItems.push({
        productId: product._id.toString(),
        variantId: variant._id.toString(),
        sellerId: product.sellerId,
        sellerName: seller ? seller.name : null,
        sellerVerified: seller ? !!seller.isVerified : false,
        storeId: product.storeId,
        type: product.type,
        productType: product.productType ?? null,
        name: product.name,
        image: product.images?.[0] ?? null,
        sku: variant.sku ?? null,
        options: variant.options ?? [],
        // The license the buyer picked (a "License" variant), else the product's own.
        licenseType: licenseFromVariant(variant) ?? product.digital?.licenseType ?? null,
        quantity: cartItem.quantity,
        // Native currency this line's price/totalPrice are denominated in —
        // the SELLING store's own currency, independent of checkoutCurrency.
        // Falls back to 'PKR' only for a legacy variant somehow still
        // missing the field despite the Phase 1 backfill.
        currency: variant.currency ?? 'PKR',
        price: unitPrice,
        totalPrice: this.round(unitPrice * cartItem.quantity),
        originalPrice: discount ? variant.price : null,
        subscriberDiscountUSD: lineDiscount,
      });
    }

    // Pass 3: automatic platform-campaign discount. Resolved per store — a
    // store can be opted into more than one currently-active campaign, so
    // whichever one currently saves the buyer the most on that store's
    // (already subscriber-priced) subtotal wins (see pickBestCampaign).
    // Applied on top of subscriber pricing, same as a "sale on top of your
    // membership price" would read to a buyer — never on the raw list price.
    // Premium member: campaigns open earlyAccessHours before their start date (re-validated here, server-side).
    const premiumEnt = this.premium ? await this.premium.getEntitlements(userId) : null;
    const isPremiumBuyer = !!premiumEnt?.isPremium;

    let campaignSavingsUSD = 0;
    const appliedCampaigns: Array<{
      campaignId: string;
      name: string;
      storeId: string;
      discountUSD: number;
      sponsorType: 'seller' | 'platform';
    }> = [];
    const cartStoreIds = [...new Set(checkoutItems.map((i) => i.storeId))];
    const activeCampaignsByStore =
      await this.marketingService.getActiveCampaignsForStores(
        cartStoreIds,
        isPremiumBuyer ? { earlyAccessHours: premiumEnt!.earlyAccessHours } : {},
      );

    // Pass 3 is PER LINE (owner rules R1/R2). A line is in a campaign only when its product carries the campaign id (strict
    // opt-in, see campaign-eligibility.util.ts). The offer is computed from the LIST price (compare-at when above the
    // selling price, else the price) and applies only when strictly cheaper than what the buyer already pays for the line
    // (the selling price, or the subscriber price). `campaignDiscountUSD` = normal unit - campaign unit (x qty): for a
    // platform-sponsored sale that is exactly what the platform reimburses (the seller is credited their own price), for a
    // seller-sponsored sale it is what the seller gives up (the seller receives what the buyer pays).
    for (const storeId of cartStoreIds) {
      const campaigns = activeCampaignsByStore.get(storeId);
      if (!campaigns || campaigns.length === 0) continue;
      const allStoreItems = checkoutItems.filter((i) => i.storeId === storeId);
      const storeCurrency = allStoreItems[0]?.currency;
      const usable = storeCurrency
        ? await campaignsInCurrency(
            campaigns as any[], storeCurrency,
            (amount, from, to) => (this.exchangeRateService as any).convert(amount, from, to),
          )
        : [];
      const byCampaign = new Map<string, { sponsorType: 'seller' | 'platform'; name: string; discount: number }>();
      for (const item of allStoreItems) {
        const productDoc = productById.get(item.productId);
        const variantDoc = variantById.get(String(item.variantId));
        const mine = campaignsForProduct(usable, productDoc?.campaignIds);
        if (!mine.length || !variantDoc) continue;
        const normalUnit = item.quantity > 0 ? this.round(item.totalPrice / item.quantity) : item.price;
        const line = pickBestCampaignForLine(mine, variantDoc.price, variantDoc.compareAtPrice ?? null, normalUnit);
        if (!line) continue;
        const lineDiscount = this.round(line.discount * item.quantity);
        if (lineDiscount <= 0) continue;
        if (item.originalPrice == null) item.originalPrice = item.price;
        item.campaignId = line.campaign.campaignId;
        item.campaignDiscountUSD = lineDiscount;
        item.campaignSponsorType = line.campaign.sponsorType;
        item.totalPrice = this.round(item.totalPrice - lineDiscount);
        item.price = item.quantity > 0 ? this.round(item.totalPrice / item.quantity) : item.totalPrice;
        const agg = byCampaign.get(line.campaign.campaignId) ?? { sponsorType: line.campaign.sponsorType, name: line.campaign.name, discount: 0 };
        agg.discount = this.round(agg.discount + lineDiscount);
        byCampaign.set(line.campaign.campaignId, agg);
        campaignSavingsUSD = this.round(campaignSavingsUSD + lineDiscount);
      }
      for (const [campaignId, agg] of byCampaign) {
        appliedCampaigns.push({ campaignId, name: agg.name, storeId, discountUSD: agg.discount, sponsorType: agg.sponsorType });
      }
    }
    // Pass 3.5: seller's own automatic (no-code) discount (DiscountsService)
    // — same "computed server-side, never client-supplied" rule as campaign
    // discount above, resolved on top of it. An item that already got a
    // campaign discount is excluded, same "not combinable with an active
    // sale" rule CheckoutService.applyCoupon's eligibility filter uses.
    // Only the single best-value discount per store is applied — same
    // one-per-store selection as pickBestCampaign, just evaluated against
    // each discount's own targeted subset of items (whole store / a set of
    // categories / a set of products).
    let autoDiscountSavingsUSD = 0;
    const activeDiscountsByStore = await this.discountsService.getActiveDiscountsForStores(cartStoreIds);

    for (const sId of cartStoreIds) {
      const candidates = activeDiscountsByStore.get(sId);
      if (!candidates || candidates.length === 0) continue;

      const storeItemsAll = checkoutItems.filter((i) => i.storeId === sId);
      const nonSaleItems = storeItemsAll.filter((i) => !(i.campaignDiscountUSD > 0));
      if (nonSaleItems.length === 0) continue;
      const wholeStoreSubtotal = this.round(storeItemsAll.reduce((s, i) => s + i.totalPrice, 0));

      // categoryId isn't carried on a CheckoutItem — only fetched when a
      // candidate discount actually needs it, and scoped to this store's
      // own non-sale items only.
      let categoryByProductId: Map<string, string> | null = null;
      if (candidates.some((d: any) => d.target === 'category')) {
        const productIds = [...new Set(nonSaleItems.map((i: any) => i.productId))];
        const products = await productModel.find({ _id: { $in: productIds } }).select('categoryId').lean();
        categoryByProductId = new Map(products.map((p: any) => [String(p._id), p.categoryId]));
      }

      let best: { discount: any; items: any[]; amount: number } | null = null;
      for (const discount of candidates) {
        if (discount.minOrderAmount != null && wholeStoreSubtotal < discount.minOrderAmount) continue;

        if (discount.target === 'bundle') {
          const items = nonSaleItems.filter((i: any) => discount.productIds.includes(i.productId));
          const amount = bundleSavings(discount, items);
          if (amount > 0 && (!best || amount > best.amount)) best = { discount, items, amount };
          continue;
        }

        const eligible = discount.target === 'store'
          ? nonSaleItems
          : discount.target === 'category'
            ? nonSaleItems.filter((i: any) => {
                const catId = categoryByProductId?.get(i.productId);
                return catId && discount.categoryIds.includes(catId);
              })
            : nonSaleItems.filter((i: any) => discount.productIds.includes(i.productId));
        if (eligible.length === 0) continue;

        const eligibleSubtotal = this.round(eligible.reduce((s: number, i: any) => s + i.totalPrice, 0));
        if (eligibleSubtotal <= 0) continue;

        const amount = discount.discountType === 'percentage'
          ? Math.min(this.round(eligibleSubtotal * (Math.min(discount.discountValue, 100) / 100)), eligibleSubtotal)
          : Math.min(discount.discountValue, eligibleSubtotal);
        if (amount <= 0) continue;

        if (!best || amount > best.amount) best = { discount, items: eligible, amount };
      }

      if (best) {
        this.distributeAutoDiscount(best.items, best.amount, String(best.discount._id));
        autoDiscountSavingsUSD = this.round(autoDiscountSavingsUSD + best.amount);
      }
    }


    // Pass 3.6: Edudeen Premium price (owner rules R1-R4). A member pays ONLY the premium price:
    //   LIST x (1 - seller% - platform%)   (additive; LIST = compare-at when it is above the price, else the price)
    // and it COMPETES with the whole normal pipeline above (subscriber / campaign / automatic discounts): a line is
    // switched to the premium price only when that is strictly lower than what a normal buyer pays for the same line;
    // otherwise the line stays exactly a normal line (the member never pays more than a normal buyer). When switched,
    // the line's campaign / automatic / subscriber discount is removed from the totals. The platform's share is tagged
    // platform-funded (PaymentService credits the seller as if only the seller's own premium discount existed).
    let premiumSavingsUSD = 0; // seller-funded part
    let premiumPlatformSavingsUSD = 0; // platform-funded part
    if (isPremiumBuyer) {
      const terms = (this.premium as any)?.getTerms ? await this.premium!.getTerms() : DEFAULT_PREMIUM_TERMS;
      for (const item of checkoutItems) {
        const sellerPct = premiumPercentFor(productById.get(item.productId), storeDocById.get(String(item.storeId)));
        const variant = variantById.get(String(item.variantId));
        if (!sellerPct || !variant) continue;
        const r = applyPremiumToLine(item, variant, sellerPct, terms);
        if (!r.applied) continue;
        premiumSavingsUSD = this.round(premiumSavingsUSD + r.sellerDiscount);
        premiumPlatformSavingsUSD = this.round(premiumPlatformSavingsUSD + r.platformDiscount);
        subscriberSavingsUSD = this.round(Math.max(0, subscriberSavingsUSD - r.replacedSubscriberDiscount));
        if (r.replacedCampaignDiscount > 0) {
          campaignSavingsUSD = this.round(Math.max(0, campaignSavingsUSD - r.replacedCampaignDiscount));
          const ac = appliedCampaigns.find((c) => c.campaignId === r.replacedCampaignId && c.storeId === item.storeId);
          if (ac) ac.discountUSD = this.round(Math.max(0, ac.discountUSD - r.replacedCampaignDiscount));
        }
        if (r.replacedAutoDiscount > 0) autoDiscountSavingsUSD = this.round(Math.max(0, autoDiscountSavingsUSD - r.replacedAutoDiscount));
      }
    }
    let defaultAddressId: string | null = null;

    if (hasPhysical) {
      // The address the buyer picked at checkout. It used to be ignored, so an
      // order always shipped to the default address whatever was chosen.
      let defaultAddress =
        typeof body.addressId === 'string' && isValidObjectId(body.addressId)
          ? await addressModel.findOne({ _id: body.addressId, userId, isDelete: false })
          : null;
      if (body.addressId && !defaultAddress) throw new BadRequestException('Selected address not found');
      if (!defaultAddress) defaultAddress = await addressModel.findOne({ userId, isDefault: true, isDelete: false });

      // Buyers aren't required to flag an address as default when saving
      // one, so a buyer with addresses but no explicit default would
      // otherwise be blocked from checking out entirely. Fall back to the
      // oldest saved address and promote it, repairing the missing-default
      // data so subsequent lookups (address list, getDefaultAddress) agree.
      if (!defaultAddress) {
        defaultAddress = await addressModel.findOne({ userId, isDelete: false }).sort({ createdAt: 1 });
        if (defaultAddress) {
          defaultAddress.isDefault = true;
          await defaultAddress.save();
        }
      }

      if (!defaultAddress) throw new BadRequestException('No default address found. Please set a default address first');
      defaultAddressId = defaultAddress._id.toString();
    }

    // FX snapshot — one entry per distinct currency actually involved (every
    // seller currency present among checkoutItems, plus the checkout
    // currency itself). Built ONCE, here, and frozen onto the Checkout
    // document below — every later calculation in THIS checkout's lifetime
    // (shipping, coupon application) must convert using these exact
    // snapshotted rates, never a fresh live lookup, so a rate change
    // mid-checkout can never silently alter what the buyer is charged.
    // Shipping (addShippingInCheckout, added in a later request) always
    // needs a PKR rate available — see SHIPPING_ZONE_CURRENCY's comment —
    // so a physical-item checkout always includes PKR here even if no cart
    // line happens to be PKR-priced, rather than risk a missing-snapshot
    // error when shipping is added afterward.
    const involvedCurrencies = [
      ...new Set([
        checkoutCurrency,
        ...checkoutItems.map((i) => i.currency),
        ...(hasPhysical ? [SHIPPING_ZONE_CURRENCY] : []),
      ]),
    ];
    const fxSnapshots = await this.exchangeRateService.buildSnapshots(involvedCurrencies);

    // Each line is converted from ITS OWN seller currency into the checkout
    // currency individually, THEN summed — never summed raw across
    // different native currencies. This is the direct fix for the
    // hazard confirmed in the Phase 0 audit (a PKR-priced line must never
    // be treated as a same-scale USD figure).
    const subtotal = this.convertedSubtotal(checkoutItems, checkoutCurrency, fxSnapshots);
    const taxAmount = 0; // no tax system exists yet — explicitly out of scope, not invented here
    const totalAmount = this.round(subtotal + taxAmount);

    // Checkout-time upsell: for any store in this cart the buyer is NOT
    // subscribed to, but which has an active plan offering a discount,
    // surface what they'd have saved — the highest-intent moment to convert.
    const subscriptionSavingsHints: Array<{
      storeId: string;
      storeName: string;
      storeSlug: string;
      planId: string;
      planName: string;
      potentialSavingsUSD: number;
    }> = [];
    const storeIdsInCart = [...new Set(checkoutItems.map((i) => i.storeId))];
    for (const sid of storeIdsInCart) {
      if (benefitsCache.get(sid)) continue; // already subscribed here
      const plan = await this.databaseService.repositories.subscriptionPlanModel
        .findOne({
          storeId: sid,
          status: 'active',
          isDelete: false,
          'benefits.type': 'discount',
        })
        .sort({ monthlyPriceUSD: 1 })
        .lean();
      if (!plan) continue;
      const storeItems = checkoutItems.filter((i) => i.storeId === sid);
      let potentialSavings = 0;
      for (const item of storeItems) {
        const d = this.subscriptionBenefits.resolveProductDiscount(
          (plan as any).benefits,
          { _id: item.productId } as any,
          item.price,
        );
        if (d) potentialSavings += this.round(d.savingsUSD * item.quantity);
      }
      if (potentialSavings > 0) {
        const store = storeDocById.get(String(sid)) ?? null;
        subscriptionSavingsHints.push({
          storeId: sid,
          storeName: (store as any)?.name ?? 'this store',
          storeSlug: (store as any)?.slug ?? '',
          planId: (plan as any)._id.toString(),
          planName: (plan as any).name,
          potentialSavingsUSD: this.round(potentialSavings),
        });
      }
    }

    // Client-reported attribution — a mobile app has no meaningful
    // Referer/UTM headers, so this can only ever be as good as what the app
    // itself reports (e.g. "opened via a shared product link"). Unknown or
    // invalid values fall back to 'other' rather than being rejected.
    const validAttributionSources = [
      'marketplace_search',
      'direct_link',
      'social_media',
      'email',
      'other',
    ];
    const attributionSource = validAttributionSources.includes(
      body.attributionSource,
    )
      ? body.attributionSource
      : 'other';

    // Once an admin has set up delivery zones, a physical order must name one —
    // otherwise leaving the field out would skip the shipping charge entirely.
    if (hasPhysical && !body.shippingZoneId) {
      const zonesConfigured = await this.databaseService.repositories.shippingZoneModel.exists({ isDelete: false, status: { $ne: 'inactive' } });
      if (zonesConfigured) throw new BadRequestException('Choose a delivery option for your address');
    }
    const checkout = await checkoutModel.create({
      userId,
      addressId: defaultAddressId,
      currency: checkoutCurrency,
      fxSnapshots,
      items: checkoutItems,
      shippingZoneId: null,
      paymentType: null,
      paymentMethodId: null,
      subtotal,
      shippingFee: 0,
      taxAmount,
      subscriberSavingsUSD: this.round(subscriberSavingsUSD),
      campaignDiscountTotalUSD: campaignSavingsUSD,
      autoDiscountTotalUSD: autoDiscountSavingsUSD,
      isPremiumBuyer,
      premiumDiscountTotalUSD: premiumSavingsUSD,
      premiumPlatformDiscountTotalUSD: premiumPlatformSavingsUSD,
      totalAmount,
      isBuyNow: !!buyNowLine,
      status: 'pending',
      attributionSource,
      attributedBannerId: body.attributedBannerId ?? null,
      attributedStoreBannerId: body.attributedStoreBannerId ?? null,
      expiredAt: new Date(Date.now() + 30 * 60 * 1000),
      isDelete: false,
    });

    const hasDigital = checkoutItems.some((i) => i.type === 'digital');

    // Per-seller COD opt-out (Store.codEnabled) — 'cash_on_delivery' and
    // 'split' (which settles its physical portion via COD on delivery, see
    // PaymentService.initiatePayment) are only offered here if EVERY store
    // with a physical item in this cart still allows COD. This is the
    // offer-time mirror of the enforcement already done at commit-time in
    // PaymentService.codPayment/initiatePayment — without it, a buyer could
    // pick COD/split for a cart containing a COD-disabled store's items and
    // only find out it's rejected on the last checkout step.
    const physicalStoreIds = [
      ...new Set(checkoutItems.filter((i) => i.type === 'physical').map((i) => i.storeId)),
    ];
    // COD is also only offered when all physical items come from ONE store: the
    // cash is collected per seller, so a multi-seller COD order has no single
    // party to collect and confirm it (see PaymentService.codPayment).
    const codEligible = hasPhysical
      ? physicalStoreIds.length <= 1 &&
        physicalStoreIds
          .map((id) => storeDocById.get(String(id)))
          .filter(Boolean)
          .every((s: any) => s.codEnabled !== false)
      : true;

    // Manual bank-transfer (Pakistan track — pay into the platform's own
    // account, upload proof) is a Stripe-equivalent alternative, not a COD
    // substitute — it's offered alongside 'stripe' whenever an admin has it
    // enabled, regardless of digital/physical mix. Admin-config-gated so it
    // can be turned off platform-wide without a deploy.
    // Offered whenever the admin has filled in the PLATFORM's bank / wallet account
    // (all online payments land with the platform; an admin confirms each proof).
    const manualTransferEnabled = await this.adminConfigService.isManualTransferAvailable().catch(() => false);
    const withManualTransfer = (methods: string[]) =>
      manualTransferEnabled ? [...methods, 'manual_bank_transfer'] : methods;

    // The shipping option picked at checkout. It used to be dropped here (and
    // the separate add-shipping call was never made), so no order was ever
    // charged shipping. Without a zone — none configured yet — shipping is free.
    let shippingFee = 0;
    let finalTotal = totalAmount;
    let finalCheckout: any = checkout;
    if (hasPhysical && body.shippingZoneId) {
      if (typeof body.shippingZoneId !== 'string' || !isValidObjectId(body.shippingZoneId)) {
        throw new BadRequestException('Invalid shippingZoneId');
      }
      const added = await this.addShippingInCheckout(
        userId,
        { checkoutId: checkout._id.toString(), shippingZoneId: body.shippingZoneId },
        { checkout, benefitsByStore: benefitsCache },
      );
      shippingFee = added.data.shippingFee;
      finalTotal = added.data.totalAmount;
      // Reuse the document we just created instead of re-reading it.
      checkout.set({ shippingZoneId: body.shippingZoneId, shippingFee, totalAmount: finalTotal, shippingEstimate: added.data.shippingEstimate ?? null });
      finalCheckout = checkout;
    }

    return {
      success: true,
      message: 'Checkout created successfully',
      data: {
        checkout: finalCheckout,
        // A mixed cart can either pay everything online ('stripe') or split
        // it — digital online now, physical via COD on delivery ('split').
        // Digital-only carts never get COD; physical-only carts keep both
        // 'stripe' and 'cash_on_delivery' as before — unless COD isn't
        // eligible (see codEligible above), in which case 'stripe' (pay
        // everything online) is always the safe fallback.
        allowedPaymentMethods: totalAmount === 0
          ? ['free'] // nothing to pay: confirm via POST /api/payment/free-checkout
          : [
              ...(hasDigital
                ? withManualTransfer(hasPhysical && codEligible ? ['stripe', 'split'] : ['stripe'])
                : withManualTransfer(codEligible ? ['stripe', 'cash_on_delivery'] : ['stripe'])),
              // JazzCash / Easypaisa: only when configured via env AND the checkout is PKR.
              ...configuredHostedProviderIds(checkoutCurrency),
            ],
        summary: {
          subtotal,
          shippingFee,
          taxAmount,
          totalAmount: finalTotal,
          subscriberSavingsUSD: this.round(subscriberSavingsUSD),
          campaignDiscountUSD: campaignSavingsUSD,
          autoDiscountUSD: autoDiscountSavingsUSD,
          ...(isPremiumBuyer ? { premiumDiscountUSD: premiumSavingsUSD, premiumPlatformDiscountUSD: premiumPlatformSavingsUSD } : {}),
          ...this.splitSubtotalsByType(checkoutItems),
        },
        subscriptionSavingsHints,
        appliedCampaigns,
        // Lines skipped because their store is not active (unified checkout only); still in the cart.
        unavailableItems,
      },
    };
  }

  async addShippingInCheckout(
    userId: string,
    body: any,
    preloaded?: { checkout: any; benefitsByStore?: Map<string, { benefits: any[]; planName: string } | null> },
  ) {
    const { checkoutId, shippingZoneId } = body;

    if (!checkoutId) throw new BadRequestException('checkoutId is required');
    if (!shippingZoneId)
      throw new BadRequestException('shippingZoneId is required');

    const { checkoutModel, shippingZoneModel } =
      this.databaseService.repositories;

    const checkout =
      preloaded?.checkout ??
      (await checkoutModel.findOne({
        _id: checkoutId,
        userId,
        isDelete: false,
      }));
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status === 'payment_pending')
      throw new BadRequestException('Payment has already been started for this checkout — start a new checkout to change it');
    if (checkout.status === 'completed')
      throw new BadRequestException('Checkout already completed');
    if (checkout.status === 'expired')
      throw new BadRequestException('Checkout has expired');
    if (checkout.expiredAt && checkout.expiredAt < new Date()) {
      await checkoutModel.findByIdAndUpdate(checkout._id, {
        status: 'expired',
      });
      throw new BadRequestException('Checkout has expired');
    }

    const shippingZone = await shippingZoneModel.findOne({
      _id: shippingZoneId,
      isDelete: false,
      status: { $ne: 'inactive' },
    });
    if (!shippingZone) throw new NotFoundException('Shipping zone not found');

    // ShippingZone.shippingPrice is always PKR (see SHIPPING_ZONE_CURRENCY's
    // comment) — converted into this checkout's own currency using its
    // already-frozen fxSnapshots, never a fresh live rate.
    const baseFee = this.exchangeRateService.convertWithSnapshots(
      shippingZone.shippingPrice || 0,
      SHIPPING_ZONE_CURRENCY,
      checkout.currency,
      (checkout.fxSnapshots as any) ?? [],
    );

    // Sellers ship separately, so every store with PHYSICAL items gets its own
    // shipping line (the platform zone fee), and each store's free/discounted
    // shipping subscriber benefit applies to that store's line only. A checkout
    // with no physical items (digital only) has no shipping at all.
    const items = checkout.items as any[];
    const physicalStoreIds = [...new Set(items.filter((i) => i.type === 'physical').map((i) => i.storeId))];
    const shippingByStore: { storeId: string; fee: number; baseFee: number; discountPercent: number }[] = [];
    for (const storeId of physicalStoreIds) {
      let discountPercent = 0;
      const benefitsEntry = preloaded?.benefitsByStore?.has(storeId)
        ? preloaded.benefitsByStore.get(storeId)
        : await this.subscriptionBenefits.getActiveBenefits(userId, storeId);
      if (benefitsEntry) {
        const shippingBenefit = this.subscriptionBenefits.resolveShippingBenefit(benefitsEntry.benefits);
        const storeSubtotal = this.convertedSubtotal(
          items.filter((i) => i.storeId === storeId),
          checkout.currency,
          (checkout.fxSnapshots as any) ?? [],
        );
        if (
          shippingBenefit &&
          (shippingBenefit.minOrderValueForShippingUSD == null ||
            storeSubtotal >= shippingBenefit.minOrderValueForShippingUSD)
        ) {
          discountPercent = shippingBenefit.discountPercent;
        }
      }
      shippingByStore.push({
        storeId,
        baseFee,
        discountPercent,
        fee: this.round(baseFee * (1 - discountPercent / 100)),
      });
    }
    const shippingFee = this.round(shippingByStore.reduce((sum, l) => sum + l.fee, 0));

    const totalAmount = this.round(checkout.subtotal + shippingFee);
    // Display-only snapshot of the zone's delivery estimate text (physical items only).
    const shippingEstimate: string | null =
      physicalStoreIds.length && typeof shippingZone.estimatedDeliveryTime === 'string' && shippingZone.estimatedDeliveryTime.trim()
        ? shippingZone.estimatedDeliveryTime.trim()
        : null;

    await checkoutModel.findByIdAndUpdate(checkoutId, {
      shippingZoneId,
      shippingFee,
      shippingByStore,
      totalAmount,
      shippingEstimate,
    });

    return {
      success: true,
      message: 'Shipping added to checkout',
      data: {
        checkoutId,
        shippingZoneId,
        shippingFee,
        shippingByStore,
        shippingEstimate,
        subtotal: checkout.subtotal,
        totalAmount,
        ...this.splitSubtotalsByType(checkout.items as any[]),
      },
    };
  }

  async getShippingZones() {
    try {
      const shippingZoneModel =
        this.databaseService.repositories.shippingZoneModel;

      // Buyers only ever see zones an admin has switched on.
      const shippingZones = await shippingZoneModel
        .find({
          isDelete: false,
          status: { $ne: 'inactive' },
        })
        .sort({ createdAt: -1 });

      return {
        message: 'Shipping zones fetched successfully',
        data: shippingZones,
      };
    } catch (error) {
      throw error;
    }
  }

  // ── Admin: shipping zones ────────────────────────────────────────────────
  // There was no way to create a zone at all (only direct DB inserts), so a
  // physical checkout had no shipping option to pick and could not continue.

  private pickZoneFields(body: any, partial: boolean) {
    const out: Record<string, unknown> = {};
    const text = (key: string, max: number, required: boolean) => {
      const v = body?.[key];
      if (v === undefined) { if (required && !partial) throw new BadRequestException(`${key} is required`); return; }
      if (v === null || v === '') { if (required) throw new BadRequestException(`${key} is required`); out[key] = null; return; }
      if (typeof v !== 'string' || v.trim().length > max) throw new BadRequestException(`${key} must be text of at most ${max} characters`);
      out[key] = v.trim();
    };
    text('country', 60, true);
    text('province', 80, false);
    text('city', 80, false);
    text('estimatedDeliveryTime', 40, false);
    if (body?.shippingPrice !== undefined) {
      const p = Number(body.shippingPrice);
      if (!Number.isFinite(p) || p < 0 || p > 1_000_000) throw new BadRequestException('shippingPrice must be between 0 and 1,000,000 PKR');
      out.shippingPrice = Math.round(p);
    } else if (!partial) throw new BadRequestException('shippingPrice is required');
    if (body?.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'inactive') throw new BadRequestException('status must be active or inactive');
      out.status = body.status;
    }
    return out;
  }

  async adminListShippingZones() {
    const data = await this.databaseService.repositories.shippingZoneModel
      .find({ isDelete: false })
      .sort({ country: 1, province: 1, city: 1 })
      .lean();
    return { success: true, data };
  }

  /** Buyer: adds / changes the gift note and gift wrap on a checkout that still has physical items. */
  async setGiftOptions(userId: string, body: any) {
    const checkoutId = body?.checkoutId;
    if (!checkoutId || !isValidObjectId(checkoutId)) throw new BadRequestException('checkoutId is required');
    let opts;
    try {
      opts = sanitizeGiftOptions(body);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Invalid gift options');
    }
    const { checkoutModel } = this.databaseService.repositories;
    const checkout: any = await checkoutModel.findOne({ _id: checkoutId, userId, isDelete: false }).select('status items').lean();
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (!['pending', 'payment_pending'].includes(checkout.status)) throw new BadRequestException('This checkout can no longer be changed');
    if (!(checkout.items ?? []).some((i: any) => i.type === 'physical')) throw new BadRequestException('Gift options are only for physical items');
    await checkoutModel.updateOne({ _id: checkoutId, userId }, { $set: opts });
    return { success: true, message: 'Gift options saved', data: opts };
  }

  /** Admin action: adds the starter Pakistani zones that do not exist yet. Idempotent; never edits or deletes existing zones. */
  async adminSeedDefaultShippingZones() {
    const { shippingZoneModel } = this.databaseService.repositories;
    const existing = await shippingZoneModel.find({ isDelete: false }).select('country province city').lean();
    const toAdd = missingDefaultZones(existing as any[]);
    if (toAdd.length > 0) {
      await shippingZoneModel.insertMany(toAdd.map((z) => ({ country: 'Pakistan', ...z, status: 'active', isDelete: false })));
    }
    return { success: true, message: toAdd.length ? `Added ${toAdd.length} delivery zone(s)` : 'All default zones already exist', data: { added: toAdd.length, skipped: DEFAULT_PK_ZONES.length - toAdd.length } };
  }

  async adminCreateShippingZone(body: any) {
    const data = await this.databaseService.repositories.shippingZoneModel.create(this.pickZoneFields(body, false));
    return { success: true, message: 'Shipping zone created', data };
  }

  async adminUpdateShippingZone(id: string, body: any) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid shipping zone id');
    const data = await this.databaseService.repositories.shippingZoneModel.findOneAndUpdate(
      { _id: id, isDelete: false },
      { $set: this.pickZoneFields(body, true) },
      { returnDocument: 'after' },
    );
    if (!data) throw new NotFoundException('Shipping zone not found');
    return { success: true, message: 'Shipping zone updated', data };
  }

  async adminDeleteShippingZone(id: string) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid shipping zone id');
    const data = await this.databaseService.repositories.shippingZoneModel.findOneAndUpdate(
      { _id: id, isDelete: false },
      { $set: { isDelete: true } },
    );
    if (!data) throw new NotFoundException('Shipping zone not found');
    return { success: true, message: 'Shipping zone deleted' };
  }

  /** Validates a seller-created coupon against this checkout and, if valid,
   *  distributes its discount across only the items belonging to the
   *  coupon's own store (a coupon never discounts another seller's items in
   *  a mixed-store cart). Replacing an already-applied coupon reverts the
   *  old one first so discounts never compound. */
  async applyCoupon(userId: string, body: any) {
    const { checkoutId, code } = body;
    if (!checkoutId) throw new BadRequestException('checkoutId is required');
    if (!code || !String(code).trim())
      throw new BadRequestException('Coupon code is required');

    const { checkoutModel, couponModel } = this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status === 'payment_pending')
      throw new BadRequestException('Payment has already been started for this checkout — start a new checkout to change it');
    if (checkout.status === 'completed')
      throw new BadRequestException('Checkout already completed');
    if (checkout.status === 'cancelled')
      throw new BadRequestException('Checkout is cancelled');
    if (checkout.status === 'expired')
      throw new BadRequestException('Checkout has expired');
    if (checkout.expiredAt && checkout.expiredAt < new Date()) {
      await checkoutModel.findByIdAndUpdate(checkout._id, {
        status: 'expired',
      });
      throw new BadRequestException('Checkout has expired');
    }

    const normalizedCode = String(code).trim().toUpperCase();
    const items = checkout.items as any[];
    const storeIdsInCheckout = [...new Set(items.map((i) => i.storeId))];

    // A platform (admin-issued) coupon has storeId: null and isn't tied to
    // any one seller — it must be matched by an explicit scope:'platform'
    // branch, since `{$in: storeIdsInCheckout}` (real ids only) can never
    // match a null storeId.
    const coupon = await couponModel.findOne({
      code: normalizedCode,
      isActive: true,
      isDelete: false,
      $or: [{ scope: 'platform' }, { storeId: { $in: storeIdsInCheckout } }],
    });
    if (!coupon) {
      // Not a seller/platform coupon — the buyer's single "promo code" input
      // also accepts a LoyaltyReward redemption voucher (LoyaltyService
      // .redeemReward), so try that before failing outright.
      return this.applyRewardVoucher(checkout, items, storeIdsInCheckout, normalizedCode, userId);
    }
    if (coupon.expiresAt && coupon.expiresAt < new Date())
      throw new BadRequestException('This coupon has expired');
    if (coupon.usageLimit != null && coupon.usageCount >= coupon.usageLimit) {
      throw new BadRequestException('This coupon has reached its usage limit');
    }
    // A personal (Premium member) coupon belongs to one buyer and needs an active membership; anyone else
    // gets the same message as an unknown code.
    if (coupon.ownerUserId) {
      if (coupon.ownerUserId !== userId) {
        throw new BadRequestException('This coupon code is invalid or not applicable to items in your cart');
      }
      if (coupon.platformFunded && this.premium && !(await this.premium.getEntitlements(userId)).isPremium) {
        throw new BadRequestException('This coupon is for active Edudeen Premium members');
      }
    }

    // Revert any previously-applied coupon first so re-applying (or
    // switching codes) always computes from a clean, undiscounted baseline.
    this.revertCouponFromItems(items);

    const isPlatformCoupon = coupon.scope === 'platform';
    // A seller coupon only ever discounts its own store's items (still in
    // that store's own native currency); a platform coupon spans every
    // store/currency in the checkout, so its basis is the checkout's own
    // display currency, computed via per-line conversion like every other
    // checkout-level total.
    const storeItems = isPlatformCoupon
      ? items
      : items.filter((i) => i.storeId === coupon.storeId);
    const couponStoreCurrency = isPlatformCoupon
      ? checkout.currency
      : storeItems[0]?.currency ?? checkout.currency;
    const storeSubtotal = isPlatformCoupon
      ? this.convertedSubtotal(storeItems, couponStoreCurrency, checkout.fxSnapshots as any)
      : this.round(storeItems.reduce((s, i) => s + i.totalPrice, 0));

    if (coupon.minOrderAmount != null) {
      // minOrderAmount has no currency field of its own on the Coupon schema
      // — it's implicitly denominated the same as discountValue
      // (coupon.currency), same conversion treatment as the discount itself.
      const minOrderInStoreCurrency = this.exchangeRateService.convertWithSnapshots(
        coupon.minOrderAmount,
        coupon.currency ?? 'USD',
        couponStoreCurrency,
        (checkout.fxSnapshots as any) ?? [],
      );
      if (storeSubtotal < minOrderInStoreCurrency) {
        throw new BadRequestException(
          isPlatformCoupon
            ? `This coupon requires a minimum order of ${minOrderInStoreCurrency} ${couponStoreCurrency}`
            : `This coupon requires a minimum order of ${minOrderInStoreCurrency} ${couponStoreCurrency} from this store`,
        );
      }
    }

    // Items already discounted by an active platform campaign ("sale" items)
    // don't stack with a coupon code on top — standard "not combinable with
    // other offers" rule, and it also keeps a line from being discounted
    // twice down toward/below $0. minOrderAmount above still checks the
    // buyer's full spend at the store, but the coupon itself only ever comes
    // out of the non-sale portion.
    const eligibleItems = storeItems.filter(
      (i) => !(i.campaignDiscountUSD > 0),
    );
    if (eligibleItems.length === 0) {
      throw new BadRequestException(
        "This coupon can't be combined with the active sale on these items.",
      );
    }
    const eligibleSubtotal = isPlatformCoupon
      ? this.convertedSubtotal(eligibleItems, couponStoreCurrency, checkout.fxSnapshots as any)
      : this.round(eligibleItems.reduce((s, i) => s + i.totalPrice, 0));

    // `storeItems[].totalPrice` above is still in the SELLING STORE'S own
    // native currency (never converted — only the checkout-level subtotal
    // is), so a fixed-amount coupon's discountValue (denominated in
    // coupon.currency — that same store's currency for a seller coupon, or
    // 'USD' for a platform coupon, per Coupon.currency's schema comment)
    // must be converted into the STORE's currency here, not the buyer's
    // checkout currency, before being subtracted from a store-native total.
    const totalDiscount =
      coupon.discountType === 'percentage'
        ? Math.min(this.round(eligibleSubtotal * (Math.min(coupon.discountValue, 100) / 100)), eligibleSubtotal)
        : Math.min(
            this.exchangeRateService.convertWithSnapshots(
              coupon.discountValue,
              coupon.currency ?? 'USD',
              couponStoreCurrency,
              (checkout.fxSnapshots as any) ?? [],
            ),
            eligibleSubtotal,
          );

    // A coupon that computes to zero real savings (e.g. every eligible item
    // is free, or a fixed-amount coupon on a $0 eligible subtotal) must be
    // rejected outright, the same way "no eligible items at all" already is
    // above — silently marking it "applied" for Rs0/$0 would look successful
    // to the buyer while doing nothing, which no real checkout does.
    if (totalDiscount <= 0) {
      throw new BadRequestException(
        eligibleItems.length < storeItems.length
          ? "This coupon doesn't apply any discount here — the eligible items in your cart are already on sale or have no remaining value to discount."
          : "This coupon doesn't apply any discount to your cart.",
      );
    }

    if (isPlatformCoupon) {
      // A platform coupon's basis/discount is in the checkout's own display
      // currency, but each eligible item's totalPrice is still in that
      // item's OWN native seller currency — proportional weighting AND the
      // final per-item deduction both need a per-item currency conversion,
      // unlike the single-currency seller-coupon path above.
      this.distributePlatformCouponDiscount(
        eligibleItems,
        totalDiscount,
        couponStoreCurrency,
        checkout.fxSnapshots as any,
      );
    } else {
      this.distributeCouponDiscount(eligibleItems, totalDiscount);
    }

    // Platform-funded coupon (Premium monthly coupon): the platform, not the seller, bears this discount - tag the
    // lines so PaymentService credits the seller the full price (same path as platform-sponsored campaigns).
    if (coupon.platformFunded) {
      for (const i of eligibleItems) if ((i.couponDiscountUSD ?? 0) > 0) i.couponSponsorType = 'platform';
    }

    const newSubtotal = this.convertedSubtotal(items, checkout.currency, checkout.fxSnapshots as any);
    const newTotal = this.round(newSubtotal + (checkout.shippingFee || 0));

    await checkoutModel.findByIdAndUpdate(checkoutId, {
      items: items.map((i: any) => (i.toObject ? i.toObject() : i)),
      subtotal: newSubtotal,
      totalAmount: newTotal,
      couponCode: normalizedCode,
      couponStoreId: coupon.storeId,
      couponSourceType: 'coupon',
      couponDiscountTotalUSD: totalDiscount,
    });

    return {
      success: true,
      message: 'Coupon applied',
      data: {
        checkoutId,
        couponCode: normalizedCode,
        couponDiscountUSD: totalDiscount,
        subtotal: newSubtotal,
        shippingFee: checkout.shippingFee || 0,
        totalAmount: newTotal,
        ...this.splitSubtotalsByType(items),
      },
    };
  }

  async removeCoupon(userId: string, body: any) {
    const { checkoutId } = body;
    if (!checkoutId) throw new BadRequestException('checkoutId is required');

    const { checkoutModel } = this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status === 'payment_pending')
      throw new BadRequestException('Payment has already been started for this checkout — start a new checkout to change it');
    if (checkout.status === 'completed')
      throw new BadRequestException('Checkout already completed');
    if (checkout.status === 'cancelled')
      throw new BadRequestException('Checkout is cancelled');
    if (checkout.status === 'expired')
      throw new BadRequestException('Checkout has expired');
    if (checkout.expiredAt && checkout.expiredAt < new Date()) {
      await checkoutModel.findByIdAndUpdate(checkout._id, {
        status: 'expired',
      });
      throw new BadRequestException('Checkout has expired');
    }

    const items = checkout.items as any[];
    this.revertCouponFromItems(items);
    // A gift card's "before" snapshot may have been captured on top of this
    // coupon's discount (if it was applied afterward) — reverting only the
    // coupon would leave that snapshot pointing at a price that no longer
    // exists once the coupon is gone. Reverting both and requiring a
    // re-apply of the gift card is the safe, always-correct behavior; a
    // silent partial-revert here would risk double-crediting or
    // under-crediting the buyer.
    const hadGiftCard = !!checkout.giftCardCode;
    this.revertGiftCardFromItems(items);

    const newSubtotal = this.convertedSubtotal(items, checkout.currency, checkout.fxSnapshots as any);
    const newTotal = this.round(newSubtotal + (checkout.shippingFee || 0));

    await checkoutModel.findByIdAndUpdate(checkoutId, {
      items: items.map((i: any) => (i.toObject ? i.toObject() : i)),
      subtotal: newSubtotal,
      totalAmount: newTotal,
      couponCode: null,
      couponStoreId: null,
      couponSourceType: 'coupon',
      couponDiscountTotalUSD: 0,
      ...(hadGiftCard ? { giftCardCode: null, giftCardStoreId: null, giftCardDiscountTotalUSD: 0 } : {}),
    });

    return {
      success: true,
      message: hadGiftCard ? 'Coupon removed — please re-apply your gift card' : 'Coupon removed',
      data: {
        checkoutId,
        subtotal: newSubtotal,
        shippingFee: checkout.shippingFee || 0,
        totalAmount: newTotal,
        ...this.splitSubtotalsByType(items),
      },
    };
  }

  /** Applies a GiftCard's remaining balance to its own store's items in this
   *  checkout — kept in a completely separate checkout slot from
   *  couponCode/couponStoreId (see Checkout.giftCardCode) so a buyer can
   *  stack a gift card with a coupon/reward voucher, unlike coupon vs.
   *  reward-voucher which share one slot. Applies across ALL of that
   *  store's items (no "not combinable with sale items" exclusion — a gift
   *  card spends the buyer's own money/credit, it isn't a promotional
   *  stacking concern the way a coupon code is). Only ever partially
   *  consumes the card's balance here — the actual deduction happens at
   *  order placement (see GiftCardsService.redeemAtOrderPlacement), so an
   *  abandoned checkout never burns real gift-card value. */
  async applyGiftCard(userId: string, body: any) {
    const { checkoutId, code } = body;
    if (!checkoutId) throw new BadRequestException('checkoutId is required');
    if (!code || !String(code).trim()) throw new BadRequestException('Gift card code is required');

    const { checkoutModel } = this.databaseService.repositories;
    const checkout = await checkoutModel.findOne({ _id: checkoutId, userId, isDelete: false });
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status === 'payment_pending')
      throw new BadRequestException('Payment has already been started for this checkout — start a new checkout to change it');
    if (checkout.status === 'completed') throw new BadRequestException('Checkout already completed');
    if (checkout.status === 'cancelled') throw new BadRequestException('Checkout is cancelled');
    if (checkout.status === 'expired') throw new BadRequestException('Checkout has expired');
    if (checkout.expiredAt && checkout.expiredAt < new Date()) {
      await checkoutModel.findByIdAndUpdate(checkout._id, { status: 'expired' });
      throw new BadRequestException('Checkout has expired');
    }

    const normalizedCode = String(code).trim().toUpperCase();
    const items = checkout.items as any[];
    const storeIdsInCheckout = [...new Set(items.map((i) => i.storeId))];

    let giftCard: any = null;
    for (const sId of storeIdsInCheckout) {
      giftCard = await this.giftCardsService.findRedeemable(sId, normalizedCode);
      if (giftCard) break;
    }
    if (!giftCard) {
      throw new BadRequestException('This gift card code is invalid, inactive, or not applicable to items in your cart');
    }

    this.revertGiftCardFromItems(items);
    const storeItems = items.filter((i) => i.storeId === giftCard.storeId);
    const storeSubtotal = this.round(storeItems.reduce((s, i) => s + i.totalPrice, 0));
    if (storeSubtotal <= 0) {
      throw new BadRequestException("There's nothing left to apply this gift card to.");
    }

    const appliedAmount = this.round(Math.min(giftCard.balance, storeSubtotal));
    this.distributeGiftCardDiscount(storeItems, appliedAmount);

    const newSubtotal = this.convertedSubtotal(items, checkout.currency, checkout.fxSnapshots as any);
    const newTotal = this.round(newSubtotal + (checkout.shippingFee || 0));

    await checkoutModel.findByIdAndUpdate(checkoutId, {
      items: items.map((i: any) => (i.toObject ? i.toObject() : i)),
      subtotal: newSubtotal,
      totalAmount: newTotal,
      giftCardCode: normalizedCode,
      giftCardStoreId: giftCard.storeId,
      giftCardDiscountTotalUSD: appliedAmount,
    });

    return {
      success: true,
      message: 'Gift card applied',
      data: {
        checkoutId,
        giftCardCode: normalizedCode,
        giftCardDiscountUSD: appliedAmount,
        remainingBalance: this.round(giftCard.balance - appliedAmount),
        subtotal: newSubtotal,
        shippingFee: checkout.shippingFee || 0,
        totalAmount: newTotal,
        ...this.splitSubtotalsByType(items),
      },
    };
  }

  async removeGiftCard(userId: string, body: any) {
    const { checkoutId } = body;
    if (!checkoutId) throw new BadRequestException('checkoutId is required');

    const { checkoutModel } = this.databaseService.repositories;
    const checkout = await checkoutModel.findOne({ _id: checkoutId, userId, isDelete: false });
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status === 'payment_pending')
      throw new BadRequestException('Payment has already been started for this checkout — start a new checkout to change it');
    if (checkout.status === 'completed') throw new BadRequestException('Checkout already completed');
    if (checkout.status === 'cancelled') throw new BadRequestException('Checkout is cancelled');
    if (checkout.status === 'expired') throw new BadRequestException('Checkout has expired');

    const items = checkout.items as any[];
    this.revertGiftCardFromItems(items);
    // Same safety reasoning as removeCoupon's symmetric revert — see there.
    const hadCoupon = !!checkout.couponCode;
    this.revertCouponFromItems(items);

    const newSubtotal = this.convertedSubtotal(items, checkout.currency, checkout.fxSnapshots as any);
    const newTotal = this.round(newSubtotal + (checkout.shippingFee || 0));

    await checkoutModel.findByIdAndUpdate(checkoutId, {
      items: items.map((i: any) => (i.toObject ? i.toObject() : i)),
      subtotal: newSubtotal,
      totalAmount: newTotal,
      giftCardCode: null,
      giftCardStoreId: null,
      giftCardDiscountTotalUSD: 0,
      ...(hadCoupon ? { couponCode: null, couponStoreId: null, couponSourceType: 'coupon', couponDiscountTotalUSD: 0 } : {}),
    });

    return {
      success: true,
      message: hadCoupon ? 'Gift card removed — please re-apply your coupon' : 'Gift card removed',
      data: {
        checkoutId,
        subtotal: newSubtotal,
        shippingFee: checkout.shippingFee || 0,
        totalAmount: newTotal,
        ...this.splitSubtotalsByType(items),
      },
    };
  }

  /** Restores each item's pre-gift-card price/totalPrice in place — a no-op
   *  for items that never had a gift card applied. Mirrors
   *  revertCouponFromItems below. */
  private revertGiftCardFromItems(items: any[]) {
    for (const item of items) {
      if (item.totalPriceBeforeGiftCard != null) {
        item.price = item.priceBeforeGiftCard;
        item.totalPrice = item.totalPriceBeforeGiftCard;
        item.priceBeforeGiftCard = null;
        item.totalPriceBeforeGiftCard = null;
        item.giftCardDiscountUSD = 0;
      }
    }
  }

  /** Same distribution math as distributeCouponDiscount, writing to the
   *  gift-card-specific item fields instead so the two discounts never
   *  clobber each other's "before" bookkeeping when both are applied. */
  private distributeGiftCardDiscount(storeItems: any[], totalDiscount: number) {
    this.proportionallyDistribute(storeItems, totalDiscount, (item, share) => {
      item.priceBeforeGiftCard = item.price;
      item.totalPriceBeforeGiftCard = item.totalPrice;
      item.giftCardDiscountUSD = share;
      item.totalPrice = this.round(item.totalPrice - share);
      item.price = item.quantity > 0 ? this.round(item.totalPrice / item.quantity) : item.totalPrice;
    });
  }

  /** Fallback path for applyCoupon when the typed code isn't a Coupon —
   *  checks whether it's an active RewardVoucher issued to this buyer by
   *  LoyaltyService.redeemReward instead. Always store-scoped (loyalty
   *  programs are per-store) and shares the same couponCode/couponStoreId
   *  checkout slot as a real coupon (see Checkout.couponSourceType) — only
   *  one of the two can be applied at a time, same as switching coupon codes. */
  private async applyRewardVoucher(
    checkout: any,
    items: any[],
    storeIdsInCheckout: string[],
    normalizedCode: string,
    userId: string,
  ) {
    const { checkoutModel, rewardVoucherModel } = this.databaseService.repositories;

    const voucher = await rewardVoucherModel.findOne({
      code: normalizedCode,
      userId,
      status: 'active',
      isDelete: false,
      storeId: { $in: storeIdsInCheckout },
    });
    if (!voucher)
      throw new BadRequestException(
        'This coupon code is invalid or not applicable to items in your cart',
      );
    if (voucher.expiresAt < new Date()) {
      await rewardVoucherModel.updateOne({ _id: voucher._id }, { status: 'expired' });
      throw new BadRequestException('This reward code has expired');
    }

    this.revertCouponFromItems(items);
    const storeItems = items.filter((i) => i.storeId === voucher.storeId);

    if (voucher.type === 'fixed_discount') {
      const eligibleItems = storeItems.filter((i) => !(i.campaignDiscountUSD > 0));
      if (eligibleItems.length === 0) {
        throw new BadRequestException(
          "This reward can't be combined with the active sale on these items.",
        );
      }
      const eligibleSubtotal = this.round(eligibleItems.reduce((s, i) => s + i.totalPrice, 0));
      const totalDiscount = Math.min(voucher.discountValue ?? 0, eligibleSubtotal);
      if (totalDiscount <= 0) {
        throw new BadRequestException("This reward doesn't apply any discount to your cart.");
      }
      // discountValue is captured (at redemption time) in the issuing
      // store's own baseCurrency, and eligibleItems' totalPrice is that same
      // store's native currency — no FX conversion needed, unlike a
      // platform-scope Coupon.
      this.distributeCouponDiscount(eligibleItems, totalDiscount);

      const newSubtotal = this.convertedSubtotal(items, checkout.currency, checkout.fxSnapshots as any);
      const newTotal = this.round(newSubtotal + (checkout.shippingFee || 0));

      await checkoutModel.findByIdAndUpdate(checkout._id, {
        items: items.map((i: any) => (i.toObject ? i.toObject() : i)),
        subtotal: newSubtotal,
        totalAmount: newTotal,
        couponCode: normalizedCode,
        couponStoreId: voucher.storeId,
        couponSourceType: 'reward_voucher',
        couponDiscountTotalUSD: totalDiscount,
      });

      return {
        success: true,
        message: 'Reward applied',
        data: {
          checkoutId: checkout._id,
          couponCode: normalizedCode,
          couponDiscountUSD: totalDiscount,
          subtotal: newSubtotal,
          shippingFee: checkout.shippingFee || 0,
          totalAmount: newTotal,
          ...this.splitSubtotalsByType(items),
        },
      };
    }

    // free_product — the buyer must already have that exact product in
    // their cart at this store; this voucher then zeroes out exactly one
    // unit of it. Auto-adding an unrelated product to the cart would need
    // full variant/price/stock resolution this flow doesn't otherwise do —
    // a disclosed, deliberate scope boundary.
    const targetItem = storeItems.find((i) => i.productId === voucher.productId);
    if (!targetItem) {
      throw new BadRequestException(
        'Add the free reward product to your cart first, then apply this code.',
      );
    }
    const unitPrice = targetItem.quantity > 0 ? targetItem.totalPrice / targetItem.quantity : targetItem.totalPrice;
    const freeAmount = this.round(Math.min(unitPrice, targetItem.totalPrice));
    targetItem.priceBeforeCoupon = targetItem.price;
    targetItem.totalPriceBeforeCoupon = targetItem.totalPrice;
    targetItem.couponDiscountUSD = freeAmount;
    targetItem.totalPrice = this.round(targetItem.totalPrice - freeAmount);
    targetItem.price = targetItem.quantity > 0 ? this.round(targetItem.totalPrice / targetItem.quantity) : targetItem.totalPrice;

    const newSubtotal = this.convertedSubtotal(items, checkout.currency, checkout.fxSnapshots as any);
    const newTotal = this.round(newSubtotal + (checkout.shippingFee || 0));

    await checkoutModel.findByIdAndUpdate(checkout._id, {
      items: items.map((i: any) => (i.toObject ? i.toObject() : i)),
      subtotal: newSubtotal,
      totalAmount: newTotal,
      couponCode: normalizedCode,
      couponStoreId: voucher.storeId,
      couponSourceType: 'reward_voucher',
      couponDiscountTotalUSD: freeAmount,
    });

    return {
      success: true,
      message: 'Reward applied — one free item added',
      data: {
        checkoutId: checkout._id,
        couponCode: normalizedCode,
        couponDiscountUSD: freeAmount,
        subtotal: newSubtotal,
        shippingFee: checkout.shippingFee || 0,
        totalAmount: newTotal,
        ...this.splitSubtotalsByType(items),
      },
    };
  }

  /** Restores each item's pre-coupon price/totalPrice in place (mutates the
   *  passed array) — a no-op for items that never had a coupon applied. */
  private revertCouponFromItems(items: any[]) {
    for (const item of items) {
      if (item.totalPriceBeforeCoupon != null) {
        item.price = item.priceBeforeCoupon;
        item.totalPrice = item.totalPriceBeforeCoupon;
        item.priceBeforeCoupon = null;
        item.totalPriceBeforeCoupon = null;
        item.couponDiscountUSD = 0;
        item.couponSponsorType = null;
      }
    }
  }

  /** Splits [totalDiscount] proportionally across [items] by each item's
   *  share of their combined totalPrice, invoking [applyToItem] once per item
   *  with its allocated share. The last item absorbs the rounding remainder
   *  so per-item shares always sum to `totalDiscount` exactly. Shared math
   *  behind both coupon and campaign discount application — only the fields
   *  each writes differ, not the allocation itself. */
  private proportionallyDistribute(
    items: any[],
    totalDiscount: number,
    applyToItem: (item: any, share: number) => void,
  ) {
    if (totalDiscount <= 0 || items.length === 0) return;
    const combinedSubtotal = items.reduce((s, i) => s + i.totalPrice, 0);
    if (combinedSubtotal <= 0) return;

    let allocated = 0;
    items.forEach((item, idx) => {
      const isLast = idx === items.length - 1;
      const share = isLast
        ? this.round(totalDiscount - allocated)
        : this.round(totalDiscount * (item.totalPrice / combinedSubtotal));
      allocated = this.round(allocated + share);
      applyToItem(item, share);
    });
  }

  /** Distributes a coupon's discount across the items it applies to, mutating
   *  price/totalPrice in place and keeping the pre-coupon baseline so
   *  removing/replacing a coupon can cleanly revert without compounding. */
  private distributeCouponDiscount(storeItems: any[], totalDiscount: number) {
    this.proportionallyDistribute(storeItems, totalDiscount, (item, share) => {
      item.priceBeforeCoupon = item.price;
      item.totalPriceBeforeCoupon = item.totalPrice;
      item.couponDiscountUSD = share;
      item.totalPrice = this.round(item.totalPrice - share);
      item.price =
        item.quantity > 0
          ? this.round(item.totalPrice / item.quantity)
          : item.totalPrice;
    });
  }

  /** Same as `distributeCouponDiscount`, but for a platform-wide coupon
   *  whose eligible items can span multiple sellers/native currencies.
   *  [totalDiscount] is denominated in [basisCurrency] (the checkout's own
   *  display currency) — each item's proportional weight AND its final
   *  deducted share are computed by converting through [basisCurrency] and
   *  back into that item's own native currency, so a PKR line and a USD
   *  line in the same eligible set are never summed/subtracted as raw
   *  numbers of two different units. */
  private distributePlatformCouponDiscount(
    items: any[],
    totalDiscount: number,
    basisCurrency: string,
    fxSnapshots: FxSnapshot[],
  ) {
    if (totalDiscount <= 0 || items.length === 0) return;
    const weights = items.map((item) =>
      this.exchangeRateService.convertWithSnapshots(
        item.totalPrice,
        item.currency ?? basisCurrency,
        basisCurrency,
        fxSnapshots ?? [],
      ),
    );
    const combinedSubtotal = weights.reduce((s, w) => s + w, 0);
    if (combinedSubtotal <= 0) return;

    let allocatedInBasisCurrency = 0;
    items.forEach((item, idx) => {
      const isLast = idx === items.length - 1;
      const shareInBasisCurrency = isLast
        ? this.round(totalDiscount - allocatedInBasisCurrency)
        : this.round(totalDiscount * (weights[idx] / combinedSubtotal));
      allocatedInBasisCurrency = this.round(allocatedInBasisCurrency + shareInBasisCurrency);

      const shareInItemCurrency = this.exchangeRateService.convertWithSnapshots(
        shareInBasisCurrency,
        basisCurrency,
        item.currency ?? basisCurrency,
        fxSnapshots ?? [],
      );
      item.priceBeforeCoupon = item.price;
      item.totalPriceBeforeCoupon = item.totalPrice;
      item.couponDiscountUSD = shareInItemCurrency;
      item.totalPrice = this.round(item.totalPrice - shareInItemCurrency);
      item.price =
        item.quantity > 0
          ? this.round(item.totalPrice / item.quantity)
          : item.totalPrice;
    });
  }

  /** Distributes a seller's own AutomaticDiscount (DiscountsService) across
   *  the subset of items it targets — same math as distributeCampaignDiscount,
   *  writing to the discount-specific fields instead. */
  private distributeAutoDiscount(items: any[], totalDiscount: number, discountId: string) {
    this.proportionallyDistribute(items, totalDiscount, (item, share) => {
      if (item.originalPrice == null) item.originalPrice = item.price;
      item.autoDiscountId = discountId;
      item.autoDiscountUSD = share;
      item.totalPrice = this.round(item.totalPrice - share);
      item.price =
        item.quantity > 0
          ? this.round(item.totalPrice / item.quantity)
          : item.totalPrice;
    });
  }
}
