/* eslint-disable prettier/prettier */
import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ActivityLogService } from './activity-log.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminReauthGuard, RequireReauth } from '../admin-reauth/admin-reauth.guard';

/**
 * Platform-wide (unscoped by storeId — pass `storeId` as a query filter to
 * narrow) audit trail viewer for admins. Every module in this codebase
 * writes to the same `ActivityLogService.log()` — this is just the first
 * admin-facing read surface over it, so an admin can actually answer "who
 * approved this payout" / "who changed the commission rate" without direct
 * DB access. Backend API only — no admin app UI exists to consume this yet.
 */
@ApiTags('Admin Activity Log')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
@Roles('admin')
@Controller('api/admin/activity-log')
export class AdminActivityLogController {
  constructor(private readonly activityLogService: ActivityLogService) {}

  @Get()
  getAll(@Query() query: any) {
    return this.activityLogService.adminFindAll(query);
  }

  @RequireReauth()
  @Get('export')
  async export(@Req() req: any, @Query() query: any, @Res() res: Response) {
    const csv = await this.activityLogService.adminExportCsv(query, { id: req.user?.userId, name: req.user?.name ?? req.user?.email ?? null, role: 'admin' });
    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', 'attachment; filename="admin-activity-log.csv"');
    res.send(csv);
  }
}
