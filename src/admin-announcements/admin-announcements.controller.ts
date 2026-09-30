/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { AdminAnnouncementsService } from './admin-announcements.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { UpdateAnnouncementStatusDto } from './dto/update-announcement-status.dto';
import { AnnouncementQueryDto } from './dto/announcement-query.dto';

@ApiTags('Admin Announcements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/announcements')
export class AdminAnnouncementsController {
  constructor(private readonly adminAnnouncementsService: AdminAnnouncementsService) {}

  private meta(req: any) {
    return { adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  @Post()
  create(@Req() req: any, @Body() dto: CreateAnnouncementDto) {
    return this.adminAnnouncementsService.create(dto, this.meta(req));
  }

  @Get()
  list(@Query() query: AnnouncementQueryDto) {
    return this.adminAnnouncementsService.list(query);
  }

  @Put(':id')
  update(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateAnnouncementDto) {
    return this.adminAnnouncementsService.update(id, dto, this.meta(req));
  }

  @Patch(':id/status')
  setStatus(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateAnnouncementStatusDto) {
    return this.adminAnnouncementsService.setStatus(id, dto, this.meta(req));
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) {
    return this.adminAnnouncementsService.remove(id, this.meta(req));
  }
}
