import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength, ValidateIf } from 'class-validator';

// Each link is optional. Send a full https URL to set it, or an empty string
// / null to clear it (the footer then hides that icon).
const urlOpts = { protocols: ['https', 'http'], require_protocol: true };
const isSet = (_: unknown, v: unknown) => v !== undefined && v !== null && v !== '';

export class UpdateSocialLinksDto {
  @ApiProperty({ required: false, nullable: true, example: 'https://facebook.com/edudeen' })
  @IsOptional() @ValidateIf(isSet) @IsString() @IsUrl(urlOpts) @MaxLength(500)
  facebook?: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'https://instagram.com/edudeen' })
  @IsOptional() @ValidateIf(isSet) @IsString() @IsUrl(urlOpts) @MaxLength(500)
  instagram?: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'https://linkedin.com/company/edudeen' })
  @IsOptional() @ValidateIf(isSet) @IsString() @IsUrl(urlOpts) @MaxLength(500)
  linkedin?: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'https://youtube.com/@edudeen' })
  @IsOptional() @ValidateIf(isSet) @IsString() @IsUrl(urlOpts) @MaxLength(500)
  youtube?: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'https://tiktok.com/@edudeen' })
  @IsOptional() @ValidateIf(isSet) @IsString() @IsUrl(urlOpts) @MaxLength(500)
  tiktok?: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'https://x.com/edudeen' })
  @IsOptional() @ValidateIf(isSet) @IsString() @IsUrl(urlOpts) @MaxLength(500)
  x?: string | null;
}
