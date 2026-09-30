/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UploadedAssetDocument = UploadedAsset & Document;

/** What a private upload is FOR. Derived server-side from the upload folder — never from a client field. */
export const UPLOADED_ASSET_KINDS = ['digital_product', 'kyc_document'] as const;
export type UploadedAssetKind = (typeof UPLOADED_ASSET_KINDS)[number];

/**
 * Ownership record for every private upload. Cloudinary publicIds carry no owner, so without
 * this a seller could reference ANY private publicId (another seller's paid file, a KYC
 * document, a payment proof) as their own product file or KYC document and have the
 * platform sign, preview, or serve it. Reference points (product digital files, KYC
 * documents) must find a row here owned by the caller.
 */
@Schema({ timestamps: true })
export class UploadedAsset {
  @Prop({ type: String, required: true, unique: true }) publicId: string;
  @Prop({ type: String, required: true }) ownerId: string;
  @Prop({ type: String, required: true }) ownerRole: string;
  @Prop({ type: String, enum: UPLOADED_ASSET_KINDS, required: true }) kind: UploadedAssetKind;
  @Prop({ type: String, required: true }) resourceType: string;
  @Prop({ type: String, default: null }) fileName: string | null;
  @Prop({ type: Number, default: null }) fileSize: number | null;
  @Prop({ type: String, default: null }) mimeType: string | null;
}

export const UploadedAssetSchema = SchemaFactory.createForClass(UploadedAsset);
UploadedAssetSchema.index({ ownerId: 1, kind: 1 });
