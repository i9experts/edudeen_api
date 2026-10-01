import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { FxSnapshot, FxSnapshotSchema } from '../../exchange-rate/schemas/exchange-rate.schema';

export type OrderDocument = HydratedDocument<Order>;

@Schema({ _id: true })
export class OrderItem {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, default: null })
  variantId: string | null;

  @Prop({ type: String, enum: ['physical', 'digital'], required: true })
  type: string;

  // The product's own category — 'educational' collapses to `type: 'digital'` above
  // for fulfillment purposes, but is kept here too so order history/labels can
  // still say "Educational" instead of a generic "Digital". Absent on orders
  // placed before this field existed — display code must fall back to `type`.
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

  @Prop({ required: true })
  price: number;

  @Prop({ required: true })
  totalPrice: number;

  // Set only when a subscriber discount was applied at checkout — kept for
  // order-history display ("member savings: $X") and seller analytics.
  @Prop({ type: Number, default: null })
  originalPrice: number | null;

  @Prop({ type: Number, default: 0 })
  subscriberDiscountUSD: number;

  // Coupon discount allocated to this line at checkout — see
  // CheckoutItem.couponDiscountUSD, copied through at order creation.
  @Prop({ type: Number, default: 0 })
  couponDiscountUSD: number;

  // Gift card discount allocated to this line at checkout — see
  // CheckoutItem.giftCardDiscountUSD, copied through at order creation.
  @Prop({ type: Number, default: 0 })
  giftCardDiscountUSD: number;

  // Automatic platform-campaign discount allocated to this line at checkout —
  // see CheckoutItem.campaignId/campaignDiscountUSD, copied through as-is.
  @Prop({ type: String, default: null })
  campaignId: string | null;

  @Prop({ type: Number, default: 0 })
  campaignDiscountUSD: number;

  // A seller's own no-code automatic discount (DiscountsService) allocated
  // to this line at checkout — see CheckoutItem.autoDiscountId/autoDiscountUSD.
  @Prop({ type: String, default: null })
  autoDiscountId: string | null;

  @Prop({ type: Number, default: 0 })
  autoDiscountUSD: number;

  // Who bears campaignDiscountUSD — see Campaign.sponsorType /
  // CheckoutItem.campaignSponsorType. 'platform' means this line's discount
  // was reimbursed to the seller (see SellerOrder.platformSponsoredDiscountUSD),
  // not absorbed out of their own payout.
  @Prop({ type: String, enum: ['seller', 'platform'], default: null })
  campaignSponsorType: 'seller' | 'platform' | null;

  // cancel/refund item-level pe
  @Prop({
    type: String,
    enum: [
      'pending',
      'processing',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'refunded',
    ],
    default: 'pending',
  })
  status: string;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  @Prop({ type: String, default: null })
  cancelReason: string | null;

  @Prop({ default: 0 })
  refundedAmount: number;

  @Prop({ default: 0 })
  downloadCount!: number;

  // return fields
  @Prop({
    type: String,
    enum: ['none', 'requested', 'approved', 'rejected'],
    default: 'none',
  })
  returnStatus!: string;

  @Prop({ type: String, default: null })
  returnReason!: string | null;

  @Prop({ type: Date, default: null })
  returnRequestedAt!: Date | null;

  @Prop({ type: String, default: null })
  returnRejectReason!: string | null;
}

export const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

@Schema({ _id: false })
export class OrderTracking {
  @Prop({ type: String, default: null })
  carrier: string | null;

  @Prop({ type: String, default: null })
  trackingNumber: string | null;

  @Prop({ type: String, default: null })
  trackingUrl: string | null;
}

export const OrderTrackingSchema = SchemaFactory.createForClass(OrderTracking);

