import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { EmailService } from '../otp/services/email.service';
import { StoreMember, StoreMemberSchema } from './store-member.schema';
import { StoreTeamController } from './store-team.controller';
import { StoreTeamService } from './store-team.service';

@Module({
  imports: [AuthModule, RedisModule, MongooseModule.forFeature([{ name: StoreMember.name, schema: StoreMemberSchema }])],
  controllers: [StoreTeamController],
  providers: [StoreTeamService, EmailService],
  exports: [StoreTeamService],
})
export class StoreTeamModule {}
