import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body of DELETE /api/users/profile: the typed confirmation word, plus the password for accounts that have one. */
export class DeleteAccountDto {
  @IsString()
  @MaxLength(20)
  confirm: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;
}
