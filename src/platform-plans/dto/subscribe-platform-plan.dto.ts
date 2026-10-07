/* eslint-disable prettier/prettier */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum, IsOptional, MaxLength, IsInt, Min, Max, IsObject } from 'class-validator';

export class SubscribePlatformPlanDto {
  @ApiProperty({ description: 'PlatformPlan _id to subscribe this store to' })
  @IsString() @IsNotEmpty()
  platformPlanId: string;

  @ApiProperty({ enum: ['monthly', 'yearly'], default: 'monthly' })
  @IsEnum(['monthly', 'yearly'])
  billingInterval: 'monthly' | 'yearly';
}

export class ChangePlatformPlanDto {
  @ApiProperty({ description: 'PlatformPlan _id to switch this store to' })
  @IsString() @IsNotEmpty()
  newPlatformPlanId: string;

  @ApiProperty({ enum: ['monthly', 'yearly'], default: 'monthly' })
  @IsEnum(['monthly', 'yearly'])
  newBillingInterval: 'monthly' | 'yearly';
}

export class CancelPlatformPlanDto {
  @ApiPropertyOptional({ description: 'Optional free-text reason, shown back to the seller and logged for support/analytics' })
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

export class BillingPortalDto {
  @ApiProperty({ description: 'Where Stripe should send the seller back to after they leave the billing portal' })
  @IsString() @IsNotEmpty()
  returnUrl: string;
}

export class ConfirmOnboardingPaymentMethodDto {
  @ApiProperty({ description: 'The SetupIntent id Stripe.js confirmed client-side during the onboarding Payment step' })
  @IsString() @IsNotEmpty()
  setupIntentId: string;
}

export class SaveOnboardingDraftDto {
  @ApiProperty({ description: 'Which wizard step the seller is currently on (1-5)' })
  @IsInt() @Min(1) @Max(10)
  step: number;

  @ApiProperty({ description: 'Furthest step reached so far — drives which steps are clickable in the header' })
  @IsInt() @Min(1) @Max(10)
  maxReached: number;

  @ApiProperty({ description: 'The wizard form fields entered so far (storeName, categoryId, description, sellerType, productTypes, etc.)' })
  @IsObject()
  form: Record<string, unknown>;
}
