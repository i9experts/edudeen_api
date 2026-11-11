/* eslint-disable prettier/prettier */
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { MarketingService } from './marketing.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';

/** Read-only KPI row for the seller Marketing page: GET /api/seller/marketing/kpis?storeId= */
@ApiTags('Marketing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/seller/marketing')
export class SellerMarketingKpisController {
  constructor(private readonly marketingService: MarketingService) {}

  @Get('kpis')
  getKpis(@Req() req: any, @Query('storeId', ParseObjectIdPipe) storeId: string) {
    return this.marketingService.getKpis(req.user.userId, storeId);
  }
}

/** Per-promotion results: GET /api/seller/promotions/stats?storeId=&range=7d|30d|90d */
@ApiTags('Marketing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/seller/promotions')
export class SellerPromotionStatsController {
  constructor(private readonly marketingService: MarketingService) {}

  @Get('stats')
  getStats(
    @Req() req: any,
    @Query('storeId', ParseObjectIdPipe) storeId: string,
    @Query('range') range?: string,
  ) {
    return this.marketingService.getPromotionStats(req.user.userId, storeId, range ?? '30d');
  }
}
