/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { StoreTeamService } from './store-team.service';
import { AcceptInviteDto, InviteMemberDto, SwitchStoreDto, UpdateMemberDto } from './dto/store-team.dto';

@ApiTags('Store team')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store-team')
export class StoreTeamController {
  constructor(private readonly team: StoreTeamService) {}

  private caller(req: any) {
    return { userId: String(req.user.userId), email: req.user.email, role: req.user.role, actAs: req.user.actAs };
  }

  // ── invitee (any signed-in buyer/seller account) ───────────────────────────
  /** Public: what the invitation page shows before sign-in. Reveals only store name, role and a masked e-mail. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('invite/:token')
  async inviteInfo(@Param('token') token: string) {
    return { success: true, data: await this.team.inviteInfo(token) };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'seller')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('accept')
  async accept(@Req() req: any, @Body() dto: AcceptInviteDto) {
    return { success: true, data: await this.team.accept(this.caller(req), dto.token) };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'seller')
  @Get('mine')
  async mine(@Req() req: any) {
    return { success: true, data: await this.team.mine(this.caller(req)) };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'seller')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('switch')
  async switchTo(@Req() req: any, @Body() dto: SwitchStoreDto) {
    return { success: true, data: await this.team.switchTo(this.caller(req), dto.storeId) };
  }

  // ── store owner ────────────────────────────────────────────────────────────
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('roles')
  roles() {
    return { success: true, data: this.team.catalog() };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/members')
  async list(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string) {
    return { success: true, data: await this.team.list(this.caller(req), storeId) };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':storeId/members')
  async invite(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Body() dto: InviteMemberDto) {
    return { success: true, data: await this.team.invite(this.caller(req), storeId, dto) };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/members/:memberId')
  async update(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('memberId', ParseObjectIdPipe) memberId: string, @Body() dto: UpdateMemberDto) {
    return { success: true, data: await this.team.update(this.caller(req), storeId, memberId, dto) };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/members/:memberId/suspend')
  async suspend(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('memberId', ParseObjectIdPipe) memberId: string) {
    return { success: true, data: await this.team.setSuspended(this.caller(req), storeId, memberId, true) };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/members/:memberId/resume')
  async resume(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('memberId', ParseObjectIdPipe) memberId: string) {
    return { success: true, data: await this.team.setSuspended(this.caller(req), storeId, memberId, false) };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':storeId/members/:memberId/resend')
  async resend(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('memberId', ParseObjectIdPipe) memberId: string) {
    return { success: true, data: await this.team.resend(this.caller(req), storeId, memberId) };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete(':storeId/members/:memberId')
  async remove(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('memberId', ParseObjectIdPipe) memberId: string) {
    return { success: true, data: await this.team.remove(this.caller(req), storeId, memberId) };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/activity')
  async activity(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string) {
    return { success: true, data: await this.team.activityFor(this.caller(req), storeId) };
  }
}
