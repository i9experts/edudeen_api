/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { AdminMarketingService } from './admin-marketing.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { UpdateCampaignStatusDto } from './dto/update-campaign-status.dto';
import { CreatePlatformCouponDto } from './dto/create-platform-coupon.dto';
import { UpdatePlatformCouponDto } from './dto/update-platform-coupon.dto';

@ApiTags('Admin Marketing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/marketing')
export class AdminMarketingController {
  constructor(private readonly adminMarketingService: AdminMarketingService) {}

  private meta(req: any) {
    return { adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  // ─── Campaigns ───────────────────────────────────────────────────────────

  @Post('campaigns')
  createCampaign(@Req() req: any, @Body() dto: CreateCampaignDto) {
    return this.adminMarketingService.createCampaign(dto, this.meta(req));
  }

  @Get('campaigns')
  listCampaigns(@Query('status') status?: string) {
    return this.adminMarketingService.listCampaigns(status);
  }

  @Put('campaigns/:id')
  updateCampaign(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateCampaignDto) {
    return this.adminMarketingService.updateCampaign(id, dto, this.meta(req));
  }

  @Patch('campaigns/:id/status')
  setCampaignStatus(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateCampaignStatusDto) {
    return this.adminMarketingService.setCampaignStatus(id, dto, this.meta(req));
  }

  @Delete('campaigns/:id')
  deleteCampaign(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) {
    return this.adminMarketingService.deleteCampaign(id, this.meta(req));
  }

  // ─── Platform-wide coupons ───────────────────────────────────────────────

  @Post('coupons')
  createPlatformCoupon(@Req() req: any, @Body() dto: CreatePlatformCouponDto) {
    return this.adminMarketingService.createPlatformCoupon(dto, this.meta(req));
  }

  @Get('coupons')
  listPlatformCoupons() {
    return this.adminMarketingService.listPlatformCoupons();
  }

  @Patch('coupons/:id')
  updatePlatformCoupon(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdatePlatformCouponDto) {
    return this.adminMarketingService.updatePlatformCoupon(id, dto, this.meta(req));
  }

  @Delete('coupons/:id')
  deletePlatformCoupon(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) {
    return this.adminMarketingService.deletePlatformCoupon(id, this.meta(req));
  }
}
