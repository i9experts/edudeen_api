/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PlatformPlansService } from './platform-plans.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreatePlatformPlanDto } from './dto/create-platform-plan.dto';
import { UpdatePlatformPlanDto } from './dto/update-platform-plan.dto';

@ApiTags('Platform Plans (Seller-to-Edudeen billing)')
@Controller('api/platform-plans')
export class PlatformPlansController {
  constructor(private readonly platformPlansService: PlatformPlansService) {}

  // Public — pricing page reads from here instead of hardcoded frontend data.
  @Get('public')
  browsePlans() {
    return this.platformPlansService.browsePlans();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('admin')
  createPlan(@Req() req: any, @Body() dto: CreatePlatformPlanDto) {
    return this.platformPlansService.adminCreatePlan(req.user.userId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/revenue')
  getRevenue(@Query() query: any) {
    return this.platformPlansService.adminGetRevenue(query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin')
  listPlans(@Query('includeArchived') includeArchived: string) {
    return this.platformPlansService.adminListPlans(includeArchived === 'true');
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/:id')
  getPlanById(@Param('id') id: string) {
    return this.platformPlansService.adminGetPlanById(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/:id/subscribers')
  getSubscribers(@Param('id') id: string, @Query() query: any) {
    return this.platformPlansService.adminGetSubscribers(id, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('admin/:id')
  updatePlan(@Req() req: any, @Param('id') id: string, @Body() dto: UpdatePlatformPlanDto) {
    return this.platformPlansService.adminUpdatePlan(req.user.userId, id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('admin/:id')
  archivePlan(@Req() req: any, @Param('id') id: string, @Query('force') force: string) {
    return this.platformPlansService.adminArchivePlan(req.user.userId, id, force === 'true');
  }
}
