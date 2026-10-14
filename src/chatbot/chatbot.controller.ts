/* eslint-disable prettier/prettier */
import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ChatbotService } from './chatbot.service';

export class ChatMessageDto {
  @IsIn(['buyer', 'seller']) audience: 'buyer' | 'seller';
  @IsString() @MinLength(1) @MaxLength(400) text: string;
  @IsOptional() @IsIn(['en', 'ur']) lang?: 'en' | 'ur';
  @IsOptional() @IsBoolean() langNoticeShown?: boolean;
}

/** Public chat-widget endpoint: throttled, optional auth, nothing is stored or logged from the message. */
@ApiTags('Chatbot')
@Controller('api/chatbot')
export class ChatbotController {
  constructor(private readonly chatbot: ChatbotService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('message')
  async message(@Req() req: any, @Body() dto: ChatMessageDto) {
    const data = await this.chatbot.handle({
      audience: dto.audience, text: dto.text, lang: dto.lang, langNoticeShown: dto.langNoticeShown,
      userId: req.user?.userId ?? null, ip: req.ip ?? null,
    });
    return { success: true, data };
  }
}
