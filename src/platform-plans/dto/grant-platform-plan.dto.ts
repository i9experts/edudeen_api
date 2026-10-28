import { IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class GrantPlatformPlanDto {
  @IsMongoId() planId: string;
  @IsInt() @Min(1) @Max(31) days: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
