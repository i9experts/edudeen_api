/* eslint-disable prettier/prettier */
import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  BadRequestException,
  Body,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadService } from './upload.service';
import { UploadedAssetsService } from './uploaded-assets.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/upload')
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly uploadedAssets: UploadedAssetsService,
  ) {}

  // ── PUBLIC file (images, videos) — koi bhi logged-in user ──
  @Post('file')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  }))
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    const result = await this.uploadService.uploadFile(file);
    return { success: true, message: 'File uploaded successfully', data: result };
  }

  // ── PRIVATE file (digital products for sale) — sirf seller ──
  @Post('private-file')
  @UseGuards(RolesGuard)
  @Roles('seller')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  }))
  async uploadPrivateFile(@Req() req: { user: { userId: string; role: string } }, @UploadedFile() file: Express.Multer.File, @Body('purpose') purpose?: string) {
    if (!file) throw new BadRequestException('No file uploaded');
    // Only a known purpose gets its own folder — anything else (including
    // omitted) keeps the original digital-products default so that flow is
    // never affected by this addition.
    const folder = purpose === 'kyc_document' ? 'private/kyc-documents' : undefined;
    const result = await this.uploadService.uploadPrivateFile(file, folder);
    // Ownership record: the ONLY thing that later lets this publicId be referenced (as a product
    // file or a KYC document) — and only by the uploader. Kind is derived from the folder here.
    await this.uploadedAssets.record({
      publicId: result.publicId, ownerId: req.user.userId, ownerRole: req.user.role,
      kind: folder === 'private/kyc-documents' ? 'kyc_document' : 'digital_product',
      resourceType: result.resourceType, fileName: result.fileName, fileSize: result.fileSize, mimeType: result.mimeType,
    });
    return {
      success: true,
      message: 'Private file uploaded successfully',
      data: result,
      note: 'Save publicId in your product — URL is not accessible directly',
    };
  }
}
