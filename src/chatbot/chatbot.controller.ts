/* eslint-disable prettier/prettier */
import { Body, Controller, Get, HttpCode, NotFoundException, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ChatbotService } from './chatbot.service';
import { ChatRequester, ChatSupportService, CHAT_MAX_TEXT } from './chat-support.service';

export class ChatGuestDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
}

export class ChatMessageDto {
  @IsIn(['buyer', 'seller']) audience: 'buyer' | 'seller';
  @IsString() @MinLength(1) @MaxLength(1000) text: string;
  @IsOptional() @IsIn(['en', 'ur']) lang?: 'en' | 'ur';
  @IsOptional() @IsBoolean() langNoticeShown?: boolean;
  /** Guests only: random token issued on the first escalation (kept in the guest's browser). */
  @IsOptional() @IsString() @MaxLength(100) guestToken?: string;
  /** Guests only: name + email/phone, asked once. Ignored for logged-in users (identity comes from the JWT). */
  @IsOptional() @ValidateNested() @Type(() => ChatGuestDto) guest?: ChatGuestDto;
}

export class ChatFollowUpDto {
  @IsString() @MinLength(1) @MaxLength(CHAT_MAX_TEXT) text: string;
  @IsOptional() @IsString() @MaxLength(100) guestToken?: string;
}

export function requesterOf(req: any, guestToken?: string | null): ChatRequester {
  return { userId: req.user?.userId ?? null, role: req.user?.role ?? null, ip: req.ip ?? null, guestToken: guestToken || null };
}

/** Public chat-widget endpoints: throttled, optional auth. Escalated conversations are visible only to their owner. */
@ApiTags('Chatbot')
@Controller('api/chatbot')
export class ChatbotController {
  constructor(private readonly chatbot: ChatbotService, private readonly support: ChatSupportService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('message')
  async message(@Req() req: any, @Body() dto: ChatMessageDto) {
    const data = await this.chatbot.handle({
      audience: dto.audience, text: dto.text, lang: dto.lang, langNoticeShown: dto.langNoticeShown,
      userId: req.user?.userId ?? null, role: req.user?.role ?? null, ip: req.ip ?? null,
      guestToken: dto.guestToken ?? null, guest: dto.guest ?? null,
    });
    return { success: true, data };
  }

  /** The caller's own active conversation (account: by userId; guest: by guestToken). `since` = ISO time, returns newer messages only. */
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('conversation')
  async conversation(@Req() req: any, @Query('since') since?: string, @Query('guestToken') guestToken?: string, @Query('markRead') markRead?: string) {
    const conversation = await this.support.userView(requesterOf(req, guestToken), { since, markRead: markRead === '1' || markRead === 'true' });
    return { success: true, data: { conversation, serverTime: new Date().toISOString() } };
  }

  /** Follow-up message inside the active conversation. */
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('conversation/message')
  async followUp(@Req() req: any, @Body() dto: ChatFollowUpDto) {
    const r = await this.support.followUp(requesterOf(req, dto.guestToken), dto.text);
    if (!r) throw new NotFoundException('No active conversation');
    if (r.kind === 'rate_limited') return { success: false, message: 'Too many messages, please wait a little.', data: { source: 'rate_limited' } };
    const conv: any = (r as any).conv;
    return { success: true, data: { source: 'escalated', conversationId: String(conv._id), shortCode: conv.shortCode, status: conv.status, messageId: r.kind === 'escalated' ? r.messageId : '' } };
  }
}
