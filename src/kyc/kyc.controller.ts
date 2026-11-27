/* eslint-disable prettier/prettier */
import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { KycService, KycDraftInput } from './kyc.service';

const KYC_FILE_MAX_BYTES = 10 * 1024 * 1024;

@ApiTags('Seller — Identity verification (KYC)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/seller/kyc')
export class SellerKycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  async mine(@Req() req: any) {
    return { success: true, data: await this.kyc.getMine(req.user.userId) };
  }

  @Put()
  async save(@Req() req: any, @Body() body: KycDraftInput) {
    return { success: true, data: await this.kyc.saveDraft(req.user.userId, body) };
  }

  @Post('documents/:type')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: KYC_FILE_MAX_BYTES } }))
  async upload(@Req() req: any, @Param('type') type: string, @UploadedFile() file: Express.Multer.File) {
    return { success: true, data: await this.kyc.uploadDocument(req.user.userId, type, file) };
  }

  @Post('submit')
  async submit(@Req() req: any) {
    return { success: true, data: await this.kyc.submit(req.user.userId) };
  }
}

@ApiTags('Admin — Seller KYC')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/seller-kyc')
export class AdminKycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  async list(@Query() query: any) {
    return { success: true, data: await this.kyc.adminList(query ?? {}) };
  }

  @Get(':id')
  async get(@Param('id', ParseObjectIdPipe) id: string) {
    return { success: true, data: await this.kyc.adminGet(id) };
  }

  @Patch(':id/decision')
  async decide(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() body: { decision?: string; reason?: string }) {
    const decision = body?.decision;
    if (decision !== 'approve' && decision !== 'reject' && decision !== 'revoke') {
      throw new BadRequestException('decision must be approve, reject or revoke');
    }
    return this.kyc.adminDecide(id, decision, body?.reason, { adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] });
  }
}
