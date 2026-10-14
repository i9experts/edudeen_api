import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Faq, FaqSchema } from './schemas/faq.schema';
import { FaqService } from './faq.service';
import { FaqController } from './faq.controller';
import { RedisModule } from 'src/redis/redis.module';
import { AdminReauthModule } from '../admin-reauth/admin-reauth.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Faq.name, schema: FaqSchema }]),
    RedisModule,
    AdminReauthModule,
  ],
  controllers: [FaqController],
  providers: [FaqService],
  exports: [FaqService], // ✅ Export for use in other modules if needed
})
export class FaqModule {}
