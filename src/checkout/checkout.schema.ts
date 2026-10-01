import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { FxSnapshot, FxSnapshotSchema } from '../exchange-rate/schemas/exchange-rate.schema';

export type CheckoutDocument = Checkout & Document;

@Schema({ _id: false })
export class CheckoutItem {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, required: true })
  variantId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, default: null })
  sellerName: string | null;

  @Prop({ type: Boolean, default: false })
  sellerVerified: boolean;

  @Prop({ type: String, required: true })
  storeId: string;

  @Prop({ type: String, enum: ['physical', 'digital'], required: true })
  type: string;

  // Product's own category (educational collapses into `type: 'digital'` above
  // for fulfillment) — carried through to the placed Order so history/labels
  // can distinguish it later.
  @Prop({
    type: String,
    enum: ['physical', 'digital', 'educational'],
    default: null,
  })
  productType: string | null;

  // snapshot fields
  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, default: null })
  image: string | null;

  @Prop({ type: String, default: null })
  sku: string | null;

  @Prop({ type: [{ name: String, value: String }], default: [] })
  options: { name: string; value: string }[];

  @Prop({ type: String, default: null })
  licenseType: string | null;

  @Prop({ required: true })
  quantity: number;

  // The currency `price`/`totalPrice` below are denominated in — this
  // item's OWNING SELLER'S Store.baseCurrency at the moment it was added to
  // this checkout, independent of the buyer's chosen checkout currency
  // above. A mixed-seller cart can have items in different native
  // currencies; each is converted into the checkout currency individually
  // (see CheckoutService.createCheckout) rather than summed raw. Nullable
  // only so checkouts created before this field existed remain readable —
  // those predate any real seller-currency distinction (implicitly 'USD').
  @Prop({ type: String, default: null })
  currency: string | null;

  @Prop({ required: true })
  price: number;

  @Prop({ required: true })
  totalPrice: number;

  // Set only when a subscriber discount was applied server-side. `price`/
  // `totalPrice` above already reflect the discounted amount — these are
  // kept for receipt display ("you saved $X") and analytics.
  @Prop({ type: Number, default: null })
  originalPrice: number | null;

  @Prop({ type: Number, default: 0 })
  subscriberDiscountUSD: number;

  // Coupon discount allocated to this line (only set for items belonging to
  // the coupon's store — see CheckoutService.applyCoupon). `price`/
  // `totalPrice` above already reflect the discount; these two "before"
  // fields are the pre-coupon baseline so removing/replacing a coupon can
  // cleanly revert without compounding.
  @Prop({ type: Number, default: 0 })
  couponDiscountUSD: number;

  @Prop({ type: Number, default: null })
  priceBeforeCoupon: number | null;

  @Prop({ type: Number, default: null })
  totalPriceBeforeCoupon: number | null;

  // Same "before" pattern as the coupon fields above, but for a GiftCard's
  // balance applied at checkout (see CheckoutService.applyGiftCard) — kept
  // fully independent since a gift card and a coupon can be applied to the
  // same checkout together (see Checkout.giftCardCode).
  @Prop({ type: Number, default: 0 })
  giftCardDiscountUSD: number;

  @Prop({ type: Number, default: null })
  priceBeforeGiftCard: number | null;

  @Prop({ type: Number, default: null })
  totalPriceBeforeGiftCard: number | null;

  // Automatic platform-campaign discount (see MarketingService's active-campaign
  // lookup) — resolved once at checkout-creation time from the item's store's
  // active campaign, same "computed server-side, never client-supplied" rule as
  // subscriberDiscountUSD. `price`/`totalPrice` above already reflect it.
  @Prop({ type: String, default: null })
  campaignId: string | null;

  @Prop({ type: Number, default: 0 })
  campaignDiscountUSD: number;

  // A seller's own no-code automatic discount (see DiscountsService) —
  // resolved the same pass as campaignId/campaignDiscountUSD above, right
  // after it, on top of the (already campaign-discounted) totalPrice. Never
  // set on an item that already got a campaignDiscountUSD (same "not
  // combinable with an active sale" rule a manually-typed Coupon follows).
  @Prop({ type: String, default: null })
  autoDiscountId: string | null;

  @Prop({ type: Number, default: 0 })
  autoDiscountUSD: number;

  // Who bears campaignDiscountUSD's cost — see Campaign.sponsorType. Carried
  // onto the placed Order so PaymentService/OrdersService know, without a
  // lookup, whether to restore the seller's payout for this line.
  @Prop({ type: String, enum: ['seller', 'platform'], default: null })
  campaignSponsorType: 'seller' | 'platform' | null;
}

