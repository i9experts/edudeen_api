/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { AiStudioModule } from '../ai-studio/ai-studio.module';
import { EmailService } from '../otp/services/email.service';
import { ChatbotController } from './chatbot.controller';
import { ChatbotService } from './chatbot.service';
import { ChatTranslator } from './chat-translator.service';
import { ChatSupportService } from './chat-support.service';
import { AdminChatController } from './chat-admin.controller';
import { ChatConversation, ChatConversationSchema } from './chat-conversation.schema';

/**
 * Edudeen Help chat widget backend. Reuses the AI Studio help-bot (HelpBotService / AiService); builds no second AI path.
 * Questions the FAQ cannot answer are escalated to the admin chat inbox (ChatSupportService) instead of the AI.
 * NotificationsService / ActivityLogService / DatabaseService are global modules.
 */
@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule, AiStudioModule, MongooseModule.forFeature([{ name: ChatConversation.name, schema: ChatConversationSchema }])],
  controllers: [ChatbotController, AdminChatController],
  providers: [ChatbotService, ChatTranslator, ChatSupportService, EmailService],
})
export class ChatbotModule {}
