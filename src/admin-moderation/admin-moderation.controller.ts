/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Patch, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { AdminModerationService } from './admin-moderation.service';
import { ModerationQueryDto } from './dto/moderation-query.dto';

@ApiTags('Admin Moderation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/moderation')
export class AdminModerationController {
  constructor(private readonly adminModerationService: AdminModerationService) {}

  private meta(req: any) {
    return { adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  @Get('stats')
  getStats() {
    return this.adminModerationService.getStats();
  }

  @Get('queue')
  getQueue(@Query() query: ModerationQueryDto) {
    return this.adminModerationService.getQueue(query);
  }

  @Patch(':id/review')
  markReviewed(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) {
    return this.adminModerationService.markReviewed(id, this.meta(req));
  }

  @Patch(':id/approve')
  approve(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) {
    return this.adminModerationService.approve(id, this.meta(req));
  }

  @Patch(':id/remove')
  remove(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) {
    return this.adminModerationService.remove(id, this.meta(req));
  }
}
