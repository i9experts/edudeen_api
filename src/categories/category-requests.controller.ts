/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminReauthGuard } from '../admin-reauth/admin-reauth.guard';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { CategoryRequestsService } from './category-requests.service';

/** Seller side: ask for a new subcategory / main category change, and see how many products sit in each category. */
@Controller('api/categories')
export class CategoryRequestsController {
  constructor(private readonly svc: CategoryRequestsService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('requests')
  create(@Req() req: any, @Body() body: any) {
    return this.svc.create(req.user.userId, String(body?.storeId ?? ''), body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('requests')
  list(@Req() req: any, @Query('storeId') storeId: string) {
    return this.svc.listForStore(req.user.userId, String(storeId ?? ''));
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('store-usage/:storeId')
  usage(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string) {
    return this.svc.storeUsage(req.user.userId, storeId);
  }
}

/** Admin side (staff need `categories.manage` via the existing /api/categories/admin rule). */
@Controller('api/categories/admin/requests')
export class CategoryRequestsAdminController {
  constructor(private readonly svc: CategoryRequestsService) {}

  @UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
  @Roles('admin')
  @Get()
  list(@Query('status') status?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.svc.adminList(status || undefined, Number(page) || 1, Number(limit) || 25);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
  @Roles('admin')
  @Patch(':id/decision')
  decide(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() body: { status?: string; note?: string }) {
    return this.svc.decide(id, body?.status as any, body?.note, { adminId: req.user.userId, ip: req.ip, userAgent: req.headers?.['user-agent'] });
  }
}
