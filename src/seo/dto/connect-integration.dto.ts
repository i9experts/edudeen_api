/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { SEO_INTEGRATION_PROVIDERS } from '../schemas/seo-integration.schema';

export class ConnectIntegrationDto {
  @ApiProperty({ description: 'OAuth authorization code (or, for Bing, the pasted API key)' })
  @IsString() @IsNotEmpty() @MaxLength(2048)
  code: string;

  @ApiProperty({ example: 'https://edudeen.com/seo/integrations/callback' })
  @IsString() @IsNotEmpty() @MaxLength(2048)
  redirectUri: string;

  @ApiProperty({ description: 'Site URL, GA4 property id, or Merchant Center account id, depending on provider' })
  @IsString() @IsNotEmpty() @MaxLength(512)
  siteIdentifier: string;
}

export class GetAuthUrlDto {
  @ApiProperty({ example: 'https://edudeen.com/seo/integrations/callback' })
  @IsString() @IsNotEmpty() @MaxLength(2048)
  redirectUri: string;
}

export { SEO_INTEGRATION_PROVIDERS };

export function assertValidProvider(provider: string): asserts provider is (typeof SEO_INTEGRATION_PROVIDERS)[number] {
  if (!SEO_INTEGRATION_PROVIDERS.includes(provider as any)) {
    throw new BadRequestException(`provider must be one of: ${SEO_INTEGRATION_PROVIDERS.join(', ')}`);
  }
}
