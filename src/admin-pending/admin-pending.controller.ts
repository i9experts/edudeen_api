/* eslint-disable prettier/prettier */
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminPendingService } from './admin-pending.service';

@ApiTags('Admin Pending Counts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/pending-counts')
export class AdminPendingController {
  constructor(private readonly pending: AdminPendingService) {}

  /** Numbers of items waiting for an admin decision. Staff only get the queues their rights cover (set by the staff middleware). */
  @Get()
  async get(@Req() req: any) {
    return { success: true, data: await this.pending.forPermissions(req.staffPermissions ?? null) };
  }
}
