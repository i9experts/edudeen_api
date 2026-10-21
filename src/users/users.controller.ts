import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { Throttle } from '@nestjs/throttler';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('api/users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get user profile' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  async getProfile(@Req() req: any) {
    const user = await this.usersService.getProfile(req.user.userId);
    return { success: true, data: user };
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  updateProfile(@Req() req: any, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(req.user.userId, dto);
  }

  @Delete('profile')
  @ApiOperation({ summary: 'Delete user account (soft delete)' })
  @ApiResponse({ status: 200, description: 'Account deactivated successfully' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // password is checked here, so it must not be brute-forceable
  deleteAccount(@Req() req: any, @Body() dto: DeleteAccountDto) {
    return this.usersService.deleteAccount(req.user.userId, req.user.role, dto);
  }

  @Put('logout-others')
  @ApiOperation({ summary: 'Sign out of every other device' })
  logoutOthers(@Req() req: any) {
    return this.usersService.logoutOtherDevices(req.user.userId, req.user.role);
  }

  @Put('change-password')
  @ApiOperation({ summary: 'Change user password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.usersService.changePassword(
      req.user.userId,
      req.user.role,
      dto,
    );
  }
}
