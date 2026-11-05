import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { StoreHealthService } from './store-health.service';
import { parseHealthRange } from './store-health.util';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreDashboardService } from './store-dashboard.service';

@Controller('api/store')
export class StoreDashboardController {
  constructor(private readonly service: StoreDashboardService, private readonly health: StoreHealthService) {}

  /** GET /api/store/:storeId/dashboard-summary — seller owns the store (checked in the service). */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/dashboard-summary')
  getSummary(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string) {
    return this.service.getSummary(req.user.userId, storeId);
  }

  /** GET /api/store/:storeId/health?range=30|90 — read-only Store Health (ownership checked in the service). */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/health')
  async getHealth(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Query('range') range?: string) {
    const data = await this.health.getHealth(req.user.userId, storeId, parseHealthRange(range));
    return { success: true, data };
  }
}
