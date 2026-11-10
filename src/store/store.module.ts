import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StoreCustomersService } from './store-customers.service';
import { StoreCustomerNote, StoreCustomerNoteSchema } from './schemas/store-customer-note.schema';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { AdminConfigModule } from 'src/admin-config/admin-config.module';
import { MarketingModule } from 'src/marketing/marketing.module';
import { UploadModule } from 'src/upload/upload.module';
import { StoreThemeModule } from '../store-theme/store-theme.module';
import { StorePagesModule } from '../store-pages/store-pages.module';
import { CollectionsModule } from '../collections/collections.module';

@Module({
  imports: [MongooseModule.forFeature([{ name: StoreCustomerNote.name, schema: StoreCustomerNoteSchema }]), AuthModule, RedisModule, AdminConfigModule, MarketingModule, UploadModule, StoreThemeModule, StorePagesModule, CollectionsModule],
  controllers: [StoreController],
  providers: [StoreService, StoreCustomersService],
  exports: [StoreService],
})
export class StoreModule {}
