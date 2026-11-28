import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import {
  ProductQuestion,
  ProductQuestionSchema,
} from '../classroom/schemas/product-question.schema';
import {
  StoreAssignment,
  StoreAssignmentSchema,
} from '../managed-stores/schemas/store-assignment.schema';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { TeamService } from './team.service';
import { StaffAudit, StaffAuditSchema } from '../staff/staff.schemas';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    MongooseModule.forFeature([
      { name: ProductQuestion.name, schema: ProductQuestionSchema },
      { name: StoreAssignment.name, schema: StoreAssignmentSchema },
      { name: StaffAudit.name, schema: StaffAuditSchema },
    ]),
  ],
  controllers: [OperationsController],
  providers: [OperationsService, TeamService],
})
export class OperationsModule {}
