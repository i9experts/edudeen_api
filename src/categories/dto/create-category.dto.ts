import { IsOptional, IsString } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  name: string;

  @IsOptional()
  parentId?: string;

  @IsString()
  @IsOptional()
  image?: string;

  @IsOptional()
  @IsOptional()
  description?: string;

  @IsOptional()
  sortOrder?: number;
}
