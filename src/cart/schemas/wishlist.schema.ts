/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory,  } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type wishListDocument = wishList & Document;

@Schema({ timestamps: true })
export class wishList {

 @Prop({ type: String, required: true })
   userId: string;

  // Same per-store scoping as Cart — a buyer's wishlist on one store's
  // subdomain is separate from their wishlist on another store's.
  @Prop({ type: String, required: true })
   storeId: string;

  @Prop({ type: String, required: true })
   productId: string;

    @Prop({ type: String, required: true })
    productVariantId: string;



}

export const wishListSchema = SchemaFactory.createForClass(wishList);



wishListSchema.index({ productId: 1 });
wishListSchema.index({ productVariantId: 1 });
// get-wishlist: filter by user, newest first.
wishListSchema.index({ userId: 1, createdAt: -1 });
// Prevents duplicate wishlist entries from a double-tap race (two
// near-simultaneous add-to-wishlist requests both passing the
// findOne-based duplicate check in CartService.addToWishlist before
// either write commits).
wishListSchema.index({ userId: 1, storeId: 1, productId: 1, productVariantId: 1 }, { unique: true });