import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class SetFulfillmentModeDto {
  @ApiProperty({ enum: ['seller', 'platform'], example: 'platform' })
  @IsIn(['seller', 'platform'])
  fulfillmentMode: 'seller' | 'platform';
}
