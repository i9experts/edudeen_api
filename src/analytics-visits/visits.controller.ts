/* eslint-disable prettier/prettier */
import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AnalyticsQueryDto } from '../analytics/dto/analytics-query.dto';
import { VisitsService } from './visits.service';

/** Public page-view beacon. Always answers 204: a tracking problem must never show up on the page. */
@ApiTags('Visit tracking')
@Controller('api/analytics')
export class VisitsBeaconController {
  constructor(private readonly visits: VisitsService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(204)
  @Post('view')
  async view(@Req() req: any, @Body() body: any): Promise<void> {
    const b = body && typeof body === 'object' ? body : {};
    await this.visits.record({
      ip: String(req.ip ?? ''),
      ua: String(req.headers?.['user-agent'] ?? ''),
      type: b.type,
      id: b.id,
      source: b.source,
      term: b.term,
    });
  }
}

@ApiTags('Seller Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/seller/analytics')
export class VisitsStatsController {
  constructor(private readonly visits: VisitsService) {}

  @Get('visits')
  getVisits(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.visits.getStats(req.user.userId, query.storeId, query);
  }
}
