/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ChatSupportService, CHAT_MAX_TEXT } from './chat-support.service';

export class AdminChatReplyDto {
  @IsString() @MinLength(1) @MaxLength(CHAT_MAX_TEXT) text: string;
}

/** Admin chat inbox: questions the widget could not answer from the FAQ. */
@ApiTags('Chat inbox (admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/chat')
export class AdminChatController {
  constructor(private readonly support: ChatSupportService) {}

  @Get('stats') stats() { return this.support.adminStats(); }

  @Get('conversations')
  list(@Query() query: { status?: string; q?: string; page?: string; limit?: string }) { return this.support.adminList(query); }

  @Get('conversations/:id')
  get(@Param('id') id: string) { return this.support.adminGet(id); }

  @Post('conversations/:id/reply')
  reply(@Req() req: any, @Param('id') id: string, @Body() dto: AdminChatReplyDto) { return this.support.adminReply(req.user.userId, id, dto.text); }

  @Patch('conversations/:id/close')
  close(@Req() req: any, @Param('id') id: string) { return this.support.adminClose(req.user.userId, id); }
}
