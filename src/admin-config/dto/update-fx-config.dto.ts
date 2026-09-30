import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateFxConfigDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  autoRefreshEnabled?: boolean;

  @ApiProperty({ required: false, example: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(720)
  refreshIntervalHours?: number;

  @ApiProperty({ required: false, example: 48 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(8760)
  staleRateAlertThresholdHours?: number;

  @ApiProperty({ required: false, example: 150 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100000)
  sanityBandMinPKR?: number;

  @ApiProperty({ required: false, example: 450 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100000)
  sanityBandMaxPKR?: number;

  @ApiProperty({ required: false, example: 8 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  abnormalJumpAlertPercent?: number;

  @ApiProperty({ required: false, example: 50000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  exposureThresholdUSD?: number;
}
