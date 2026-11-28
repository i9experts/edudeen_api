import {
  IsIn,
  IsISO8601,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  MOU_RATE_MAX,
  MOU_RATE_MIN,
  STORE_MANAGEMENT_TYPES,
} from '../../store/schemas/store.schema';
import { STORE_ASSIGNMENT_ROLES } from '../schemas/store-assignment.schema';

/** Everything optional: send only what changes. Cross-field rules (a managed store needs a full MOU,
 *  end after start) live in managed-stores.util.ts cleanManagedInput. */
export class UpdateManagedStoreDto {
  @IsOptional()
  @IsIn(STORE_MANAGEMENT_TYPES as unknown as string[])
  managementType?: string;

  /** Fraction, 0.20–0.65 (e.g. 0.3 = 30%). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(MOU_RATE_MIN)
  @Max(MOU_RATE_MAX)
  commissionRate?: number;

  @IsOptional()
  @IsISO8601()
  startDate?: string | null;

  /** null / omitted = open-ended. */
  @IsOptional()
  @IsISO8601()
  endDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsIn(['seller', 'platform'])
  fulfillmentMode?: string;
}

export class AssignStoreDto {
  @IsMongoId()
  adminId: string;

  @IsOptional()
  @IsIn(STORE_ASSIGNMENT_ROLES as unknown as string[])
  role?: string;
}
