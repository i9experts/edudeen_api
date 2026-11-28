/* eslint-disable prettier/prettier */
import { Controller, ForbiddenException, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { OperationsService, type OpsScope } from './operations.service';
import { TeamService } from './team.service';

/**
 * Seller Operations Center (read-only). The staff middleware lets any staff member through to this route
 * (permissions.ts); the scope is decided here:
 *  - owner admin, or staff with `operations.view` -> every store
 *  - staff with only `stores.operate`             -> the stores assigned to them
 *  - anyone else                                  -> 403
 */
export function opsScopeFor(req: any): OpsScope {
  const perms: Set<string> | undefined = req.staffPermissions;
  if (!perms || perms.has('operations.view')) return { all: true }; // no staff rights attached = owner
  if (perms.has('stores.operate')) return { all: false, adminId: String(req.user.userId) };
  throw new ForbiddenException('Your role does not include seller operations.');
}

@ApiTags('Admin — Seller operations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/operations')
export class OperationsController {
  constructor(private readonly service: OperationsService, private readonly team: TeamService) {}

  @Get()
  async overview(@Req() req: any, @Query() query: Record<string, unknown>) {
    return { success: true, data: await this.service.overview(opsScopeFor(req), query ?? {}) };
  }

  @Get('managers')
  async managers(@Req() req: any) {
    return { success: true, data: await this.service.managers(opsScopeFor(req)) };
  }

  /** Team performance: owner and staff who see every store (operations.view). */
  @Get('team')
  async teamList(@Req() req: any, @Query() query: Record<string, unknown>) {
    if (!opsScopeFor(req).all) throw new ForbiddenException('Your role does not include team performance.');
    return { success: true, data: await this.team.team(query ?? {}) };
  }

  /** One team member's performance: anyone who sees every store, or the member themselves. */
  @Get('team/:adminId')
  async teamMember(@Req() req: any, @Param('adminId', ParseObjectIdPipe) adminId: string, @Query() query: Record<string, unknown>) {
    const scope = opsScopeFor(req);
    if (!scope.all && scope.adminId !== adminId) throw new ForbiddenException('You can only see your own performance.');
    return { success: true, data: await this.team.member(adminId, query ?? {}) };
  }

  /** The caller's own work queue across the stores assigned to them (never anyone else's). */
  @Get('my-queue')
  async myQueue(@Req() req: any) {
    opsScopeFor(req); // 403 for staff without operations rights
    const adminId = String(req.user.userId);
    const [queue, kpis] = await Promise.all([this.service.myQueue(adminId), this.team.ownKpis(adminId)]);
    return { success: true, data: { ...queue, kpis, adminId } };
  }

  @Get(':storeId')
  async detail(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string) {
    return { success: true, data: await this.service.detail(opsScopeFor(req), storeId) };
  }
}
