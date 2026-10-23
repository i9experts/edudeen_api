/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, Min, MaxLength, IsUrl, Max, IsInt } from 'class-validator';

export class UpdateCampaignDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  bannerImage?: string;

  @ApiProperty({ required: false, description: 'Background image of the Mega Sale strip (null clears it)' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  backgroundImage?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ enum: ['percentage', 'fixed'], required: false })
  @IsOptional()
  @IsEnum(['percentage', 'fixed'])
  discountType?: 'percentage' | 'fixed';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000)
  discountValue?: number;

  @ApiProperty({ enum: ['seller', 'platform'], required: false })
  @IsOptional()
  @IsEnum(['seller', 'platform'])
  sponsorType?: 'seller' | 'platform';

  @ApiProperty({ required: false, description: 'Platform subsidy budget in USD (0 = no cap). Only meaningful for sponsorType "platform".' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10000000)
  subsidyCapUSD?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  order?: number;

  @ApiProperty({ enum: ['draft', 'active', 'ended'], required: false, description: 'Change the status in the SAME write as the other fields (all-or-nothing).' })
  @IsOptional()
  @IsEnum(['draft', 'active', 'ended'])
  status?: 'draft' | 'active' | 'ended';
}
