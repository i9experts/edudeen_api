import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CartDocument = Cart & Document;

// Embedded subdocument for cart items
@Schema({ _id: false })
export class CartItem {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, required: true })
  productVariantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, min: 1 })
  quantity: number;

  @Prop({ required: true })
  price: number;

  // Display-only snapshot of the owning store's currency at add-to-cart
  // time — Cart itself needs no currency concept for CONVERSION math (that
  // only happens once, at checkout creation, from the live ProductVariant),
  // but the cart page still needs to show each line's correct native symbol
  // before checkout exists. Nullable so pre-existing cart items (before
  // this field existed) don't break; display code falls back to a default.
  @Prop({ type: String, default: null })
  currency: string | null;

  // ✅ FIXED: images as array with safe default
  @Prop({ type: [String], default: [] })
  images: string[];

  // Snapshot of the variant's attributes at add-to-cart time (e.g.
  // [{name:'Color', value:'Red'}]) — drives the cart line item's display.
  @Prop({ type: [{ name: String, value: String }], default: [] })
  options: { name: string; value: string }[];
}

export const CartItemSchema = SchemaFactory.createForClass(CartItem);

// Main Cart schema
@Schema({ timestamps: true })
export class Cart {
  @Prop({ type: String, required: true })
  userId: string;

  // Scopes a logged-in buyer's cart to the store they're shopping on —
  // each store's subdomain storefront is its own isolated experience, so
  // the same buyer has a separate cart per store rather than one flat
  // cross-store cart (see LoyaltyMember's {storeId,userId} composite).
  @Prop({ type: String, required: true })
  storeId: string;

  @Prop({ type: [CartItemSchema], default: [] })
  items: CartItem[];

  @Prop({ default: 0 })
  totalItems: number;

  @Prop({ default: 0 })
  totalPrice: number;

  @Prop({ default: 'active' })
  status: string;

  @Prop({ default: false })
  isDelete: boolean;
}

export const CartSchema = SchemaFactory.createForClass(Cart);

CartSchema.index({ userId: 1, storeId: 1 });
// perf: compound indexes for hot query paths (additive)
CartSchema.index({ userId: 1, status: 1, isDelete: 1 });
