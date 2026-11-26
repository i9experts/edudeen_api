/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsMongoId, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class NewSellerDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsEmail() @MaxLength(120) email: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
}

export class StoreBasicsDto {
  @IsString() @MinLength(2) @MaxLength(60) name: string;
  @IsOptional() @IsMongoId() categoryId?: string;
  @IsString() @MaxLength(10) baseCurrency: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(40) sellerType?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(4) @IsString({ each: true }) productTypes?: string[];
}

/** Exactly one of `sellerId` (an existing seller) or `newSeller` (an invitation e-mail is sent). */
export class CreateStoreForSellerDto {
  @IsOptional() @IsMongoId() sellerId?: string;
  @IsOptional() @ValidateNested() @Type(() => NewSellerDto) newSeller?: NewSellerDto;
  @ValidateNested() @Type(() => StoreBasicsDto) store: StoreBasicsDto;
}
