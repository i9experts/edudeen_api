import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { UploadedAssetsService } from './uploaded-assets.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';

@Module({
  imports: [ConfigModule, AuthModule, RedisModule],
  controllers: [UploadController],
  providers: [UploadService, UploadedAssetsService],
  exports: [UploadService, UploadedAssetsService],
})
export class UploadModule {}
