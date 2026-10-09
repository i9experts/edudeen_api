import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';

export class SetTrustBadgesDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  scholarReviewed?: boolean;

  @ApiPropertyOptional({ example: 6, nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(25)
  ageAppropriateMin?: number | null;

  @ApiPropertyOptional({ example: 10, nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(25)
  ageAppropriateMax?: number | null;
}
