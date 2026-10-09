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

  // A free sample anyone can download before buying (a few pages, one
  // worksheet). Kept separate from `files`, which only buyers ever get.
  @Prop({ type: DigitalFileSchema, default: null })
  sampleFile: DigitalFile | null;
}
export const DigitalConfigSchema = SchemaFactory.createForClass(DigitalConfig);

/** Exam boards / syllabi a resource follows — the filter general marketplaces don't have. */
export const CURRICULA = [
  'federal', 'punjab', 'sindh', 'kpk', 'balochistan', 'ajk_gb',
  'cambridge_o', 'cambridge_a', 'igcse', 'ib', 'aku_eb', 'madrasa',
] as const;
export type Curriculum = (typeof CURRICULA)[number];

/** License a buyer can choose when the seller offers more than one (stored as a variant option). */
export const LICENSE_OPTION_NAME = 'License';
export const LICENSE_OPTION_LABEL: Record<string, string> = {
  personal: 'Personal use',
  single_classroom: 'One classroom',
  school: 'Whole school',
  commercial: 'Commercial',
};

export const DELIVERY_FORMATS = ['download', 'course', 'live_class'] as const;
export type DeliveryFormat = (typeof DELIVERY_FORMATS)[number];
export const LIVE_PLATFORMS = ['zoom', 'google_meet', 'teams', 'other'] as const;

@Schema({ _id: false })
export class LiveSession {
  @Prop({ type: Date, required: true })
  startsAt: Date;

  @Prop({ type: Number, required: true })
  durationMinutes: number;

  @Prop({ type: String, enum: LIVE_PLATFORMS, default: 'zoom' })
  platform: string;

  @Prop({ type: String, default: '' })
  meetingUrl: string;

  // null = no seat limit.
  @Prop({ type: Number, default: null })
  capacity: number | null;

  @Prop({ type: String, default: '' })
  notes: string;
}
export const LiveSessionSchema = SchemaFactory.createForClass(LiveSession);

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

  // Exam boards / syllabi this follows (see CURRICULA) — any product type.
  @Prop({ type: [String], enum: CURRICULA, default: [] })
  curricula: string[];

  // Suitable ages, e.g. 6–8. Either end may be open.
  @Prop({ type: Number, default: null })
  ageMin: number | null;

  @Prop({ type: Number, default: null })
  ageMax: number | null;

  // How a digital product reaches the buyer: files to download, an online
  // course built in the course builder, or a scheduled live class.
  @Prop({ type: String, enum: DELIVERY_FORMATS, default: 'download' })
  deliveryFormat: DeliveryFormat;

  // Only for deliveryFormat 'live_class'. meetingUrl is buyers-only (stripped from public views).
  @Prop({ type: LiveSessionSchema, default: null })
  liveSession: LiveSession | null;

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

  // pending_review / rejected come from the admin listing review (see
  // resolveSellerPublishStatus); every public query only shows 'active'.
  @Prop({ enum: ['active', 'inactive', 'draft', 'scheduled', 'pending_review', 'rejected'], default: 'draft' })
  status: string;

  // When an admin approved the listing; once set, the seller can publish and
  // unpublish freely without another review.
  @Prop({ type: Date, default: null })
  approvedAt: Date | null;

  // The reviewer's note to the seller (why it was rejected, what to fix).
  @Prop({ type: String, default: null })
  reviewNote: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt: Date | null;

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

  // Admin-assigned trust badges (set in the listing review; see products/trust-badges.util.ts).
  // Plain nested object, null until an admin sets something.
  @Prop({ type: Object, default: null })
  trust: { scholarReviewed: boolean; ageAppropriateMin: number | null; ageAppropriateMax: number | null; reviewedAt?: Date; reviewedBy?: string } | null;

  @Prop({ default: false })
  isDelete: boolean;

  // Set only by an admin takedown (policy / copyright). Distinguishes it from
  // a seller deleting their own listing: past buyers keep download access
  // after a seller delete, but not after an admin takedown.
  @Prop({ default: false })
  removedByAdmin: boolean;

  // Urdu copy (AI-translated drafts the seller reviews; shown to buyers browsing in Urdu).
  @Prop({ type: String, default: null })
  nameUr: string | null;

  @Prop({ type: String, default: null })
  descriptionUr: string | null;

  // AI pre-moderation result for the admin listing review (advisory only, admin decides) and the cached review summary.
  @Prop({ type: Object, default: null })
  aiReview: Record<string, any> | null;

  @Prop({ type: Object, default: null })
  aiReviewSummary: Record<string, any> | null;

  // True for a draft created from an AI-generated worksheet/quiz (AI Studio "Save as digital product"). Seller reviews and publishes manually.
  @Prop({ type: Boolean, default: false })
  aiGenerated: boolean;

  // SEO overrides — see seo/schemas/seo-meta.schema.ts. Absent/empty until a
  // seller edits it or SeoAiService generates a suggestion; falls back to
  // category → store → global template via SeoResolutionService.
  @Prop({ type: SeoMetaSchema, default: () => ({}) })
  seo: SeoMeta;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.index({ curricula: 1 });
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
// perf: compound indexes for hot query paths (additive)
ProductSchema.index({ storeId: 1, status: 1, isDelete: 1 });
ProductSchema.index({ status: 1, isDelete: 1, createdAt: -1 });
ProductSchema.index({ categoryId: 1, status: 1, isDelete: 1 });
ProductSchema.index({ scheduledAt: 1 });