/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductVariantDocument = ProductVariant & Document;

@Schema({ timestamps: true })
export class ProductVariant {

  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ required: true })
  sku: string;

  @Prop({ type: String, default: null })
  barcode: string | null;

  @Prop({ required: true })
  price: number;

  // Denominated in the owning Store's baseCurrency at the moment this
  // variant was created — stamped server-side by
  // ProductVariantsService/ProductsService, never client-supplied, and
  // immutable afterwards (a store's currency itself is locked once its
  // first product exists — see StoreService.createStore). Nullable at the
  // schema level only so pre-existing variants created before this field
  // existed remain readable/writable without a forced migration; the
  // one-time backfill sets them all to 'PKR' (see migration script —
  // Edudeen was Pakistan-only until this field was introduced, so this is a
  // label, never a numeric reinterpretation of `price`).
  @Prop({ type: String, default: null })
  currency: string | null;

  @Prop({ type: Number, default: null })
  compareAtPrice!: number | null;

  // physical only — arbitrary seller-defined attributes (Color, Size,
  // Material, etc). Every active (isDelete:false) variant on a given
  // product must use the same set of attribute names — enforced in
  // ProductVariantsService/ProductsService, not at the schema level.
  @Prop({ type: [{ name: String, value: String }], default: [] })
  options!: { name: string; value: string }[];

  @Prop({ default: 0 })
  stock: number;

  // physical only — when true, `stock` is ignored everywhere (cart, checkout,
  // payment, POS, inventory dashboard) and the product is always purchasable.
  @Prop({ default: false })
  unlimitedStock: boolean;

  @Prop({ type: String, default: null })
  shippingWeight!: string | null;

  @Prop({ type: [String], default: [] })
  images: string[];

  @Prop({ default: false })
  isDefault!: boolean;

  @Prop({ enum: ['active', 'inactive'], default: 'active' })
  status!: string;

  @Prop({ default: false })
  isDelete!: boolean;
}

export const ProductVariantSchema = SchemaFactory.createForClass(ProductVariant);

ProductVariantSchema.index({ productId: 1 });
ProductVariantSchema.index({ sku: 1 });
ProductVariantSchema.index({ barcode: 1 }, { sparse: true });