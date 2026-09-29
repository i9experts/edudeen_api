import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength, IsNotEmpty } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ example: 'OldPassword123!' })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({ example: 'NewPassword123!', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'New password must be at least 8 characters long' })
  @MaxLength(72, { message: 'New password must be at most 72 characters long' })
  @IsNotEmpty()
  newPassword: string;
}
