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
  Delete,
  Query,
  Optional,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadService } from './upload.service';
import { UploadedAssetsService } from './uploaded-assets.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { STORE_IMAGE_PURPOSES, assertStoreImage } from '../common/store-image.util';
import { posterFromVideoUrl, sniffVideo } from '../products/product-video.util';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DatabaseService } from '../database/databaseservice';

/** Product video cap (Cloudinary free plan allows up to 100 MB per video). */
export const PRODUCT_VIDEO_MAX_BYTES = 60 * 1024 * 1024;

/** Public upload cap - this route is open to every signed-in account (buyers too), so it stays small. */
export const PUBLIC_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

@Controller('api/upload')
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly uploadedAssets: UploadedAssetsService,
    @Optional() private readonly activity?: ActivityLogService,
    @Optional() private readonly db?: DatabaseService,
  ) {}

  // ── PUBLIC file (images, videos) — koi bhi logged-in user ──
  @Post('file')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: PUBLIC_UPLOAD_MAX_BYTES }, // any logged-in user: small public files only (sold files use /private-file)
  }))
  async uploadFile(@UploadedFile() file: Express.Multer.File, @Body('purpose') purpose?: string) {
    if (!file) throw new BadRequestException('No file uploaded');
    // Optional purpose = extra rules for that kind of image (store logo / cover: type, size, dimensions).
    // No purpose = the original behaviour, so every other upload is unaffected.
    if (purpose !== undefined && purpose !== '') {
      const kind = STORE_IMAGE_PURPOSES[String(purpose)];
      if (!kind) throw new BadRequestException('Unknown upload purpose');
      assertStoreImage(file, kind);
    }
    const result = await this.uploadService.uploadFile(file);
    return { success: true, message: 'File uploaded successfully', data: result };
  }

  // ── Product video (public, played on the product page) — sirf seller, mp4/mov/webm, max 60 MB ──
  @Post('product-video')
  @UseGuards(RolesGuard)
  @Roles('seller')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: PRODUCT_VIDEO_MAX_BYTES },
  }))
  async uploadProductVideo(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    const ext = (file.originalname?.split('.').pop() ?? '').toLowerCase();
    if (!['mp4', 'mov', 'webm'].includes(ext)) throw new BadRequestException('Video must be an .mp4, .mov or .webm file');
    if (!sniffVideo(file.buffer)) throw new BadRequestException('The file is not a real video');
    const result = await this.uploadService.uploadFile(file, { folder: 'uploads/product-videos' });
    const poster = posterFromVideoUrl(result.url);
    return { success: true, message: 'Video uploaded successfully', data: { ...result, posterUrl: poster } };
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

  // ── Delete one of MY unused private files (test / abandoned uploads) — sirf seller ──
  // DELETE /api/upload/private-file?publicId=<id from private-file>. 404 = not found or not yours; 409 = in use.
  @Delete('private-file')
  @UseGuards(RolesGuard)
  @Roles('seller')
  async deletePrivateFile(@Req() req: { user: { userId: string; role: string } }, @Query('publicId') publicId?: string) {
    const out = await this.uploadedAssets.deleteOwnedUnreferenced(req.user.userId, publicId, (id, type) => this.uploadService.deletePrivateFile(id, type));
    const store: any = this.db ? await this.db.repositories.storeModel.findOne({ sellerId: req.user.userId, isDelete: false }).select('_id').lean().catch(() => null) : null;
    await this.activity?.log({
      storeId: store?._id ? String(store._id) : 'platform', category: 'products', action: 'private_file_deleted',
      description: `Deleted unused private file ${out.fileName ?? out.publicId}`, actorId: req.user.userId, actorRole: req.user.role,
      targetId: out.publicId, targetType: 'uploaded_asset', metadata: { fileSize: out.fileSize },
    } as any);
    return { success: true, message: 'File deleted', data: { publicId: out.publicId } };
  }
}