export const CheckoutItemSchema = SchemaFactory.createForClass(CheckoutItem);

@Schema({ timestamps: true })
export class Checkout {
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, default: null })
  addressId: string | null;

  // The currency the buyer is actually being charged in — server-resolved
  // and validated at checkout creation (CheckoutService.createCheckout)
  // against the buyer's currencyPreference, never client-trusted beyond
  // that validation. No schema-level default anymore: every NEW checkout
  // must set this explicitly. Existing pre-migration checkouts (which relied
  // on the old implicit 'USD' default) are transient/expired documents and
  // are left exactly as they were written — never touched by this change.
  @Prop({ type: String })
  currency: string;

  // One entry per distinct currency actually involved in this checkout (the
  // checkout currency itself, plus every seller/store currency present
  // among `items`) — immutable the instant this document is created.
  // Refunds and seller settlement replay these exact rates; they never
  // re-read today's ExchangeRate table. Absent on any checkout created
  // before this field existed.
  @Prop({ type: [FxSnapshotSchema], default: [] })
  fxSnapshots: FxSnapshot[];

  @Prop({ type: [CheckoutItemSchema], default: [] })
  items: CheckoutItem[];

  @Prop({ type: String, default: null })
  shippingZoneId: string | null;

  @Prop({ type: String, enum: ['cash_on_delivery', 'stripe', 'manual_bank_transfer', 'free'], default: null })
  paymentType: string | null;

  @Prop({ type: String, default: null })
  paymentMethodId: string | null;

  @Prop({ default: 0 })
  subtotal: number;

  @Prop({ default: 0 })
  shippingFee: number;

  // Per-seller shipping lines (sellers ship separately): one entry per store with
  // physical items, in the checkout's currency. `shippingFee` above is their sum.
  // `baseFee` is the platform shipping-zone fee before that store's free/discounted
  // shipping subscriber benefit; `discountPercent` the benefit applied (0 = none).
  // Empty on checkouts created before per-store shipping existed.
  @Prop({
    type: [{ _id: false, storeId: String, fee: Number, baseFee: Number, discountPercent: Number }],
    default: [],
  })
  shippingByStore: { storeId: string; fee: number; baseFee: number; discountPercent: number }[];

  @Prop({ default: 0 })
  taxAmount: number;

  // Total subscriber-benefit savings applied server-side (line-item discounts
  // + shipping waiver). Shown to the buyer as "you saved $X with your membership".
  @Prop({ default: 0 })
  subscriberSavingsUSD: number;

  // Store-scoped coupon applied via CheckoutService.applyCoupon — a coupon
  // only ever discounts the items belonging to its own store, even in a
  // multi-store cart. `couponStoreId` records which store's items the
  // discount was distributed across (see CheckoutItem.couponDiscountUSD).
  // Distinct from subscriberSavingsUSD, which is a membership benefit, not
  // a code the buyer typed in.
  @Prop({ type: String, default: null })
  couponCode: string | null;

  @Prop({ type: String, default: null })
  couponStoreId: string | null;

  // Distinguishes a real Coupon from a LoyaltyReward redemption voucher
  // sharing this same couponCode/couponStoreId slot — see
  // CheckoutService.applyCoupon's reward-voucher fallback and
  // PaymentService.createOrder's usage-marking branch.
  @Prop({ type: String, enum: ['coupon', 'reward_voucher'], default: 'coupon' })
  couponSourceType: 'coupon' | 'reward_voucher';

  @Prop({ default: 0 })
  couponDiscountTotalUSD: number;

  // A GiftCard is balance-based (partial spend across multiple orders), a
  // fundamentally different mechanic from a single-use Coupon/RewardVoucher
  // — it gets its own checkout slot so a buyer can stack a gift card AND a
  // coupon/reward on the same order (real stores commonly allow this),
  // unlike coupon vs. reward-voucher which share one slot (see
  // couponSourceType above) since only one "promo code" is ever typed in at
  // a time. See CheckoutService.applyGiftCard/removeGiftCard.
  @Prop({ type: String, default: null })
  giftCardCode: string | null;

  @Prop({ type: String, default: null })
  giftCardStoreId: string | null;

  @Prop({ default: 0 })
  giftCardDiscountTotalUSD: number;

  // Sum of every item's campaignDiscountUSD — a multi-store cart can have a
  // different active campaign per store, so (unlike couponCode/couponStoreId)
  // there's no single "the" campaign at the checkout level, only this total.
  @Prop({ default: 0 })
  campaignDiscountTotalUSD: number;

  // Sum of every item's autoDiscountUSD — same "no single id at checkout
  // level" reasoning as campaignDiscountTotalUSD above (a multi-store cart
  // can have a different seller automatic discount per store).
  @Prop({ default: 0 })
  autoDiscountTotalUSD: number;

  // Set client-side from whichever promotional banner the buyer clicked
  // through (localStorage attribution token, short TTL) — copied onto the
  // resulting Order(s) at placeOrder so promotion analytics can attribute
  // conversions/revenue, same convention as couponCode above. `attributedBannerId`
  // covers the platform `Banner` collection (admin-authored AND
  // PromotionRequest-derived banners are both stored there, same id space);
  // `attributedStoreBannerId` covers a seller's own `StoreBanner`. Never a
  // PromotionRequest id directly — buyers never see/click that document,
  // only the Banner row it produces once approved+paid.
  @Prop({ type: String, default: null })
  attributedBannerId: string | null;

  @Prop({ type: String, default: null })
  attributedStoreBannerId: string | null;

  @Prop({ required: true })
  totalAmount: number;

  @Prop({
    type: String,
    enum: ['pending', 'payment_pending', 'completed', 'expired', 'cancelled'],
    default: 'pending',
  })
  status: string;

  @Prop({ type: Date, default: null })
  expiredAt: Date | null;

  // Set atomically by the COD / bank-transfer paths (see
  // PaymentService.claimCheckoutForPlacement) so two concurrent requests for
  // the same checkout can never both place orders. Null/absent = unclaimed.
  @Prop({ type: Date, default: null })
  orderPlacementStartedAt: Date | null;

  // Marketing attribution — client-reported (mobile app has no meaningful
  // Referer/UTM headers), captured at checkout-creation time and copied onto
  // the resulting Order(s) for analytics. Defaults to 'other' when the
  // client doesn't send one; never inferred/fabricated server-side.
  @Prop({
    type: String,
    enum: [
      'marketplace_search',
      'direct_link',
      'social_media',
      'email',
      'other',
    ],
    default: 'other',
  })
  attributionSource: string;

  @Prop({ default: false })
  isDelete: boolean;
}

export const CheckoutSchema = SchemaFactory.createForClass(Checkout);

CheckoutSchema.index({ userId: 1 });
CheckoutSchema.index({ status: 1 });
CheckoutSchema.index({ createdAt: -1 });
CheckoutSchema.index({ 'items.sellerId': 1 });
CheckoutSchema.index({ 'items.storeId': 1 });
