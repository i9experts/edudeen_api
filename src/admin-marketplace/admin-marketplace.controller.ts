/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { AdminMarketplaceService } from './admin-marketplace.service';
import { MarketplaceListingQueryDto } from './dto/marketplace-listing-query.dto';
import { SetFeaturedDto } from './dto/set-featured.dto';
import { SetStoreBadgeDto } from './dto/set-store-badge.dto';
import { SetFulfillmentModeDto } from './dto/set-fulfillment-mode.dto';
import { LeadsQueryDto } from './dto/leads-query.dto';
import { RejectLeadDto } from './dto/reject-lead.dto';

@ApiTags('Admin Marketplace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/marketplace')
export class AdminMarketplaceController {
  constructor(private readonly adminMarketplaceService: AdminMarketplaceService) {}

  private meta(req: any) {
    return { adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  @Get('stats')
  getStats() {
    return this.adminMarketplaceService.getStats();
  }

  @Get('listings')
  getListings(@Query() query: MarketplaceListingQueryDto) {
    return this.adminMarketplaceService.getListings(query);
  }

  @Patch('listings/:id/feature')
  setFeatured(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: SetFeaturedDto) {
    return this.adminMarketplaceService.setFeatured(id, dto.isFeatured, this.meta(req));
  }

  @Patch('listings/:id/remove')
  remove(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) {
    return this.adminMarketplaceService.remove(id, this.meta(req));
  }

  @Patch('stores/:id/badge')
  setStoreBadge(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: SetStoreBadgeDto) {
    return this.adminMarketplaceService.setStoreBadge(id, dto.badge, dto.grant, this.meta(req));
  }

  @Patch('stores/:id/fulfillment-mode')
  setFulfillmentMode(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: SetFulfillmentModeDto) {
    return this.adminMarketplaceService.setFulfillmentMode(id, dto.fulfillmentMode, this.meta(req));
  }

  @Get('leads')
  getLeads(@Query() query: LeadsQueryDto) {
    return this.adminMarketplaceService.getLeads(query);
  }

  @Get('leads/:id')
  getLeadDetail(@Param('id', ParseObjectIdPipe) id: string) {
    return this.adminMarketplaceService.getLeadDetail(id);
  }

  @Patch('leads/:id/under-review')
  markUnderReview(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) {
    return this.adminMarketplaceService.markUnderReview(id, this.meta(req));
  }

  @Patch('leads/:id/approve')
  approveLead(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) {
    return this.adminMarketplaceService.approveLead(id, this.meta(req));
  }

  @Patch('leads/:id/reject')
  rejectLead(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: RejectLeadDto) {
    return this.adminMarketplaceService.rejectLead(id, dto.reason, this.meta(req));
  }
}
