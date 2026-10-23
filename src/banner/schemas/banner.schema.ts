import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { PROMOTION_PLACEMENTS, PromotionPlacement } from '../../common/promotion-placements.const';

export type BannerDocument = HydratedDocument<Banner>;

export const BANNER_STATUSES = ['draft', 'scheduled', 'active', 'paused', 'expired'] as const;
export type BannerStatus = (typeof BANNER_STATUSES)[number];

@Schema({ timestamps: true })
export class Banner {
  _id: string;

  @Prop({ required: true })
  bannerImage: string;

  @Prop({ default: '' })
  publicId: string;

  // Admin-given name of the banner (shown in the admin list, used as the picture's alt text).
  @Prop({ type: String, default: '', trim: true })
  title: string;

  @Prop({ type: String, default: null })
  urlOnTap: string | null;

  // Kept for backward compatibility with existing consumers (`BannerCarousel`,
  // `useBanners()`) — no longer the write-source of truth (that's `status` now),
  // but every write path below keeps it in sync so old readers see identical data.
  @Prop({ default: true })
  isActive: boolean;

  @Prop({ type: String, enum: BANNER_STATUSES, default: 'active' })
  status: BannerStatus;

  // Kept for backward compatibility with rows created before multi-placement
  // support — every write path below keeps this in sync as `placements[0]` so
  // any older reader of the scalar field still sees a sensible value. New code
  // should read/write `placements` instead.
  @Prop({ type: String, enum: PROMOTION_PLACEMENTS, default: 'marketplaceHero' })
  placement: PromotionPlacement;

  // A banner can run on more than one surface at once (e.g. both the
  // Marketplace and Education Marketplace hero) instead of needing a
  // duplicate row per placement. Rows created before this field existed have
  // an empty array here — every query below falls back to the legacy scalar
  // `placement` field for those (see the `$or` in banner.service.ts).
  @Prop({ type: [String], enum: PROMOTION_PLACEMENTS, default: [] })
  placements: PromotionPlacement[];

  @Prop({ type: Date, default: null })
  startAt: Date | null;

  @Prop({ type: Date, default: null })
  endAt: Date | null;

  @Prop({ default: 0 })
  order: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export const BannerSchema = SchemaFactory.createForClass(Banner);

BannerSchema.index({ isActive: 1 });
BannerSchema.index({ order: 1 });
BannerSchema.index({ placement: 1, status: 1, order: 1 });
BannerSchema.index({ placements: 1, status: 1, order: 1 });
BannerSchema.index({ status: 1, endAt: 1 });

BannerSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};
