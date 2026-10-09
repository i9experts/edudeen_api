import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreDashboardService } from './store-dashboard.service';

@Controller('api/store')
export class StoreDashboardController {
  constructor(private readonly service: StoreDashboardService) {}

  /** GET /api/store/:storeId/dashboard-summary — seller owns the store (checked in the service). */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/dashboard-summary')
  getSummary(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.getSummary(req.user.userId, storeId);
  }
}
