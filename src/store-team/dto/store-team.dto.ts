/* eslint-disable prettier/prettier */
import { ArrayMaxSize, IsArray, IsDateString, IsEmail, IsIn, IsMongoId, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { STORE_PERMISSION_KEYS, STORE_ROLE_TEMPLATES } from '../permissions';

const ROLE_KEYS = STORE_ROLE_TEMPLATES.map((r) => r.key);
const PERM_KEYS = Array.from(STORE_PERMISSION_KEYS);

export class InviteMemberDto {
  @IsEmail() @MaxLength(120) email: string;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsIn(ROLE_KEYS) roleKey: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsIn(PERM_KEYS, { each: true }) permissionsAdd?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsIn(PERM_KEYS, { each: true }) permissionsRemove?: string[];
  /** ISO date; empty/null = no end date. */
  @IsOptional() @IsDateString() accessExpiresAt?: string | null;
}

export class UpdateMemberDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsIn(ROLE_KEYS) roleKey?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsIn(PERM_KEYS, { each: true }) permissionsAdd?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsIn(PERM_KEYS, { each: true }) permissionsRemove?: string[];
  @IsOptional() @IsDateString() accessExpiresAt?: string | null;
}

export class AcceptInviteDto {
  @IsString() @MinLength(20) @MaxLength(200) token: string;
}

/** Invitee has no account yet: sets a password and joins in one step. */
export class AcceptNewAccountDto {
  @IsString() @MinLength(20) @MaxLength(200) token: string;
  @IsString() @MinLength(8) @MaxLength(72) password: string;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
}

/** Invitee already has an Edudeen account: signs in with the existing password and joins in one step. */
export class AcceptExistingAccountDto {
  @IsString() @MinLength(20) @MaxLength(200) token: string;
  @IsString() @MinLength(1) @MaxLength(72) password: string;
}

export class SwitchStoreDto {
  @IsMongoId() storeId: string;
}
