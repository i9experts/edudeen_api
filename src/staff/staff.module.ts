/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Admin, AdminSchema } from '../admin/admin.schema';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { StaffRole, StaffRoleSchema, StaffInvite, StaffInviteSchema, StaffTask, StaffTaskSchema, StaffAudit, StaffAuditSchema } from './staff.schemas';
import { StaffService } from './staff.service';
import { StaffController, StaffInviteController } from './staff.controller';

@Module({
  imports: [
    AuthModule, RedisModule,
    JwtModule.register({ secret: process.env.JWT_SECRET }),
    MongooseModule.forFeature([
      { name: Admin.name, schema: AdminSchema }, { name: StaffRole.name, schema: StaffRoleSchema }, { name: StaffInvite.name, schema: StaffInviteSchema },
      { name: StaffTask.name, schema: StaffTaskSchema }, { name: StaffAudit.name, schema: StaffAuditSchema },
    ]),
  ],
  controllers: [StaffController, StaffInviteController],
  providers: [StaffService],
  exports: [StaffService],
})
export class StaffModule {}
