/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsHexColor, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const BORDER_RADIUS_VALUES = ['none', 'small', 'medium', 'large', 'full'] as const;
const BUTTON_STYLE_VALUES = ['solid', 'outline', 'soft'] as const;
const BUTTON_WIDTH_VALUES = ['auto', 'full'] as const;
const SCALE_VALUES = ['compact', 'comfortable', 'spacious'] as const;
const CONTAINER_WIDTH_VALUES = ['narrow', 'standard', 'wide'] as const;
const CARD_STYLE_VALUES = ['flat', 'outlined', 'elevated'] as const;
const BUTTON_SIZE_VALUES = ['sm', 'md', 'lg'] as const;
const HERO_STYLE_VALUES = ['overlay', 'split'] as const;
const HERO_ALIGNMENT_VALUES = ['left', 'center'] as const;
const PRODUCT_IMAGE_RATIO_VALUES = ['square', 'portrait'] as const;
const PRODUCT_IMAGE_HOVER_VALUES = ['none', 'zoom'] as const;
const PRODUCT_GRID_DENSITY_VALUES = ['cozy', 'relaxed'] as const;
const TESTIMONIAL_STYLE_VALUES = ['cards', 'minimal'] as const;
const FAQ_STYLE_VALUES = ['accordion', 'list'] as const;

export class UpdateThemeDto {
  @ApiProperty({ required: false }) @IsOptional() @IsHexColor() primaryColor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsHexColor() bgColor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsHexColor() textColor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsHexColor() accentColor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @Matches(/^[A-Za-z0-9 ,'\-]{1,60}$/, { message: 'font must be a plain font family name' }) font?: string;
  @ApiProperty({ required: false, enum: BUTTON_STYLE_VALUES }) @IsOptional() @IsIn(BUTTON_STYLE_VALUES) buttonStyle?: string;
  @ApiProperty({ required: false, enum: BORDER_RADIUS_VALUES }) @IsOptional() @IsIn(BORDER_RADIUS_VALUES) buttonRadius?: string;
  @ApiProperty({ required: false, enum: BUTTON_WIDTH_VALUES }) @IsOptional() @IsIn(BUTTON_WIDTH_VALUES) buttonWidth?: string;
  @ApiProperty({ required: false, enum: BORDER_RADIUS_VALUES }) @IsOptional() @IsIn(BORDER_RADIUS_VALUES) imageRadius?: string;

  @ApiProperty({ required: false, enum: SCALE_VALUES }) @IsOptional() @IsIn(SCALE_VALUES) typeScale?: string;
  @ApiProperty({ required: false, enum: CONTAINER_WIDTH_VALUES }) @IsOptional() @IsIn(CONTAINER_WIDTH_VALUES) containerWidth?: string;
  @ApiProperty({ required: false, enum: SCALE_VALUES }) @IsOptional() @IsIn(SCALE_VALUES) sectionSpacing?: string;
  @ApiProperty({ required: false, enum: CARD_STYLE_VALUES }) @IsOptional() @IsIn(CARD_STYLE_VALUES) productCardStyle?: string;
  @ApiProperty({ required: false, enum: BORDER_RADIUS_VALUES }) @IsOptional() @IsIn(BORDER_RADIUS_VALUES) productCardRadius?: string;
  @ApiProperty({ required: false, enum: BUTTON_SIZE_VALUES }) @IsOptional() @IsIn(BUTTON_SIZE_VALUES) buttonSize?: string;
  @ApiProperty({ required: false, enum: HERO_STYLE_VALUES }) @IsOptional() @IsIn(HERO_STYLE_VALUES) heroStyle?: string;
  @ApiProperty({ required: false, enum: HERO_ALIGNMENT_VALUES }) @IsOptional() @IsIn(HERO_ALIGNMENT_VALUES) heroAlignment?: string;
  @ApiProperty({ required: false, enum: PRODUCT_IMAGE_RATIO_VALUES }) @IsOptional() @IsIn(PRODUCT_IMAGE_RATIO_VALUES) productImageRatio?: string;
  @ApiProperty({ required: false, enum: PRODUCT_IMAGE_HOVER_VALUES }) @IsOptional() @IsIn(PRODUCT_IMAGE_HOVER_VALUES) productImageHover?: string;
  @ApiProperty({ required: false, enum: PRODUCT_GRID_DENSITY_VALUES }) @IsOptional() @IsIn(PRODUCT_GRID_DENSITY_VALUES) productGridDensity?: string;
  @ApiProperty({ required: false, enum: TESTIMONIAL_STYLE_VALUES }) @IsOptional() @IsIn(TESTIMONIAL_STYLE_VALUES) testimonialStyle?: string;
  @ApiProperty({ required: false, enum: CARD_STYLE_VALUES }) @IsOptional() @IsIn(CARD_STYLE_VALUES) testimonialCardStyle?: string;
  @ApiProperty({ required: false, enum: BORDER_RADIUS_VALUES }) @IsOptional() @IsIn(BORDER_RADIUS_VALUES) testimonialCardRadius?: string;
  @ApiProperty({ required: false, enum: FAQ_STYLE_VALUES }) @IsOptional() @IsIn(FAQ_STYLE_VALUES) faqStyle?: string;

  // Set when this update came from applying a curated theme (frontend
  // `themes.ts` id, not a backend ref) — null/omitted clears/leaves it alone.
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(60) baseThemeId?: string | null;
}
