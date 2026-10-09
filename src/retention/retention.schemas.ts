/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// Own collections on purpose: no change to the Cart / wishList / User schemas.

/** One row per cart: when it was last reminded (the atomic claim that guarantees one reminder per 24h). */
@Schema({ timestamps: true, collection: 'cartreminders' })
export class CartReminder {
  @Prop({ type: String, required: true, unique: true }) cartId: string;
  @Prop({ type: String, required: true, index: true }) userId: string;
  @Prop({ type: Date, required: true }) lastReminderAt: Date;
}
export type CartReminderDocument = CartReminder & Document;
export const CartReminderSchema = SchemaFactory.createForClass(CartReminder);

/** Last seen price/stock of a wishlisted variant - the baseline the periodic job diffs against. */
@Schema({ timestamps: true, collection: 'wishlistvariantstates' })
export class WishlistVariantState {
  @Prop({ type: String, required: true, unique: true }) variantId: string;
  @Prop({ type: Number, required: true }) lastPrice: number;
  @Prop({ type: Boolean, required: true }) lastInStock: boolean;
}
export type WishlistVariantStateDocument = WishlistVariantState & Document;
export const WishlistVariantStateSchema = SchemaFactory.createForClass(WishlistVariantState);

/** A public read-only link to a buyer's Saved items. One active link per buyer; revoking kills the token. */
@Schema({ timestamps: true, collection: 'wishlistshares' })
export class WishlistShare {
  @Prop({ type: String, required: true, unique: true }) userId: string;
  @Prop({ type: String, required: true, unique: true }) token: string;
}
export type WishlistShareDocument = WishlistShare & Document;
export const WishlistShareSchema = SchemaFactory.createForClass(WishlistShare);

@Schema({ timestamps: true, collection: 'referralcodes' })
export class ReferralCode {
  @Prop({ type: String, required: true, unique: true }) userId: string;
  @Prop({ type: String, required: true, unique: true }) code: string;
}
export type ReferralCodeDocument = ReferralCode & Document;
export const ReferralCodeSchema = SchemaFactory.createForClass(ReferralCode);

@Schema({ timestamps: true, collection: 'referrals' })
export class Referral {
  @Prop({ type: String, required: true, index: true }) referrerId: string;
  /** a buyer can be referred once, ever */
  @Prop({ type: String, required: true, unique: true }) refereeId: string;
  @Prop({ type: String, required: true }) code: string;
  @Prop({ type: String, enum: ['pending', 'rewarding', 'rewarded', 'flagged'], default: 'pending', index: true }) status: string;
  @Prop({ type: String, default: null }) reason: string | null;
  /** HMAC of the signup IP (never the raw address) - used to spot clusters of referrals from one connection */
  @Prop({ type: String, default: null }) ipHash: string | null;
  @Prop({ type: [String], default: [] }) rewardCodes: string[];
  @Prop({ type: Date, default: null }) rewardedAt: Date | null;
}
export type ReferralDocument = Referral & Document;
export const ReferralSchema = SchemaFactory.createForClass(Referral);
ReferralSchema.index({ referrerId: 1, ipHash: 1 });

/** Singleton settings document (key 'default'), edited by an admin. */
@Schema({ timestamps: true, collection: 'retentionsettings' })
export class RetentionSettings {
  @Prop({ type: String, required: true, unique: true, default: 'default' }) key: string;
  @Prop({ type: Object, default: {} }) referral: Record<string, unknown>;
}
export type RetentionSettingsDocument = RetentionSettings & Document;
export const RetentionSettingsSchema = SchemaFactory.createForClass(RetentionSettings);
