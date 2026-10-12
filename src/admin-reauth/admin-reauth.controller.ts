import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminReauthService } from './admin-reauth.service';

class VerifyPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password: string;
}

@ApiTags('Admin Reauth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/reauth')
export class AdminReauthController {
  constructor(private readonly service: AdminReauthService) {}

  @Post('verify-password')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  verify(@Req() req: any, @Body() dto: VerifyPasswordDto) {
    return this.service.verifyPassword(req.user.userId, dto.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }
}