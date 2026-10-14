/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { AiStudioModule } from '../ai-studio/ai-studio.module';
import { ChatbotController } from './chatbot.controller';
import { ChatbotService } from './chatbot.service';
import { ChatTranslator } from './chat-translator.service';

/** Edudeen Help chat widget backend. Reuses the AI Studio help-bot (HelpBotService / AiService); builds no second AI path. */
@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule, AiStudioModule],
  controllers: [ChatbotController],
  providers: [ChatbotService, ChatTranslator],
})
export class ChatbotModule {}
