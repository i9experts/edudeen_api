/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { SeoMeta, SeoMetaSchema } from 'src/seo/schemas/seo-meta.schema';

export type ProductDocument = Product & Document;

export enum ProductType {
  PHYSICAL = 'physical',
  DIGITAL = 'digital',
  EDUCATIONAL = 'educational',
}

export enum EducationLevel {
  PRESCHOOL             = 'preschool',
  PRIMARY_SCHOOL        = 'primary_school',
  MIDDLE_SCHOOL         = 'middle_school',
  SECONDARY_SCHOOL      = 'secondary_school',
  COLLEGE               = 'college',
  UNIVERSITY            = 'university',
  PROFESSIONAL_COURSES  = 'professional_courses',
  ISLAMIC_EDUCATION     = 'islamic_education',
  OTHER                 = 'other',
}

export enum LicenseType {
  PERSONAL = 'personal',                 // Personal Use Only
  SINGLE_CLASSROOM = 'single_classroom', // One teacher, one classroom
  SCHOOL = 'school',                     // Entire school building
  COMMERCIAL = 'commercial',             // Use in their business
}

export enum DownloadLimit {
  UNLIMITED = 'unlimited',
  ONE = '1',
  THREE = '3',
  FIVE = '5',
}

// ---- digital sub-schemas (sirf digital/educational ke liye) ----

@Schema({ _id: false })
export class DigitalFile {
  @Prop({ required: true })
  url: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: Number, default: null })
  size: number | null; // bytes

  @Prop({ type: String, default: null })
  mimeType: string | null;
}
export const DigitalFileSchema = SchemaFactory.createForClass(DigitalFile);

@Schema({ _id: false })
export class DigitalPreview {
  @Prop({ default: false })
  enabled: boolean;

  // index into DigitalConfig.files — which uploaded file the preview is derived from
  @Prop({ type: Number, default: null })
  sourceFileIndex: number | null;

  // ── server-managed only (never set directly by the seller-facing request body) ──
  // PDFs/audio are stored as resource_type 'raw' (see UploadService.getResourceType),
  // but Cloudinary can only rasterize PDF pages / trim clips on 'image'/'video'
  // resource types. These two fields point at a lazily-created shadow copy of the
  // source asset under a transform-capable resource type, prepared once when the
  // seller enables preview (see ProductsService.prepareDigitalPreview). Stay null
  // for image/video source files, which are already transform-capable in place.
  @Prop({ type: String, default: null })
  previewSourcePublicId: string | null;

  @Prop({ type: String, enum: ['image', 'video'], default: null })
  previewSourceResourceType: 'image' | 'video' | null;
}
export const DigitalPreviewSchema = SchemaFactory.createForClass(DigitalPreview);

@Schema({ _id: false })
export class DigitalConfig {
  @Prop({ type: [DigitalFileSchema], default: [] })
  files: DigitalFile[];

  @Prop({ type: String, enum: Object.values(DownloadLimit), default: DownloadLimit.UNLIMITED })
  downloadLimit: DownloadLimit;

  @Prop({ type: Number, default: null })
  linkExpiryDays: number | null; // null = never expires

  @Prop({ default: false })
  pdfStampingEnabled: boolean;

  @Prop({ type: String, enum: Object.values(LicenseType), default: LicenseType.PERSONAL })
  licenseType: LicenseType;

  @Prop({ type: String, default: null })
  buyerDeliveryMessage: string | null;

  @Prop({ type: DigitalPreviewSchema, default: () => ({}) })
  preview: DigitalPreview;
}
export const DigitalConfigSchema = SchemaFactory.createForClass(DigitalConfig);

// ---- main product ----

@Schema({ timestamps: true })
export class Product {

  @Prop({ required: true })
  sellerId: string;

  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, unique: true })
  slug: string;

  @Prop({ type: String, required: true })
  description: string;

  @Prop({ type: String, enum: Object.values(ProductType), required: true })
  productType: ProductType;

  // hamesha 'physical' ya 'digital' — educational bhi digital count hota hai
  @Prop({ type: String, enum: ['physical', 'digital'], required: true })
  type: string;

  @Prop({ type: String, required: true })
  categoryId: string;

  @Prop({ type: String, default: null })
  subCategoryId: string | null;

  // sirf productType === 'educational' ke liye — controlled Tier-1 taxonomy (9 values)
  @Prop({ type: String, enum: Object.values(EducationLevel), default: null })
  educationLevel: EducationLevel | null;

  // sirf educationLevel === 'other' ke liye — seller ka raw free-text label
  @Prop({ type: String, default: null })
  customLevel: string | null;

  // customLevel se derive hota hai (regex + alias lookup) — sirf grouping/filtering ke liye,
  // buyer ko raw nahi dikhaya jata (see EducationLevelService.normalizeCustomLevel)
  @Prop({ type: String, default: null })
  normalizedCustomLevel: string | null;

  // product gallery / cover images (dono type ke liye)
  @Prop({ type: [String], default: [] })
  images: string[];

  @Prop({ type: [String], default: [] })
  tags: string[];

  // digital/educational config — physical pe null rahega
  @Prop({ type: DigitalConfigSchema, default: null })
  digital: DigitalConfig | null;

  // analytics
  @Prop({ default: 0 })
  viewCount: number;

  @Prop({ default: 0 })
  wishlistCount: number;

  @Prop({ default: 0 })
  purchaseCount: number;

  @Prop({ default: 0 })
  averageRating: number;

  @Prop({ default: 0 })
  ratingSum: number;

  @Prop({ default: 0 })
  totalRatings: number;

  @Prop({ type: Date, default: null })
  lastViewedAt: Date | null;

  @Prop({ type: Date, default: null })
  lastPurchasedAt: Date | null;

  @Prop({ type: Date, default: null })
  lastWishlistedAt: Date | null;

  @Prop({ enum: ['active', 'inactive', 'draft', 'scheduled'], default: 'draft' })
  status: string;

  @Prop({ type: Date, default: null })
  scheduledAt: Date | null;

  // early_access plan benefit — non-subscribers can't see this product until this passes
  @Prop({ type: Date, default: null })
  earlyAccessUntil: Date | null;

  @Prop({ default: false })
  isListedOnEdudeen: boolean;

  // admin marketplace-management toggle — highlights the listing on the
  // marketplace homepage, separate from seller-controlled fields above
  @Prop({ default: false })
  isFeatured: boolean;

  @Prop({ default: false })
  isDelete: boolean;

  // SEO overrides — see seo/schemas/seo-meta.schema.ts. Absent/empty until a
  // seller edits it or SeoAiService generates a suggestion; falls back to
  // category → store → global template via SeoResolutionService.
  @Prop({ type: SeoMetaSchema, default: () => ({}) })
  seo: SeoMeta;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.index({ sellerId: 1 });
ProductSchema.index({ storeId: 1 });
ProductSchema.index({ name: 1 });
ProductSchema.index({ categoryId: 1 });
ProductSchema.index({ productType: 1 });
ProductSchema.index({ educationLevel: 1 });
ProductSchema.index({ normalizedCustomLevel: 1 });
ProductSchema.index({ type: 1 });
ProductSchema.index({ purchaseCount: -1 });
ProductSchema.index({ viewCount: -1 });
ProductSchema.index({ tags: 1 });
ProductSchema.index({ status: 1 });
ProductSchema.index({ scheduledAt: 1 });