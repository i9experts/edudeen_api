/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';

/**
 * The seller's Customize-store draft. Each key is optional and is validated/sanitised by `cleanStorePageDraft`
 * (store/store-page.util.ts) — the decorators here only let the global whitelist keep the keys.
 */
export class UpdateStorePageDto {
  @ApiProperty({ required: false }) @IsOptional() name?: string;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() tagline?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() description?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() logo?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() coverImage?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() aboutBio?: string | null;
  @ApiProperty({ required: false, nullable: true, type: Object }) @IsOptional() educatorProfile?: Record<string, unknown> | null;
}
