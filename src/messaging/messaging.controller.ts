/* eslint-disable prettier/prettier */
import { Throttle } from '@nestjs/throttler';
import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Req, UseGuards,
  UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { MessagingService } from './messaging.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StartConversationDto } from './dto/start-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { BlockDto } from './dto/block.dto';
import { ReportDto } from './dto/report.dto';
import { AdminUpdateMessagingReportDto } from './dto/admin-update-report.dto';

@ApiTags('Messaging')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/messaging')
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) { }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONVERSATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  // Starts or retrieves a conversation with a store, acting as the buyer side.
  // Also open to 'seller' accounts — a seller is still allowed to message a
  // DIFFERENT store as a customer (see the self-message guard in the service).
  @UseGuards(RolesGuard)
  @Roles('user', 'seller')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('conversations')
  startConversation(@Req() req: any, @Body() dto: StartConversationDto) {
    return this.messagingService.startOrGetConversation(req.user.userId, dto);
  }

  // Seller/buyer/admin lists their inbox
  @Get('conversations')
  getConversations(@Req() req: any, @Query() query: any) {
    return this.messagingService.getConversations(req.user.userId, req.user.role, query);
  }

  // ── Static routes BEFORE /:id ─────────────────────────────────────────────

  @Get('conversations/search')
  searchConversations(@Req() req: any, @Query('q') q: string, @Query('storeId') storeId?: string) {
    return this.messagingService.searchConversations(req.user.userId, req.user.role, q, storeId);
  }

  // ── Parameterized routes ──────────────────────────────────────────────────

  @Get('conversations/:id')
  getConversation(@Req() req: any, @Param('id') id: string) {
    return this.messagingService.getConversationById(req.user.userId, req.user.role, id);
  }

  @UseGuards(RolesGuard)
  @Roles('seller')
  @Patch('conversations/:id/archive')
  archiveConversation(@Req() req: any, @Param('id') id: string) {
    return this.messagingService.archiveConversation(req.user.userId, id, true);
  }

  @UseGuards(RolesGuard)
  @Roles('seller')
  @Patch('conversations/:id/restore')
  restoreConversation(@Req() req: any, @Param('id') id: string) {
    return this.messagingService.archiveConversation(req.user.userId, id, false);
  }

  @UseGuards(RolesGuard)
  @Roles('seller')
  @Patch('conversations/:id/pin')
  pinConversation(@Req() req: any, @Param('id') id: string, @Query('pin') pin: string) {
    return this.messagingService.pinConversation(req.user.userId, id, pin !== 'false');
  }

  @UseGuards(RolesGuard)
  @Roles('seller')
  @Patch('conversations/:id/mute')
  muteConversation(@Req() req: any, @Param('id') id: string, @Query('mute') mute: string) {
    return this.messagingService.muteConversation(req.user.userId, id, mute !== 'false');
  }

  @Delete('conversations/:id')
  deleteConversation(@Req() req: any, @Param('id') id: string) {
    return this.messagingService.deleteConversationForSelf(req.user.userId, req.user.role, id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGES  (nested under a conversation)
  // ═══════════════════════════════════════════════════════════════════════════

  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post('conversations/:convId/messages')
  sendMessage(@Req() req: any, @Param('convId') convId: string, @Body() dto: SendMessageDto) {
    return this.messagingService.sendMessage(req.user.userId, req.user.role, convId, dto);
  }

  // Static sub-route BEFORE cursor-paginated list
  @Get('conversations/:convId/messages/search')
  searchMessages(@Req() req: any, @Param('convId') convId: string, @Query('q') q: string) {
    return this.messagingService.searchMessages(req.user.userId, req.user.role, convId, q);
  }

  // Cursor-paginated message list: ?before=<messageId>&limit=30
  @Get('conversations/:convId/messages')
  getMessages(@Req() req: any, @Param('convId') convId: string, @Query() query: any) {
    return this.messagingService.getMessages(req.user.userId, req.user.role, convId, query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ATTACHMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('conversations/:convId/attachments')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB (was 100 MB, held in memory)
  }))
  uploadAttachment(
    @Req() req: any,
    @Param('convId') convId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.messagingService.uploadAttachment(req.user.userId, req.user.role, convId, file);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE OPERATIONS  (by message ID)
  // ═══════════════════════════════════════════════════════════════════════════

  @Patch('messages/:id')
  editMessage(@Req() req: any, @Param('id') id: string, @Body() dto: EditMessageDto) {
    return this.messagingService.editMessage(req.user.userId, id, dto);
  }

  @Delete('messages/:id')
  deleteMessage(@Req() req: any, @Param('id') id: string) {
    return this.messagingService.deleteMessageForSelf(req.user.userId, id);
  }

  // Mark messages as seen up to this message ID
  @Post('messages/:id/seen')
  markSeen(@Req() req: any, @Param('id') id: string, @Query('conversationId') conversationId: string) {
    return this.messagingService.markSeen(req.user.userId, req.user.role, conversationId, id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODERATION
  // ═══════════════════════════════════════════════════════════════════════════

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('block')
  blockUser(@Req() req: any, @Body() dto: BlockDto) {
    return this.messagingService.blockUser(req.user.userId, req.user.role, dto);
  }

  @Delete('block/:targetId')
  unblockUser(@Req() req: any, @Param('targetId') targetId: string) {
    return this.messagingService.unblockUser(req.user.userId, targetId);
  }

  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('report')
  reportTarget(@Req() req: any, @Body() dto: ReportDto) {
    return this.messagingService.reportTarget(req.user.userId, req.user.role, dto);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN  (static routes before parameterized)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Get('admin/conversations')
  adminGetConversations(@Query() query: any) {
    return this.messagingService.adminGetConversations(query);
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Get('admin/reports')
  adminGetReports(@Query() query: any) {
    return this.messagingService.adminGetReports(query);
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Patch('admin/reports/:id')
  adminUpdateReport(@Req() req: any, @Param('id') id: string, @Body() dto: AdminUpdateMessagingReportDto) {
    return this.messagingService.adminUpdateReport(id, dto, req.user.userId);
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Get('admin/conversations/:id')
  adminGetConversation(@Param('id') id: string) {
    return this.messagingService.adminGetConversation(id);
  }
}
