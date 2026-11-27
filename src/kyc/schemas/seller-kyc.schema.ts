/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { KYC_DOCUMENT_TYPES, KYC_ID_TYPES, KYC_SELLER_TYPES, KYC_STATUSES } from '../kyc.util';
import type { KycDocumentType, KycIdType, KycSellerType, KycStatus } from '../kyc.util';

export type SellerKycDocument = SellerKyc & Document;

// Private files (UploadService.uploadPrivateFile): no stored URL, viewed only through short-lived signed links.
@Schema({ _id: false })
export class KycFile {
  @Prop({ type: String, enum: KYC_DOCUMENT_TYPES, required: true }) type: KycDocumentType;
  @Prop({ required: true }) publicId: string;
  @Prop({ type: String, default: 'image' }) resourceType: string;
  @Prop({ required: true }) fileName: string;
  @Prop({ type: Date, default: () => new Date() }) uploadedAt: Date;
}
export const KycFileSchema = SchemaFactory.createForClass(KycFile);

@Schema({ _id: false })
export class KycHistoryEntry {
  @Prop({ required: true }) action: string; // submitted | resubmitted | approved | rejected | revoked
  @Prop({ type: String, default: null }) note: string | null;
  @Prop({ type: String, default: null }) actorId: string | null;
  @Prop({ type: String, enum: ['seller', 'admin'], default: 'seller' }) actorRole: string;
  @Prop({ type: Date, default: () => new Date() }) at: Date;
}
export const KycHistoryEntrySchema = SchemaFactory.createForClass(KycHistoryEntry);

@Schema({ _id: false })
export class KycAddress {
  @Prop({ type: String, default: null }) country: string | null;
  @Prop({ type: String, default: null }) state: string | null;
  @Prop({ type: String, default: null }) city: string | null;
  @Prop({ type: String, default: null }) line: string | null;
}
export const KycAddressSchema = SchemaFactory.createForClass(KycAddress);

/** One per seller account: a single approval covers every store the seller owns. */
@Schema({ timestamps: true, collection: 'seller_kyc' })
export class SellerKyc {
  @Prop({ type: String, required: true, unique: true }) sellerId: string;
  @Prop({ type: String, enum: KYC_STATUSES, default: 'not_started' }) status: KycStatus;

  @Prop({ type: String, enum: KYC_SELLER_TYPES, default: null }) sellerType: KycSellerType | null;
  @Prop({ type: KycAddressSchema, default: () => ({}) }) address: KycAddress;
  @Prop({ type: String, enum: KYC_ID_TYPES, default: null }) idType: KycIdType | null;
  @Prop({ type: String, default: null }) fullName: string | null;

  // AES-256-GCM at rest (kyc.util encryptKycValue). Only the last 4 are kept readable for seller screens.
  @Prop({ type: String, default: null, select: false }) idNumberEnc: string | null;
  @Prop({ type: String, default: null }) idNumberLast4: string | null;
  @Prop({ type: String, default: null, select: false }) taxNumberEnc: string | null;
  @Prop({ type: String, default: null }) taxNumberLast4: string | null;

  @Prop({ type: String, default: null }) legalBusinessName: string | null;
  @Prop({ type: String, default: null }) registrationNumber: string | null;

  @Prop({ type: String, default: null }) bankAccountHolder: string | null;
  @Prop({ type: String, default: null }) bankName: string | null;
  // Account holder doesn't roughly match the ID name: a review hint for admins, never a block.
  @Prop({ type: Boolean, default: false }) nameMismatchFlagged: boolean;

  @Prop({ type: [KycFileSchema], default: [] }) documents: KycFile[];
  @Prop({ type: [KycHistoryEntrySchema], default: [] }) history: KycHistoryEntry[];

  @Prop({ type: String, default: null }) rejectionReason: string | null;
  @Prop({ type: Date, default: null }) submittedAt: Date | null;
  @Prop({ type: Date, default: null }) reviewedAt: Date | null;
  @Prop({ type: String, default: null }) reviewedBy: string | null;
}

export const SellerKycSchema = SchemaFactory.createForClass(SellerKyc);
SellerKycSchema.index({ status: 1, submittedAt: 1 });
