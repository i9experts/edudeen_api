/* eslint-disable prettier/prettier */
import { Transform } from 'class-transformer';
import { IsIn, IsMongoId, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { QUICK_REPLY_CATEGORIES } from '../schemas/quick-reply.schema';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateQuickReplyDto {
  @IsMongoId() storeId: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) title: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(1000) body: string;
  @IsIn(QUICK_REPLY_CATEGORIES as unknown as string[]) category: string;
}

export class UpdateQuickReplyDto {
  @IsMongoId() storeId: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) title?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(1000) body?: string;
  @IsOptional() @IsIn(QUICK_REPLY_CATEGORIES as unknown as string[]) category?: string;
}
