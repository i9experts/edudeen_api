/* eslint-disable prettier/prettier */
import { StoreTeamService } from '../store-team/store-team.service';
import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminReauthGuard, RequireReauth } from '../admin-reauth/admin-reauth.guard';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { AdminStoresService } from './admin-stores.service';
import { CreateStoreForSellerDto } from './dto/create-store-for-seller.dto';

/** Staff need `stores.manage` (permissions.ts RULES); the owner always may. Both need the admin password (reauth). */
@ApiTags('Admin stores')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
@Roles('admin')
@RequireReauth()
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/stores')
export class AdminStoresController {
  constructor(private readonly service: AdminStoresService, private readonly team: StoreTeamService) {}

  private actor(req: any) {
    return { id: String(req.user.userId), ip: req.ip, userAgent: req.headers?.['user-agent'] };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  async create(@Req() req: any, @Body() dto: CreateStoreForSellerDto) {
    return { success: true, data: await this.service.createForSeller(this.actor(req), dto) };
  }

  /** Read + remove only: an admin can see and remove a store's team members (audited), never edit their rights. */
  @Get(':storeId/members')
  async members(@Param('storeId', ParseObjectIdPipe) storeId: string) {
    return { success: true, data: await this.team.adminList(storeId) };
  }

  @Delete(':storeId/members/:memberId')
  async removeMember(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('memberId', ParseObjectIdPipe) memberId: string) {
    return { success: true, data: await this.team.adminRemove(String(req.user.userId), storeId, memberId) };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':storeId/manage-session')
  async manageSession(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string) {
    return { success: true, data: await this.service.manageSession(this.actor(req), storeId) };
  }
}