// ek store ka hissa — status items se derive hota hai
@Schema({ _id: true })
export class SellerOrder {
  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, required: true })
  storeId: string;

  @Prop({
    type: String,
    enum: ['physical', 'digital', 'mixed'],
    required: true,
  })
  fulfillmentType: string;

  // Who ships this sub-order's physical items, snapshotted from the store at
  // order creation. null/absent = 'seller' (every order placed before the
  // setting existed). 'platform' = the platform collects COD cash and handles
  // delivery, so the seller is credited the sale (see isSellerCollectedCod).
  @Prop({ type: String, enum: ['seller', 'platform', null], default: null })
  fulfillmentMode: string | null;

  // This store's own shipping line (sellers ship separately), in the ORDER's
  // currency, and the same amount in the seller's settlement currency. The
  // physical Order.shippingFee is the sum over its sellerOrders. 0 on digital
  // sub-orders and on orders placed before per-store shipping existed.
  @Prop({ type: Number, default: 0 })
  shippingFee: number;

  @Prop({ type: Number, default: 0 })
  settlementShippingFee: number;

  @Prop({ type: [OrderItemSchema], required: true })
  items: OrderItem[];

  @Prop({ required: true, default: 0 })
  subtotal: number;

  // Sum of this store's items' campaignDiscountUSD where campaignSponsorType
  // is 'platform' — the amount FinanceService.recordSale credits back on top
  // of `subtotal` so a platform-sponsored discount never reduces this
  // seller's own payout (see FinanceService.recordSale's saleAmount param).
  @Prop({ type: Number, default: 0 })
  platformSponsoredDiscountUSD: number;

  // What this specific seller is actually credited, in THEIR OWN
  // Store.baseCurrency — independent of the buyer's checkout currency
  // (Order.currency above). Computed once at order-creation time
  // (OrdersService) from the parent Order's fxSnapshots and never
  // recomputed later; refunds/chargebacks reverse against this same
  // snapshotted figure. Null on orders created before this field existed
  // and on any sellerOrder whose settlement leg hasn't been computed yet.
  @Prop({ type: String, default: null })
  settlementCurrency: string | null;

  @Prop({ type: Number, default: null })
  settlementAmount: number | null;

  // True when this seller's charge was routed directly to their own
  // connected Stripe account (StripeConnectService) at payment time — see
  // PaymentTransaction.settledViaConnect. When true, OrdersService's
  // recordSale (fulfillment-triggered internal-ledger credit) is skipped
  // entirely for this sellerOrder: the money already reached the seller's
  // own bank account via Stripe's own payout schedule, so crediting the
  // internal ledger too would let them draw a SECOND, duplicate payout
  // through the platform's own payout-request flow.
  @Prop({ type: Boolean, default: false })
  settledViaConnect: boolean;

  @Prop({ type: String, default: null })
  stripeConnectedAccountId: string | null;

  // derived from items
  @Prop({
    enum: [
      'pending',
      'processing',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'refunded',
    ],
    default: 'pending',
  })
  status: string;

  @Prop({ type: OrderTrackingSchema, default: null })
  tracking: OrderTracking | null;

  @Prop({ type: Date, default: null })
  shippedAt: Date | null;

  @Prop({ type: Date, default: null })
  deliveredAt: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  @Prop({ type: String, default: null })
  cancelReason: string | null;

  @Prop({
    type: String,
    enum: [
      'none',
      'partial_requested',
      'requested',
      'partial_approved',
      'approved',
      'rejected',
    ],
    default: 'none',
  })
  returnStatus!: string;
}

export const SellerOrderSchema = SchemaFactory.createForClass(SellerOrder);

@Schema({ _id: false })
export class OrderShippingAddress {
  @Prop({ type: String, required: true })
  recipientName: string;

  @Prop({ type: String, required: true })
  phoneNumber: string;

  @Prop({ type: String, required: true })
  addressLine1: string;

  @Prop({ type: String, default: null })
  addressLine2: string | null;

  @Prop({ type: String, required: true })
  city: string;

  @Prop({ type: String, required: true })
  state: string;

  @Prop({ type: String, required: true })
  zipCode: string;
}

export const OrderShippingAddressSchema =
  SchemaFactory.createForClass(OrderShippingAddress);

