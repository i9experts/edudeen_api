import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { EmailService } from '../otp/services/email.service';
import {
  StoreAssignment,
  StoreAssignmentSchema,
} from './schemas/store-assignment.schema';
import { ManagedStoresService } from './managed-stores.service';
import { ManagedStoresController } from './managed-stores.controller';
import { ManagedStoresJobs } from './managed-stores.jobs';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    UploadModule,
    MongooseModule.forFeature([
      { name: StoreAssignment.name, schema: StoreAssignmentSchema },
    ]),
  ],
  controllers: [ManagedStoresController],
  providers: [ManagedStoresService, ManagedStoresJobs, EmailService],
  exports: [ManagedStoresService],
})
export class ManagedStoresModule {}
