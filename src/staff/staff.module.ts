/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Admin, AdminSchema } from '../admin/admin.schema';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { StaffRole, StaffRoleSchema, StaffInvite, StaffInviteSchema, StaffTask, StaffTaskSchema, StaffAudit, StaffAuditSchema, StaffNote, StaffNoteSchema, StaffApproval, StaffApprovalSchema, StaffSettings, StaffSettingsSchema } from './staff.schemas';
import { StaffExtrasService } from './staff-extras.service';
import { EmailService } from '../otp/services/email.service';
import { StaffService } from './staff.service';
import { StaffController, StaffInviteController } from './staff.controller';

@Module({
  imports: [
    AuthModule, RedisModule,
    JwtModule.register({ secret: process.env.JWT_SECRET }),
    MongooseModule.forFeature([
      { name: Admin.name, schema: AdminSchema }, { name: StaffRole.name, schema: StaffRoleSchema }, { name: StaffInvite.name, schema: StaffInviteSchema },
      { name: StaffTask.name, schema: StaffTaskSchema }, { name: StaffAudit.name, schema: StaffAuditSchema },
      { name: StaffNote.name, schema: StaffNoteSchema }, { name: StaffApproval.name, schema: StaffApprovalSchema }, { name: StaffSettings.name, schema: StaffSettingsSchema },
    ]),
  ],
  controllers: [StaffController, StaffInviteController],
  providers: [StaffService, StaffExtrasService, EmailService],
  exports: [StaffService, StaffExtrasService],
})
export class StaffModule {}