@Schema({ timestamps: true })
export class Order {
  @Prop({ type: String, required: true, unique: true })
  orderNumber: string;

  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, required: true })
  checkoutId: string;

  // The currency the buyer was actually charged, copied verbatim from
  // Checkout.currency at order-creation time — permanent once set, never
  // recomputed. No schema-level default anymore (see Checkout.currency's
  // comment); existing historical orders keep whatever value they already
  // have, including the old implicit 'USD' default, forever.
  @Prop({ type: String })
  currency: string;

  // Copied verbatim from Checkout.fxSnapshots at order-creation time —
  // immutable. This is what lets a refund, a settlement recomputation, or
  // an audit reproduce exactly what happened without depending on today's
  // ExchangeRate table. Absent on orders created before this field existed.
  @Prop({ type: [FxSnapshotSchema], default: [] })
  fxSnapshots: FxSnapshot[];

  // har store ka hissa
  @Prop({ type: [SellerOrderSchema], required: true })
  sellerOrders: SellerOrder[];

  // digital-only order me null
  @Prop({ type: OrderShippingAddressSchema, default: null })
  shippingAddress: OrderShippingAddress | null;

  @Prop({ required: true, default: 0 })
  subtotal: number;

  // poore order ka single shipping (destination city rate)
  @Prop({ required: true, default: 0 })
  shippingFee: number;

  @Prop({ required: true, default: 0 })
  taxAmount: number;

  // Total subscriber-benefit savings across all items in this order —
  // powers seller analytics ("revenue from subscribers", "benefit usage").
  @Prop({ default: 0 })
  subscriberDiscountTotal: number;

  // Sum of each item's couponDiscountUSD (already applied per-item at
  // checkout time — see CheckoutService.distributeCouponDiscount), copied
  // through at order-creation time for receipt display and seller analytics.
  @Prop({ type: String, default: null })
  couponCode: string | null;

  @Prop({ default: 0 })
  couponDiscountTotal: number;

  // Same convention as couponCode/couponDiscountTotal above, but for a
  // GiftCard's balance applied at checkout — see Checkout.giftCardCode.
  @Prop({ type: String, default: null })
  giftCardCode: string | null;

  @Prop({ default: 0 })
  giftCardDiscountTotal: number;

  // Sum of every sellerOrder item's campaignDiscountUSD — see
  // Checkout.campaignDiscountTotalUSD for why there's no single order-level
  // campaignId (a multi-store order can carry a different campaign per store).
  @Prop({ default: 0 })
  campaignDiscountTotal: number;

  // Sum of every item's autoDiscountUSD — see Checkout.autoDiscountTotalUSD
  // for why there's no single order-level discount id (same multi-store
  // reasoning as campaignDiscountTotal above).
  @Prop({ default: 0 })
  autoDiscountTotal: number;

  // Sum of every sellerOrder's platformSponsoredDiscountUSD — how much of
  // campaignDiscountTotal above the platform is covering (vs. sellers
  // absorbing it themselves). 0 whenever no participating campaign on this
  // order is sponsorType: 'platform'.
  @Prop({ default: 0 })
  platformSponsoredDiscountTotal: number;

  // Copied from Checkout at placeOrder — which promotional banner (if any)
  // the buyer clicked through before this order, for promotion analytics'
  // conversions/revenue attribution. Same convention as couponCode above.
  // See Checkout.attributedBannerId/attributedStoreBannerId for why these are
  // never a PromotionRequest id directly.
  @Prop({ type: String, default: null })
  attributedBannerId: string | null;

  @Prop({ type: String, default: null })
  attributedStoreBannerId: string | null;

  @Prop({ required: true })
  totalAmount: number;

  @Prop({ enum: ['cash_on_delivery', 'stripe', 'manual_bank_transfer', 'free'], required: true })
  paymentType: string;

  // 'pending_verification' — manual bank-transfer order awaiting an admin to
  // review the buyer's uploaded proof (see manual-payments module). Never
  // set for stripe/COD orders.
  @Prop({ enum: ['unpaid', 'pending_verification', 'paid', 'failed', 'refunded'], default: 'unpaid' })
  paymentStatus: string;

  @Prop({ default: false })
  isPaid: boolean;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;

  // overall derived status
  @Prop({
    enum: [
      'pending',
      'processing',
      'partially_shipped',
      'completed',
      'cancelled',
    ],
    default: 'pending',
  })
  orderStatus: string;

  @Prop({ default: false })
  hasReturnApproved!: boolean;

  // Copied from Checkout.attributionSource at order-creation time — see
  // that field's comment for why this can only ever be client-reported.
  // Absent on every order created before this field existed (never
  // backfilled — analytics must treat missing/'other' as "unknown", not zero).
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

  createdAt?: Date;
  updatedAt?: Date;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.index({ userId: 1 });
OrderSchema.index({ attributionSource: 1 });
OrderSchema.index({ checkoutId: 1 });
OrderSchema.index({ 'sellerOrders.sellerId': 1, 'sellerOrders.status': 1 });
OrderSchema.index({ 'sellerOrders.storeId': 1 });
OrderSchema.index({ 'sellerOrders.items.status': 1 });
OrderSchema.index({ paymentStatus: 1 });
OrderSchema.index({ createdAt: -1 });
