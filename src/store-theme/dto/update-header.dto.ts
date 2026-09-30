/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { BlockInputDto } from '../../common/dto/block-input.dto';

export class UpdateHeaderDto {
  @ApiProperty({ required: false, enum: ['store', 'custom'] })
  @IsOptional() @IsIn(['store', 'custom'])
  logoSource?: 'store' | 'custom';

  @ApiProperty({ required: false })
  @IsOptional() @IsString() @MaxLength(2048) @Matches(/^https:\/\/\S+$/i, { message: 'customLogoUrl must be an https URL' })
  customLogoUrl?: string;

  @ApiProperty({ required: false, type: [BlockInputDto], description: 'nav_link blocks only' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BlockInputDto)
  blocks?: BlockInputDto[];

  @ApiProperty({ required: false, enum: ['left', 'center', 'right'] })
  @IsOptional() @IsIn(['left', 'center', 'right'])
  navAlignment?: string;

  @ApiProperty({ required: false, enum: ['standard', 'centered'] })
  @IsOptional() @IsIn(['standard', 'centered'])
  headerStyle?: string;
}
