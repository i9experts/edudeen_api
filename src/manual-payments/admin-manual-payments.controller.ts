/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Param, Body, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ManualPaymentsService } from './manual-payments.service';
import { RejectManualPaymentDto } from './dto/reject-manual-payment.dto';

@ApiTags('Admin — Manual Bank Transfer Verification')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/manual-payments')
export class AdminManualPaymentsController {
  constructor(private readonly manualPaymentsService: ManualPaymentsService) {}

  @Get()
  async listQueue(@Query() query: any) {
    const data = await this.manualPaymentsService.adminListQueue(query);
    return { success: true, data };
  }

  @Get(':proofId/proof-url')
  async getProofUrl(@Param('proofId') proofId: string) {
    const data = await this.manualPaymentsService.adminGetProofUrl(proofId);
    return { success: true, data };
  }

  @Get(':proofId')
  async getById(@Param('proofId') proofId: string) {
    const data = await this.manualPaymentsService.adminGetById(proofId);
    return { success: true, data };
  }

  @Patch(':proofId/approve')
  async approve(@Req() req: any, @Param('proofId') proofId: string) {
    const data = await this.manualPaymentsService.adminApprove(proofId, req.user.userId, req.ip, req.headers['user-agent']);
    return { success: true, data };
  }

  @UsePipes(new ValidationPipe({ transform: true }))
  @Patch(':proofId/reject')
  async reject(@Req() req: any, @Param('proofId') proofId: string, @Body() dto: RejectManualPaymentDto) {
    const data = await this.manualPaymentsService.adminReject(proofId, req.user.userId, dto.reason, req.ip, req.headers['user-agent']);
    return { success: true, data };
  }
}
