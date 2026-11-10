/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';

export class ManualOrderProductsQueryDto {
  @ApiProperty({ required: false, description: 'Product name (at least 2 characters)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

/**
 * A fresh shipping address for this order. Field-level validation (required fields, Pakistani
 * phone format, 5-digit zip, province enum) is the same check `AddressService.addAddress` already
 * runs on every buyer-entered address (`pickAddressUpdate`) — not duplicated here.
 */
export class ManualOrderAddressDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  recipientName?: string;

  @ApiProperty()
  @IsString()
  phoneNumber: string;

  @ApiProperty()
  @IsString()
  addressLine1: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  addressLine2?: string;

  @ApiProperty()
  @IsString()
  state: string;

  @ApiProperty()
  @IsString()
  city: string;

  @ApiProperty()
  @IsString()
  zipCode: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  country?: string;
}

export class CreateManualOrderDto {
  @ApiProperty({ description: 'An existing buyer account' })
  @IsMongoId()
  buyerId: string;

  @ApiProperty()
  @IsMongoId()
  productId: string;

  @ApiProperty()
  @IsMongoId()
  variantId: string;

  @ApiProperty({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity = 1;

  @ApiProperty({ required: false, description: 'Required only when the product is physical' })
  @ValidateIf((o: CreateManualOrderDto) => !!o.address)
  @ValidateNested()
  @Type(() => ManualOrderAddressDto)
  address?: ManualOrderAddressDto;

  @ApiProperty({ required: false, description: 'Required only when shipping zones are configured and the product is physical' })
  @IsOptional()
  @IsMongoId()
  shippingZoneId?: string;

  @ApiProperty({ description: 'Why this order is being placed manually — recorded on the order activity log' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason: string;
}
