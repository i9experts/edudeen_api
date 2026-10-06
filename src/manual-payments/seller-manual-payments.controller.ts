/* eslint-disable prettier/prettier */
import { Controller, Get, Put, Patch, Param, Query, Body, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ManualPaymentsService } from './manual-payments.service';
import { StorePaymentSettingsDto } from './dto/store-payment-settings.dto';
import { RejectManualPaymentDto } from './dto/reject-manual-payment.dto';

/** The seller's side of direct bank transfers: where buyers pay, and confirming that the money arrived. */
@ApiTags('Seller — Direct bank transfer')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/seller/manual-payments/:storeId')
export class SellerManualPaymentsController {
  constructor(private readonly service: ManualPaymentsService) {}

  @Get('settings')
  async getSettings(@Req() req: any, @Param('storeId') storeId: string) {
    return { success: true, data: await this.service.getStorePaymentSettings(req.user.userId, storeId) };
  }

  @Put('settings')
  async updateSettings(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: StorePaymentSettingsDto) {
    return { success: true, data: await this.service.updateStorePaymentSettings(req.user.userId, storeId, dto) };
  }

  @Get('proofs')
  async list(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return { success: true, data: await this.service.sellerListProofs(req.user.userId, storeId, query) };
  }

  @Get('proofs/:proofId/proof-url')
  async proofUrl(@Req() req: any, @Param('storeId') storeId: string, @Param('proofId') proofId: string) {
    return { success: true, data: await this.service.sellerGetProofUrl(req.user.userId, storeId, proofId) };
  }

  @Patch('proofs/:proofId/approve')
  async approve(@Req() req: any, @Param('storeId') storeId: string, @Param('proofId') proofId: string) {
    return { success: true, data: await this.service.sellerApprove(req.user.userId, storeId, proofId, req.ip, req.headers['user-agent']) };
  }

  @Patch('proofs/:proofId/reject')
  async reject(@Req() req: any, @Param('storeId') storeId: string, @Param('proofId') proofId: string, @Body() dto: RejectManualPaymentDto) {
    return { success: true, data: await this.service.sellerReject(req.user.userId, storeId, proofId, dto.reason, req.ip, req.headers['user-agent']) };
  }
}
