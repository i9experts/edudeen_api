/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { StaffService } from './staff.service';

/** Public: accepting an invitation and finishing two-factor setup (token-based, throttled). */
@ApiTags('Staff (public invite)')
@Controller('api/staff')
export class StaffInviteController {
  constructor(private readonly staff: StaffService) {}
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('invite/:token')
  async info(@Param('token') token: string) { return { success: true, data: await this.staff.inviteInfo(token) }; }
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invite/:token/accept')
  async accept(@Param('token') token: string, @Body() body: { password: string; name?: string }) { return { success: true, data: await this.staff.acceptInvite(token, body ?? ({} as any)) }; }
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invite/:token/activate')
  async activate(@Param('token') token: string, @Body() body: { code: string }) { return { success: true, data: await this.staff.activate2fa(token, body?.code) }; }
}

@ApiTags('Admin — Staff & Collaboration')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  private async who(req: any) {
    const me = await this.staff.me(req.user.userId);
    const canAssign = me.isOwner || me.permissions.includes('tasks.assign');
    return { me, ctx: { id: me._id, canAssign, name: me.name || me.email } };
  }
  private async owner(req: any) {
    const { me } = await this.who(req);
    if (!me.isOwner) throw new ForbiddenException('Only the owner can do this');
    return me;
  }

  @Get('me') async me(@Req() req: any) { return { success: true, data: (await this.who(req)).me }; }
  @Get('permissions') async permissions() { return { success: true, data: this.staff.catalog() }; }

  @Get('roles') async roles() { return { success: true, data: await this.staff.listRoles() }; }
  @Post('roles') async createRole(@Req() req: any, @Body() b: any) { await this.owner(req); return { success: true, data: await this.staff.saveRole(null, b ?? {}) }; }
  @Patch('roles/:id') async updateRole(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() b: any) { await this.owner(req); return { success: true, data: await this.staff.saveRole(id, b ?? {}) }; }
  @Delete('roles/:id') async deleteRole(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { await this.owner(req); return { success: true, data: await this.staff.deleteRole(id) }; }

  @Get('audit') async audit(@Req() req: any, @Query('adminId') adminId?: string, @Query('limit') limit?: string) {
    const { me } = await this.who(req);
    if (!me.isOwner && !me.permissions.includes('activity.view')) throw new ForbiddenException('No access');
    return { success: true, data: await this.staff.auditList(adminId, Number(limit) || 100) };
  }

  // ── Tasks (every staff member sees their own; assigning needs tasks.assign) ──
  @Get('tasks') async tasks(@Req() req: any, @Query('scope') scope?: string, @Query('status') status?: string) {
    const { ctx } = await this.who(req);
    return { success: true, data: await this.staff.listTasks(ctx, scope === 'all' ? 'all' : 'mine', status) };
  }
  @Post('tasks') async createTask(@Req() req: any, @Body() b: any) { const { ctx } = await this.who(req); return { success: true, data: await this.staff.createTask(ctx, b ?? {}) }; }
  @Patch('tasks/:id') async updateTask(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() b: any) { const { ctx } = await this.who(req); return { success: true, data: await this.staff.updateTask(ctx, id, b ?? {}) }; }
  @Post('tasks/:id/comments') async comment(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() b: { text: string }) { const { ctx } = await this.who(req); return { success: true, data: await this.staff.commentTask(ctx, id, b?.text) }; }
  @Delete('tasks/:id') async deleteTask(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { const { ctx } = await this.who(req); return { success: true, data: await this.staff.deleteTask(ctx, id) }; }

  // ── Team (owner only for changes) ────────────────────────────────────────────
  @Get() async list() { return { success: true, data: await this.staff.list() }; }
  @Post('invite') async invite(@Req() req: any, @Body() b: any) { const me = await this.owner(req); return { success: true, data: await this.staff.invite(me._id, b ?? {}) }; }
  @Patch(':id') async update(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() b: any) { await this.owner(req); return { success: true, data: await this.staff.update(id, b ?? {}) }; }
  @Post(':id/suspend') async suspend(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { await this.owner(req); return { success: true, data: await this.staff.setSuspended(id, true) }; }
  @Post(':id/reactivate') async reactivate(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { await this.owner(req); return { success: true, data: await this.staff.setSuspended(id, false) }; }
  @Post(':id/resend-invite') async resend(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { await this.owner(req); return { success: true, data: await this.staff.resendInvite(id) }; }
  @Post(':id/reset-2fa') async reset2fa(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { await this.owner(req); return { success: true, data: await this.staff.reset2fa(id) }; }
  @Delete(':id') async remove(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { await this.owner(req); return { success: true, data: await this.staff.remove(id) }; }
}
