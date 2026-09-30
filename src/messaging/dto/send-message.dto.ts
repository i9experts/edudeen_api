/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString, IsNotEmpty, IsOptional, IsEnum, IsBoolean,
  IsArray, ValidateNested, IsNumber, Min, Max, MaxLength, Matches, ArrayMaxSize, IsIn, IsMongoId,
} from 'class-validator';
import { Type } from 'class-transformer';

// Attachments must come from OUR upload endpoint (a Cloudinary https URL) — the DTO used to accept any string,
// so `javascript:`/`data:`/tracking-pixel/phishing URLs and other users' assets could be attached.
const CLOUDINARY_URL = /^https:\/\/res\.cloudinary\.com\/\S+$/;

export class AttachmentItemDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(2048) @Matches(CLOUDINARY_URL, { message: 'url must be an uploaded file URL' }) url: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(255) publicId: string;
  @ApiProperty() @IsString() @IsIn(['image', 'video', 'raw']) resourceType: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) mimeType: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(255) fileName?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() @Min(0) @Max(500 * 1024 * 1024) fileSize?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(2048) @Matches(CLOUDINARY_URL, { message: 'thumbnailUrl must be an uploaded file URL' }) thumbnailUrl?: string;
}

export class ProductShareDto {
  @ApiProperty({ description: 'Product _id — details are fetched automatically' })
  @IsMongoId()
  productId: string;
}

// Only the parent's id is trusted. The quoted text/type/sender are rebuilt from the stored message server-side,
// so a user can no longer forge a quote that appears to come from the other party.
export class ReplyToDto {
  @ApiProperty() @IsMongoId() messageId: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(500) text?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(30) type?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(64) senderId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(30) senderRole?: string;
}

export class ForwardedFromDto {
  @ApiProperty() @IsString() @IsNotEmpty() originalSenderId: string;
  @ApiProperty() @IsString() @IsNotEmpty() originalSenderRole: string;
}

export class SendMessageDto {
  @ApiProperty({ enum: ['text', 'image', 'video', 'pdf', 'document', 'voice', 'product_share'] })
  @IsEnum(['text', 'image', 'video', 'pdf', 'document', 'voice', 'product_share'])
  type: string;

  @ApiProperty({ required: false, example: 'Hello! Is this item available?' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  text?: string;

  @ApiProperty({ type: [AttachmentItemDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AttachmentItemDto)
  attachments?: AttachmentItemDto[];

  @ApiProperty({ type: ProductShareDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProductShareDto)
  productShare?: ProductShareDto;

  @ApiProperty({ type: ReplyToDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReplyToDto)
  replyTo?: ReplyToDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isForwarded?: boolean;

  @ApiProperty({ type: ForwardedFromDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => ForwardedFromDto)
  forwardedFrom?: ForwardedFromDto;
}
