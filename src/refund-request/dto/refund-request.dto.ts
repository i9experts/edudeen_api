import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateRefundRequestDto {
  @ApiProperty({ example: '65f1...' })
  @IsString() orderId: string;

  @ApiProperty({ example: '65f1...', description: "The specific SellerOrder subdocument id within this order" })
  @IsString() sellerOrderId: string;

  @ApiProperty({ example: ['65f1...'], description: 'One or more OrderItem subdocument ids within that sellerOrder' })
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) itemIds: string[];

  @ApiProperty({ example: 'Item arrived damaged', required: false, description: 'Free text; optional when reasonCode is sent (the label is used).' })
  @IsOptional() @IsString() @MinLength(3) @MaxLength(500) reason?: string;

  @ApiProperty({ required: false, enum: ['damaged', 'wrong_item', 'incomplete', 'not_as_described', 'cant_access_file'] })
  @IsOptional() @IsString() @MaxLength(40) reasonCode?: string;

  @ApiProperty({ required: false, description: '20-1000 characters; required with reasonCode' })
  @IsOptional() @IsString() @MaxLength(1000) note?: string;

  @ApiProperty({ required: false, description: 'Up to 3 uploaded image links (physical items only)' })
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsString({ each: true }) evidenceImages?: string[];
}

export class RejectRefundRequestDto {
  @ApiProperty({ example: 'Return window has already closed' })
  @IsString() @MinLength(3) @MaxLength(500) notes: string;
}

export class AdminRefundQueryDto {
  @ApiProperty({ required: false, enum: ['pending', 'approved', 'rejected'] })
  @IsOptional() @IsIn(['pending', 'approved', 'rejected']) status?: 'pending' | 'approved' | 'rejected';

  @ApiProperty({ required: false })
  @IsOptional() @IsMongoId() storeId?: string;

  @ApiProperty({ required: false, description: 'Order number, order id, or requester name / email' })
  @IsOptional() @IsString() @MaxLength(100) q?: string;

  @ApiProperty({ required: false, example: '2026-10-01' })
  @IsOptional() @IsISO8601() from?: string;

  @ApiProperty({ required: false, example: '2026-10-31' })
  @IsOptional() @IsISO8601() to?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 20;
}
