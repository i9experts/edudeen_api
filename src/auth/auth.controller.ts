/* eslint-disable prettier/prettier */
import { Body, Controller, Post, Req, Get, Patch } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { SocialLoginDto } from './dto/social-login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import { AuthGuard } from '@nestjs/passport';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator'
import { RolesGuard } from '../auth/guards/roles.guard'; ;





@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ✅ Signup
  // Rate-limited (per IP) same as every other public account-creation-shaped
  // endpoint in this codebase (contact/newsletter) — previously relied only
  // on the 100/min global default, which does nothing against a scripted
  // burst of registration/OTP attempts.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async signup( @Body() RegisterDto: RegisterDto) {
    return this.authService.signup(RegisterDto);
  }

  // ✅ Login — tighter than the 100/min global default specifically to slow
  // down password-guessing against one account from one IP.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  async login(@Req() req: any, @Body() loginDto: LoginDto) {
    return this.authService.login(loginDto, req.ip, req.headers['user-agent']);
  }

  // ✅ Social login (Google / Facebook / Apple) — resolves to buyer or seller per dto.role (default 'user')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('social-login')
  async socialLogin(@Body() socialLoginDto: SocialLoginDto) {
    return this.authService.socialLogin(socialLoginDto);
  }

  // Exchanges a refresh token (typ: 'refresh') for a fresh access/refresh pair.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('resend-otp')
  async resendOtp(@Body() body: { email: string; role: string }) {
    const { email, role } = body;
    return this.authService.resendOtp(email, role);
  }

  // A 6-digit OTP is only 1,000,000 combinations — without a tight per-IP
  // limit here, that's brute-forceable well within the OTP's expiry window.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verifyOtp')
  async verifyOtp(@Body() body: { email: string; role: string, otp: string }) {
    const { email, role, otp } = body;
    return this.authService.verifyOtp(email, role, otp);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  async forgotPassword(
    @Body('email') email: string,
    @Body('role') role: string,
  ) {
    return this.authService.forgotPassword(email, role);
  }

  // Same OTP-brute-force reasoning as verifyOtp above — reset-password also
  // takes a raw `otp` guess.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset-password')
  async resetPassword(
  @Body('email') email: string,
  @Body('role') role: string,
  @Body('otp') otp: string,
  @Body('newPassword') newPassword: string,
) {
  return this.authService.resetPassword(email, role, otp, newPassword);
}

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@Req() req: any) {
    const token = req.headers.authorization?.split(' ')[1];
    return this.authService.logout(token);
  }

  @UseGuards(JwtAuthGuard)
  @Get('getprofile')
  async getProfile(@Req() req: any) {
    const { userId, role } = req.user;
    return this.authService.getProfile(userId, role);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('edit-profile')
  async editProfile(@Req() req: any, @Body() updateProfileDto: UpdateProfileDto) {
    const { userId, role } = req.user;
    return this.authService.editProfile(userId, role, updateProfileDto);
  }

  // The only way a new admin account can be created — public registration
  // no longer allows role:'admin' (see RegisterDto). Only an already
  // logged-in admin can call this, so admin access can only ever be
  // extended by an existing admin, never granted to oneself.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('admin/create-admin')
  async createAdmin(@Req() req: any, @Body() dto: CreateAdminDto) {
    return this.authService.createAdmin(dto, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

}