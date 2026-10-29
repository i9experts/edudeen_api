import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min, ValidateIf } from 'class-validator';

export class SetFeaturedRankDto {
  @ApiProperty({ nullable: true, example: 1, description: '1 = first on the home Featured sellers rail; null = unpin (ranked by score only)' })
  @ValidateIf((o) => o.rank !== null)
  @IsInt()
  @Min(1)
  @Max(999)
  rank: number | null;
}
