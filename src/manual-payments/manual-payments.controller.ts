/* eslint-disable prettier/prettier */
import {
  Controller, Get, Post, Param, Body, Req, UseGuards, UseInterceptors, UploadedFile, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { ManualPaymentsService } from './manual-payments.service';
import { SubmitManualPaymentDto } from './dto/submit-manual-payment.dto';
import { ReuploadManualPaymentDto } from './dto/reupload-manual-payment.dto';

const PROOF_UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB — a phone screenshot/receipt photo, not a large document
};

@ApiTags('Buyer — Manual Bank Transfer (Pakistan)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
@Controller('api/payment/manual-transfer')
export class ManualPaymentsController {
  constructor(private readonly manualPaymentsService: ManualPaymentsService) {}

  // Static routes before parameterized ones.
  // Every route below wraps the service result in the `{success, message?,
  // data}` envelope — matching the sibling `PaymentController` routes under
  // this same `api/payment/*` prefix (the service layer itself stays
  // envelope-agnostic, same as FinanceService, so it's reusable either way).
  @Get('bank-details')
  async getBankDetails() {
    const data = await this.manualPaymentsService.getBankDetails();
    return { success: true, data };
  }

  @Post('submit')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', PROOF_UPLOAD_OPTIONS), IdempotencyInterceptor)
  @UsePipes(new ValidationPipe({ transform: true }))
  async submitPayment(@Req() req: any, @Body() dto: SubmitManualPaymentDto, @UploadedFile() file: Express.Multer.File) {
    const result = await this.manualPaymentsService.submitPayment(req.user.userId, dto, file);
    return { success: true, message: result.message, data: { proof: result.proof, orders: result.orders } };
  }

  @Get()
  async getMyProofs(@Req() req: any) {
    const data = await this.manualPaymentsService.getMyProofs(req.user.userId);
    return { success: true, data };
  }

  @Get(':proofId')
  async getProofStatus(@Req() req: any, @Param('proofId') proofId: string) {
    const data = await this.manualPaymentsService.getProofStatus(req.user.userId, proofId);
    return { success: true, data };
  }

  @Post(':proofId/reupload')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', PROOF_UPLOAD_OPTIONS))
  @UsePipes(new ValidationPipe({ transform: true }))
  async reuploadPayment(
    @Req() req: any,
    @Param('proofId') proofId: string,
    @Body() dto: ReuploadManualPaymentDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const data = await this.manualPaymentsService.reuploadPayment(req.user.userId, proofId, dto, file);
    return { success: true, message: 'Proof re-uploaded — awaiting review.', data };
  }
}
