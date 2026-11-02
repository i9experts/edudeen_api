/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';
import { RemoveDeviceTokenDto } from './dto/remove-device-token.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  list(@Req() req: any, @Query() query: any) {
    return this.notificationsService.list(req.user.userId, query);
  }

  @Get('unread-count')
  unreadCount(@Req() req: any) {
    return this.notificationsService.unreadCount(req.user.userId);
  }

  @Get('preferences')
  getPreferences(@Req() req: any) {
    return this.notificationsService.getPreferences(req.user.userId, req.user.role);
  }

  @Patch('preferences')
  updatePreferences(@Req() req: any, @Body() dto: UpdatePreferencesDto) {
    return this.notificationsService.updatePreferences(req.user.userId, req.user.role, dto);
  }

  @Post('device-token')
  registerDeviceToken(@Req() req: any, @Body() dto: RegisterDeviceTokenDto) {
    return this.notificationsService.registerDeviceToken(req.user.userId, req.user.role, dto.fcmToken, dto.platform);
  }

  @Delete('device-token')
  removeDeviceToken(@Req() req: any, @Body() dto: RemoveDeviceTokenDto) {
    return this.notificationsService.removeDeviceToken(req.user.userId, dto.fcmToken);
  }

  @Patch('read-all')
  markAllRead(@Req() req: any) {
    return this.notificationsService.markAllRead(req.user.userId);
  }

  @Patch(':id/read')
  markRead(@Req() req: any, @Param('id') id: string) {
    return this.notificationsService.markRead(req.user.userId, id);
  }

  // Must stay above ':id' so "clear-read" is not taken for an id.
  @Delete('clear-read')
  clearRead(@Req() req: any) {
    return this.notificationsService.clearRead(req.user.userId);
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.notificationsService.remove(req.user.userId, id);
  }
}
