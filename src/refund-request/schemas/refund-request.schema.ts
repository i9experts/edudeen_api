import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type RefundRequestDocument = HydratedDocument<RefundRequest>;

// A refund request always targets exactly ONE order's ONE sellerOrder's
// specific item(s) — never a proportional share of an entire (possibly
// multi-seller) order. This is the direct fix for the multi-seller-cart
// refund-attribution bug: refunding Seller A's item can never touch Seller
// B's wallet, because this schema simply has no path to do so — the
// service resolves and debits exactly `sellerOrderId`'s own store/seller.
@Schema({ timestamps: true })
export class RefundRequest {
  @Prop({ type: String, required: true, index: true })
  orderId: string;

  @Prop({ type: String, required: true })
  sellerOrderId: string;

  // Denormalized from sellerOrder.storeId at creation time, purely so the
  // seller-scoped list endpoint can query directly by store without a join
  // back through Order/SellerOrder for every request.
  @Prop({ type: String, required: true, index: true })
  storeId: string;

  @Prop({ type: [String], required: true })
  itemIds: string[];

  @Prop({ type: String, required: true })
  requestedBy: string;

  @Prop({ type: String, enum: ['user', 'seller', 'admin'], required: true })
  requestedByRole: 'user' | 'seller' | 'admin';

  @Prop({ type: String, required: true })
  reason: string;

  @Prop({
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true,
  })
  status: 'pending' | 'approved' | 'rejected';

  // Populated only at approval time — computed once, from the stored
  // Order's own OrderItem.totalPrice values and the Order's own frozen
  // fxSnapshots, never recomputed against today's rate.
  @Prop({ type: Number, default: null })
  buyerRefundAmount: number | null;

  @Prop({ type: String, default: null })
  buyerRefundCurrency: string | null;

  // What the seller's OWN wallet is actually debited — in their own
  // settlement currency, which can differ from buyerRefundCurrency.
  @Prop({ type: Number, default: null })
  sellerDebitAmount: number | null;

  @Prop({ type: String, default: null })
  sellerDebitCurrency: string | null;

  @Prop({ type: String, default: null })
  stripeRefundId: string | null;

  @Prop({ type: String, default: null })
  reviewedBy: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt: Date | null;

  @Prop({ type: String, default: null })
  resolutionNotes: string | null;

  @Prop({ default: false })
  isDelete: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const RefundRequestSchema = SchemaFactory.createForClass(RefundRequest);

RefundRequestSchema.index({ sellerOrderId: 1 });
RefundRequestSchema.index({ status: 1, createdAt: -1 });
