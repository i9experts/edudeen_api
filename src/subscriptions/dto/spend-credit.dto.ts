import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsNotEmpty, IsNumber, IsString, Max, MaxLength, Min } from 'class-validator';

export class SpendCreditDto {
  @ApiProperty({ enum: ['download', 'service'] })
  @IsIn(['download', 'service'])
  creditType: 'download' | 'service';

  @ApiProperty({ example: 1, description: 'Credits to spend (positive, at most 2 decimals)' })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100000)
  amount: number;

  @ApiProperty({ example: 'Downloaded worksheet pack' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason: string;
}
