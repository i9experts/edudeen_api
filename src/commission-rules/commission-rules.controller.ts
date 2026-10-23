/* eslint-disable prettier/prettier */
import { Controller, Get, Put, Delete, Param, Body, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CommissionRulesService } from './commission-rules.service';
import { SetCommissionRateDto } from './dto/set-commission-rate.dto';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';

@ApiTags('Admin Commission Rules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/commission-rules')
export class CommissionRulesController {
  constructor(private readonly commissionRulesService: CommissionRulesService) {}

  // ─── Global default ──────────────────────────────────────────────────────

  @Get('global')
  getGlobalDefault() {
    return this.commissionRulesService.getGlobalDefault();
  }

  @Put('global')
  setGlobalDefault(@Req() req: any, @Body() dto: SetCommissionRateDto) {
    return this.commissionRulesService.setGlobalDefault(dto.rate, dto.notes, req.user.userId);
  }

  @Get('global/history')
  getGlobalHistory() {
    return this.commissionRulesService.getHistory('global', null);
  }

  // ─── Per-seller overrides (static list route BEFORE parameterized) ──────

  @Get('sellers')
  listSellerOverrides(@Query() query: any) {
    return this.commissionRulesService.listSellerOverrides(query);
  }

  @Get('sellers/:storeId')
  resolveForStore(@Param('storeId', ParseObjectIdPipe) storeId: string) {
    return this.commissionRulesService.resolveRate(storeId);
  }

  @Get('sellers/:storeId/override')
  getSellerOverride(@Param('storeId', ParseObjectIdPipe) storeId: string) {
    return this.commissionRulesService.getSellerOverride(storeId);
  }

  @Get('sellers/:storeId/history')
  getSellerHistory(@Param('storeId', ParseObjectIdPipe) storeId: string) {
    return this.commissionRulesService.getHistory('seller', storeId);
  }

  @Put('sellers/:storeId')
  setSellerOverride(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Body() dto: SetCommissionRateDto) {
    return this.commissionRulesService.setSellerOverride(storeId, dto.rate, dto.notes, req.user.userId);
  }

  @Delete('sellers/:storeId')
  removeSellerOverride(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string) {
    return this.commissionRulesService.removeSellerOverride(storeId, req.user.userId);
  }
}
