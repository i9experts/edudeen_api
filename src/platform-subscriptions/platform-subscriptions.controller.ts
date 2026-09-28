/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Param, Body, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PlatformSubscriptionsService } from './platform-subscriptions.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { SubscribeToTierDto } from './dto/subscribe-to-tier.dto';
import { OverrideStoreTierDto } from './dto/override-store-tier.dto';

@ApiTags('Platform Subscriptions (seller pays marketplace)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('api/platform-subscriptions')
export class PlatformSubscriptionsController {
  constructor(private readonly service: PlatformSubscriptionsService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Static routes first (tiers, admin) — parameterized :storeId routes last.
  // ═══════════════════════════════════════════════════════════════════════════

  @Roles('seller')
  @Get('tiers')
  getTiers() {
    return this.service.getTiers();
  }

  @Roles('admin')
  @Get('admin/tiers')
  adminGetTierConfig() {
    return this.service.adminGetTierConfig();
  }

  @Roles('admin')
  @Patch('admin/stores/:storeId/override-tier')
  @UsePipes(new ValidationPipe({ transform: true }))
  adminOverrideStoreTier(@Param('storeId') storeId: string, @Body() dto: OverrideStoreTierDto) {
    return this.service.adminOverrideStoreTier(storeId, dto);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — store-scoped
  // ═══════════════════════════════════════════════════════════════════════════

  @Roles('seller')
  @Get(':storeId/my-plan')
  getMyPlan(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.getMyPlan(req.user.userId, storeId);
  }

  @Roles('seller')
  @Post(':storeId/subscribe')
  @UsePipes(new ValidationPipe({ transform: true }))
  setTier(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: SubscribeToTierDto) {
    return this.service.setTier(req.user.userId, storeId, dto);
  }

  @Roles('seller')
  @Patch(':storeId/change-tier')
  @UsePipes(new ValidationPipe({ transform: true }))
  changeTier(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: SubscribeToTierDto) {
    return this.service.setTier(req.user.userId, storeId, dto);
  }

  @Roles('seller')
  @Patch(':storeId/cancel')
  cancel(@Req() req: any, @Param('storeId') storeId: string, @Query('atPeriodEnd') atPeriodEnd: string) {
    return this.service.cancelToStarter(req.user.userId, storeId, atPeriodEnd === 'true');
  }

  @Roles('seller')
  @Post(':storeId/pos-addon/subscribe')
  subscribeToPosAddon(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.subscribeToPosAddon(req.user.userId, storeId);
  }

  @Roles('seller')
  @Patch(':storeId/pos-addon/cancel')
  cancelPosAddon(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.cancelPosAddon(req.user.userId, storeId);
  }
}
