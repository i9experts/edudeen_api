import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';
import { MarketingService } from 'src/marketing/marketing.service';
import { pickBestCampaign } from 'src/marketing/campaign-pricing.util';
import { AdminConfigService } from 'src/admin-config/admin-config.service';
import { ExchangeRateService } from 'src/exchange-rate/exchange-rate.service';
import { SUPPORTED_CURRENCIES, FxSnapshot } from 'src/exchange-rate/schemas/exchange-rate.schema';
import { GiftCardsService } from 'src/gift-cards/gift-cards.service';
import { DiscountsService } from 'src/discounts/discounts.service';

// Shipping zones are a Pakistan-domestic geography feature (predates the
// PKR/USD split entirely) — ShippingZone.shippingPrice has no currency
// field of its own because every zone was always implicitly priced in PKR.
// Rather than add a schema field for something that's effectively one fixed
// currency by design, this constant documents that assumption at its one
// point of use (addShippingInCheckout) instead.
const SHIPPING_ZONE_CURRENCY = 'PKR';

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

    // Cart is now store-scoped (a buyer can have a separate cart per store's
    // subdomain) — without storeId this lookup would be ambiguous the moment
    // a buyer has shopped at more than one store.
    const { storeId } = body;
    if (!storeId) throw new BadRequestException('storeId is required');

    const cart = await cartModel.findOne({
      userId,
      storeId,
      status: 'active',
      isDelete: false,
    });
    if (!cart) throw new BadRequestException('Cart not found');
    if (!cart.items || cart.items.length === 0)
      throw new BadRequestException('Cart is empty');

    // agar items array diya to sirf woh, warna sab cart items
    const selectedItems: any[] =
      body.items && Array.isArray(body.items) && body.items.length > 0
        ? cart.items.filter((cartItem: any) =>
            body.items.some(
              (sel: any) =>
                sel.productId === cartItem.productId &&
                sel.variantId === cartItem.productVariantId,
            ),
          )
        : cart.items;

    if (selectedItems.length === 0)
      throw new BadRequestException('None of the provided items found in cart');

    const checkoutItems: any[] = [];
    let hasPhysical = false;

    // Cache one lookup per store so a multi-item cart from the same store
    // doesn't re-query the buyer's subscription per item.
    const benefitsCache = new Map<
      string,
      { benefits: any[]; planName: string } | null
    >();
    const getBenefits = async (storeId: string) => {
      if (!benefitsCache.has(storeId)) {
        benefitsCache.set(
          storeId,
          await this.subscriptionBenefits.getActiveBenefits(userId, storeId),
        );
      }
      return benefitsCache.get(storeId);
    };

    let subscriberSavingsUSD = 0;

    // Cache one lookup per store — a multi-item cart from the same store
    // shouldn't re-query the store's status per item.
    const storeStatusCache = new Map<string, boolean>();
    const isStoreActive = async (storeId: string): Promise<boolean> => {
      if (!storeStatusCache.has(storeId)) {
        const store = await storeModel
          .findOne({ _id: storeId, isDelete: false })
          .select('status')
          .lean();
        storeStatusCache.set(storeId, !!store && (store as any).status === 'active');
      }
      return storeStatusCache.get(storeId)!;
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
    const storeSubtotals = new Map<string, number>();

    for (const cartItem of selectedItems) {
      const product = await productModel.findOne({
        _id: cartItem.productId,
        status: 'active',
        isDelete: false,
      });
      if (!product)
        throw new BadRequestException(
          `Product not found: ${cartItem.productId}`,
        );

      // A seller/store can be suspended after an item was already sitting
      // in the buyer's cart — checkout must re-check store status at the
      // moment of purchase, not just at add-to-cart time.
      if (!(await isStoreActive(product.storeId))) {
        throw new BadRequestException(
          `"${product.name}" is no longer available for purchase because the seller's store is not active. Please remove it from your cart.`,
        );
      }

      const variant = await productVariantModel.findOne({
        _id: cartItem.productVariantId,
        status: 'active',
        isDelete: false,
      });
      if (!variant)
        throw new BadRequestException(
          `Variant not found: ${cartItem.productVariantId}`,
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

    // Batch-resolve seller name + verification badge across every distinct
    // seller in this checkout — same one-query-instead-of-N pattern used on
    // the product listing endpoints.
    const sellerIds = [
      ...new Set(rawItems.map((r) => r.product.sellerId).filter(Boolean)),
    ];
    const sellers = sellerIds.length
      ? await this.databaseService.repositories.sellerModel
          .find({ _id: { $in: sellerIds } })
          .select('name isVerified')
          .lean()
      : [];
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
        licenseType: product.digital?.licenseType ?? null,
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
      await this.marketingService.getActiveCampaignsForStores(cartStoreIds);

    for (const storeId of cartStoreIds) {
      const campaigns = activeCampaignsByStore.get(storeId);
      if (!campaigns || campaigns.length === 0) continue;

      const storeItems = checkoutItems.filter((i) => i.storeId === storeId);
      const storeSubtotal = this.round(
        storeItems.reduce((s, i) => s + i.totalPrice, 0),
      );
      const best = pickBestCampaign(campaigns, storeSubtotal);
      if (!best || best.discountAmount <= 0) continue;

      this.distributeCampaignDiscount(
        storeItems,
        best.discountAmount,
        best.campaign.campaignId,
        best.campaign.sponsorType,
      );
      campaignSavingsUSD = this.round(campaignSavingsUSD + best.discountAmount);
      appliedCampaigns.push({
        campaignId: best.campaign.campaignId,
        name: best.campaign.name,
        storeId,
        discountUSD: best.discountAmount,
        sponsorType: best.campaign.sponsorType,
      });
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
          ? this.round(eligibleSubtotal * (discount.discountValue / 100))
          : Math.min(discount.discountValue, eligibleSubtotal);
        if (amount <= 0) continue;

        if (!best || amount > best.amount) best = { discount, items: eligible, amount };
      }

      if (best) {
        this.distributeAutoDiscount(best.items, best.amount, String(best.discount._id));
        autoDiscountSavingsUSD = this.round(autoDiscountSavingsUSD + best.amount);
      }
    }

    let defaultAddressId: string | null = null;

    if (hasPhysical) {
      let defaultAddress = await addressModel.findOne({ userId, isDefault: true, isDelete: false });

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
        const store = await this.databaseService.repositories.storeModel
          .findById(sid)
          .select('name slug')
          .lean();
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
      totalAmount,
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
    const codEligible = hasPhysical
      ? (
          await this.databaseService.repositories.storeModel
            .find({ _id: { $in: physicalStoreIds } })
            .select('codEnabled')
            .lean()
        ).every((s: any) => s.codEnabled !== false)
      : true;

    // Manual bank-transfer (Pakistan track — pay into the platform's own
    // account, upload proof) is a Stripe-equivalent alternative, not a COD
    // substitute — it's offered alongside 'stripe' whenever an admin has it
    // enabled, regardless of digital/physical mix. Admin-config-gated so it
    // can be turned off platform-wide without a deploy.
    const manualTransferEnabled = await this.adminConfigService.isManualPaymentEnabled();
    const withManualTransfer = (methods: string[]) =>
      manualTransferEnabled ? [...methods, 'manual_bank_transfer'] : methods;

    return {
      success: true,
      message: 'Checkout created successfully',
      data: {
        checkout,
        // A mixed cart can either pay everything online ('stripe') or split
        // it — digital online now, physical via COD on delivery ('split').
        // Digital-only carts never get COD; physical-only carts keep both
        // 'stripe' and 'cash_on_delivery' as before — unless COD isn't
        // eligible (see codEligible above), in which case 'stripe' (pay
        // everything online) is always the safe fallback.
        allowedPaymentMethods: hasDigital
          ? withManualTransfer(hasPhysical && codEligible ? ['stripe', 'split'] : ['stripe'])
          : withManualTransfer(codEligible ? ['stripe', 'cash_on_delivery'] : ['stripe']),
        summary: {
          subtotal,
          shippingFee: 0,
          taxAmount,
          totalAmount,
          subscriberSavingsUSD: this.round(subscriberSavingsUSD),
          campaignDiscountUSD: campaignSavingsUSD,
          autoDiscountUSD: autoDiscountSavingsUSD,
          ...this.splitSubtotalsByType(checkoutItems),
        },
        subscriptionSavingsHints,
        appliedCampaigns,
      },
    };
  }

  async addShippingInCheckout(userId: string, body: any) {
    const { checkoutId, shippingZoneId } = body;

    if (!checkoutId) throw new BadRequestException('checkoutId is required');
    if (!shippingZoneId)
      throw new BadRequestException('shippingZoneId is required');

    const { checkoutModel, shippingZoneModel } =
      this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });
    if (!checkout) throw new NotFoundException('Checkout not found');
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
    });
    if (!shippingZone) throw new NotFoundException('Shipping zone not found');

    // ShippingZone.shippingPrice is always PKR (see SHIPPING_ZONE_CURRENCY's
    // comment) — converted into this checkout's own currency using its
    // already-frozen fxSnapshots, never a fresh live rate.
    let shippingFee = this.exchangeRateService.convertWithSnapshots(
      shippingZone.shippingPrice || 0,
      SHIPPING_ZONE_CURRENCY,
      checkout.currency,
      (checkout.fxSnapshots as any) ?? [],
    );

    // Free/discounted shipping benefit — only applied when every item in the
    // checkout belongs to a single store (the shipping fee itself is a flat,
    // whole-checkout amount, not per-seller, so a mixed-store cart can't
    // unambiguously attribute the waiver to one store's membership).
    const storeIdsInCheckout = [
      ...new Set((checkout.items as any[]).map((i) => i.storeId)),
    ];
    if (storeIdsInCheckout.length === 1) {
      const benefitsEntry = await this.subscriptionBenefits.getActiveBenefits(
        userId,
        storeIdsInCheckout[0],
      );
      if (benefitsEntry) {
        const shippingBenefit =
          this.subscriptionBenefits.resolveShippingBenefit(
            benefitsEntry.benefits,
          );
        if (
          shippingBenefit &&
          (shippingBenefit.minOrderValueForShippingUSD == null ||
            checkout.subtotal >= shippingBenefit.minOrderValueForShippingUSD)
        ) {
          shippingFee = this.round(
            shippingFee * (1 - shippingBenefit.discountPercent / 100),
          );
        }
      }
    }

    const totalAmount = this.round(checkout.subtotal + shippingFee);

    await checkoutModel.findByIdAndUpdate(checkoutId, {
      shippingZoneId,
      shippingFee,
      totalAmount,
    });

    return {
      success: true,
      message: 'Shipping added to checkout',
      data: {
        checkoutId,
        shippingZoneId,
        shippingFee,
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

      // get all shipping zones
      const shippingZones = await shippingZoneModel
        .find({
          isDelete: false,
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
        ? this.round(eligibleSubtotal * (coupon.discountValue / 100))
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

  /** Distributes an automatic platform-campaign discount across a store's
   *  items, mutating price/totalPrice in place. Unlike a coupon, a campaign
   *  discount is never toggled off by the buyer, so it needs no "before"
   *  revert fields — it's simply recomputed fresh every time a checkout is
   *  (re)created from the cart. `originalPrice` is set only if a subscriber
   *  discount hasn't already set it, so it always reflects the true pre-any-
   *  discount price for receipt display. */
  private distributeCampaignDiscount(
    storeItems: any[],
    totalDiscount: number,
    campaignId: string,
    sponsorType: 'seller' | 'platform',
  ) {
    this.proportionallyDistribute(storeItems, totalDiscount, (item, share) => {
      if (item.originalPrice == null) item.originalPrice = item.price;
      item.campaignId = campaignId;
      item.campaignDiscountUSD = share;
      item.campaignSponsorType = sponsorType;
      item.totalPrice = this.round(item.totalPrice - share);
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
