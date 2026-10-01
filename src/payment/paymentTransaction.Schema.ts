import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { FxSnapshot, FxSnapshotSchema } from '../exchange-rate/schemas/exchange-rate.schema';

export type PaymentTransactionDocument = HydratedDocument<PaymentTransaction>;

@Schema({ timestamps: true })
export class PaymentTransaction {
  @Prop({ type: String, required: true, index: true })
  userId: string;

  @Prop({ type: String, required: true, index: true })
  checkoutId: string;

  // ek payment se bane saare orders (physical + digital)
  @Prop({ type: [String], default: [] })
  orderIds: string[];

  @Prop({ enum: ['cash_on_delivery', 'stripe', 'manual_bank_transfer', 'free'], required: true })
  paymentType: string;

  @Prop({ required: true })
  amount: number;

  // Copied verbatim from Order.currency/Checkout.currency at the point this
  // transaction is created — no schema-level default anymore. Existing
  // historical transactions keep whatever value (including the old
  // implicit 'USD' default, or none at all for rows predating this field)
  // they already have, forever.
  @Prop({ type: String })
  currency: string;

  // Copied verbatim from the parent Checkout/Order's fxSnapshots — see
  // Checkout.fxSnapshots' comment. Refund reversal reads this, never
  // today's ExchangeRate table.
  @Prop({ type: [FxSnapshotSchema], default: [] })
  fxSnapshots: FxSnapshot[];

  // 'digital_only' = this Stripe charge covers only a mixed checkout's
  // digital-items subtotal; the physical portion is settled via COD once
  // this payment succeeds. 'full' = charge covers the whole checkout.
  @Prop({ enum: ['full', 'digital_only'], default: 'full' })
  paymentScope: string;

  @Prop({
    enum: ['pending', 'completed', 'failed'],
    default: 'pending',
    index: true,
  })
  status: string;

  @Prop({ type: String, default: null })
  stripePaymentIntentId: string | null;

  // Set only when this charge was routed directly to a seller's own
  // connected Stripe account (StripeConnectService) instead of the
  // platform's shared account — see PaymentService.initiatePayment's
  // single-store-checkout gate. Refunds against this transaction must pass
  // `reverse_transfer`/`refund_application_fee` (see refundStripePaymentIntent),
  // and the ledger reversal in reverseSellerLedgerForOrders is skipped for
  // this order's sellerOrders — nothing was ever credited to the internal
  // ledger for a Connect-settled sale in the first place (see
  // OrdersService's recordSale gate on SellerOrder.settledViaConnect).
  @Prop({ type: Boolean, default: false })
  settledViaConnect: boolean;

  @Prop({ type: String, default: null })
  stripeConnectedAccountId: string | null;

  @Prop({ type: String, default: null })
  stripeClientSecret: string | null;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;

  // Cumulative amount refunded against this charge so far (Stripe's
  // `charge.amount_refunded` is itself cumulative) — tracked so a repeated
  // `charge.refunded` webhook delivery (or a second partial refund) only
  // reverses the NEW delta against seller balances, never the whole amount
  // again. See PaymentService.handleChargeRefunded.
  @Prop({ type: Number, default: 0 })
  amountRefunded: number;

  // Stripe dispute ids already reversed against seller balances — replay
  // protection for `charge.dispute.created` redeliveries.
  @Prop({ type: [String], default: [] })
  disputedChargeIds: string[];

  @Prop({ default: false })
  isDelete: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const PaymentTransactionSchema =
  SchemaFactory.createForClass(PaymentTransaction);

PaymentTransactionSchema.index({ orderIds: 1 });
PaymentTransactionSchema.index({ stripePaymentIntentId: 1 });
