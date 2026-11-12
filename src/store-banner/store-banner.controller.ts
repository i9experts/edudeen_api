/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreBannerService } from './store-banner.service';
import { CreateStoreBannerDto } from './dto/create-store-banner.dto';
import { UpdateStoreBannerDto } from './dto/update-store-banner.dto';

const CREATIVE_UPLOAD = FileFieldsInterceptor(
  [
    { name: 'file', maxCount: 1 },
    { name: 'mobileFile', maxCount: 1 },
  ],
  { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } },
);

@ApiTags('Store Banners')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/store-banner')
export class StoreBannerController {
  constructor(private readonly storeBannerService: StoreBannerService) {}

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeBannerService.listForSeller(storeId, req.user.userId);
  }

  @Post(':storeId')
  @UseInterceptors(CREATIVE_UPLOAD)
  create(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() dto: CreateStoreBannerDto,
    @UploadedFiles() files: { file?: Express.Multer.File[]; mobileFile?: Express.Multer.File[] },
  ) {
    return this.storeBannerService.create(storeId, req.user.userId, dto, files?.file?.[0], files?.mobileFile?.[0]);
  }

  // Declared BEFORE ':storeId/:bannerId' so "reorder" is not read as a banner id.
  @Patch(':storeId/reorder')
  reorder(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { ids?: unknown }) {
    return this.storeBannerService.reorder(storeId, req.user.userId, body?.ids);
  }

  @Patch(':storeId/:bannerId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('bannerId') bannerId: string, @Body() dto: UpdateStoreBannerDto) {
    return this.storeBannerService.update(storeId, req.user.userId, bannerId, dto);
  }

  @Patch(':storeId/:bannerId/pause')
  pause(@Req() req: any, @Param('storeId') storeId: string, @Param('bannerId') bannerId: string) {
    return this.storeBannerService.pause(storeId, req.user.userId, bannerId);
  }

  @Patch(':storeId/:bannerId/resume')
  resume(@Req() req: any, @Param('storeId') storeId: string, @Param('bannerId') bannerId: string) {
    return this.storeBannerService.resume(storeId, req.user.userId, bannerId);
  }

  @Get(':storeId/:bannerId/timeline')
  timeline(@Req() req: any, @Param('storeId') storeId: string, @Param('bannerId') bannerId: string) {
    return this.storeBannerService.timeline(storeId, req.user.userId, bannerId);
  }

  @Delete(':storeId/:bannerId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('bannerId') bannerId: string) {
    return this.storeBannerService.remove(storeId, req.user.userId, bannerId);
  }
}
