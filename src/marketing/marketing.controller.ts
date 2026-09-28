/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { MarketingService } from './marketing.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';

@ApiTags('Marketing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/marketing')
export class MarketingController {
  constructor(private readonly marketingService: MarketingService) {}

  @Post(':storeId/coupons')
  @UsePipes(new ValidationPipe({ transform: true }))
  createCoupon(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateCouponDto) {
    return this.marketingService.createCoupon(req.user.userId, storeId, dto, req.ip, req.headers['user-agent']);
  }

  @Get(':storeId/coupons')
  getCoupons(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.marketingService.getCoupons(req.user.userId, storeId, query);
  }

  @Patch(':storeId/coupons/:couponId')
  @UsePipes(new ValidationPipe({ transform: true }))
  updateCoupon(@Req() req: any, @Param('storeId') storeId: string, @Param('couponId') couponId: string, @Body() dto: UpdateCouponDto) {
    return this.marketingService.updateCoupon(req.user.userId, storeId, couponId, dto, req.ip, req.headers['user-agent']);
  }

  @Delete(':storeId/coupons/:couponId')
  deleteCoupon(@Req() req: any, @Param('storeId') storeId: string, @Param('couponId') couponId: string) {
    return this.marketingService.deleteCoupon(req.user.userId, storeId, couponId, req.ip, req.headers['user-agent']);
  }

  // ─── Platform-wide sale campaigns (admin-created, seller opt-in) ────────

  @Get(':storeId/campaigns')
  getJoinableCampaigns(@Req() req: any, @Param('storeId') storeId: string) {
    return this.marketingService.getJoinableCampaigns(req.user.userId, storeId);
  }

  @Post(':storeId/campaigns/:campaignId/join')
  joinCampaign(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string) {
    return this.marketingService.joinCampaign(req.user.userId, storeId, campaignId, req.ip, req.headers['user-agent']);
  }

  @Delete(':storeId/campaigns/:campaignId/leave')
  leaveCampaign(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string) {
    return this.marketingService.leaveCampaign(req.user.userId, storeId, campaignId, req.ip, req.headers['user-agent']);
  }
}
