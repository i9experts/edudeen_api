/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { SellerKyc, SellerKycSchema } from './schemas/seller-kyc.schema';
import { KycService } from './kyc.service';
import { AdminKycController, SellerKycController } from './kyc.controller';

@Module({
  imports: [AuthModule, RedisModule, UploadModule, MongooseModule.forFeature([{ name: SellerKyc.name, schema: SellerKycSchema }])],
  controllers: [SellerKycController, AdminKycController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
