/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RetentionService } from './retention.service';

/** Buyer's public, read-only Saved-items link. */
@Controller('api/wishlist-share')
export class WishlistShareController {
  constructor(private readonly retention: RetentionService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('public/:token')
  publicView(@Param('token') token: string) {
    return this.retention.publicShare(token);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('mine')
  mine(@Req() req: any) {
    return this.retention.getMyShare(req.user.userId);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post()
  create(@Req() req: any) {
    return this.retention.createShare(req.user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Delete()
  revoke(@Req() req: any) {
    return this.retention.revokeShare(req.user.userId);
  }
}

/** Referral programme: the buyer's own code/stats and applying someone else's code. */
@Controller('api/referrals')
export class ReferralsController {
  constructor(private readonly retention: RetentionService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('me')
  me(@Req() req: any) {
    return this.retention.myReferral(req.user.userId);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('apply')
  apply(@Req() req: any, @Body() body: { code?: string }) {
    return this.retention.applyCode(req.user.userId, body?.code, req.ip);
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/retention')
export class AdminRetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get('referral')
  async get() {
    return { success: true, data: await this.retention.getSettings() };
  }

  @Put('referral')
  save(@Body() body: Record<string, unknown>) {
    return this.retention.updateSettings(body);
  }
}
