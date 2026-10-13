/* eslint-disable prettier/prettier */
import {
  Controller,
  Get,
  Header,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { BannersService } from './banner.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminReauthGuard } from '../admin-reauth/admin-reauth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PromotionPlacement } from '../common/promotion-placements.const';

const BANNER_UPLOAD_MIME = /\/(jpg|jpeg|png|webp)$/;
const BANNER_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
// `api/spotlight` is an additive alias of `api/banners` — some browser ad-blockers
// pattern-match and silently drop any request whose URL contains "banners" (the
// GET here is public/unauthenticated, exactly the shape those filters target),
// so the buyer-facing hero carousel fetches through the alias instead. `api/banners`
// stays fully live for existing/admin callers — nothing here is renamed or removed.
@ApiTags('Banners')
@Controller(['api/banners', 'api/spotlight'])
export class BannersController {
  constructor(private readonly bannersService: BannersService) {}

  // GET all banners — public. Omit `placement` to preserve today's unscoped behavior.
  // Admins publish/schedule banners live, so browsers/CDNs must revalidate rather than serve an older copy.
  @Header('Cache-Control', 'no-cache')
  @Get()
  findAll(@Query('placement') placement?: PromotionPlacement) {
    return this.bannersService.findAll(placement);
  }

  // GET every banner in every state — admin only (the public GET above only returns what is live)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Get('admin/all')
  findAllForAdmin() {
    return this.bannersService.findAllForAdmin();
  }

  // GET banner count — admin only
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Get('count')
  getCount(@Query('placement') placement?: PromotionPlacement) {
    return this.bannersService.getCount(placement);
  }

  // POST via JSON URL — admin only
  @UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createFromUrl(@Body() dto: CreateBannerDto) {
    return this.bannersService.createFromUrl(dto);
  }

  // POST via file upload — admin only
  @UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: BANNER_UPLOAD_MAX_BYTES },
      fileFilter: (_req, file, callback) => {
        if (!file.mimetype.match(BANNER_UPLOAD_MIME)) {
          return callback(new BadRequestException(`Invalid file type "${file.mimetype}". Only jpg, jpeg, png, webp are allowed.`), false);
        }
        callback(null, true);
      },
    }),
  )
  async uploadBanner(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Query('urlOnTap') urlOnTap?: string,
    @Query('placement') placement?: string,
  ) {
    if (!file) throw new BadRequestException('Please provide a banner image file');
    return this.bannersService.uploadBanner(file, req.user.userId, urlOnTap, placement);
  }

  // PATCH edit banner — admin only
  @UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Patch(':id')
  updateBanner(@Param('id') id: string, @Body() dto: UpdateBannerDto) {
    return this.bannersService.updateBanner(id, dto);
  }

  // PATCH pause banner — admin only
  @UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Patch(':id/pause')
  pauseBanner(@Param('id') id: string) {
    return this.bannersService.pauseBanner(id);
  }

  // PATCH resume banner — admin only
  @UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Patch(':id/resume')
  resumeBanner(@Param('id') id: string) {
    return this.bannersService.resumeBanner(id);
  }

  // DELETE banner — admin only
  @UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Delete(':id')
  deleteBanner(@Param('id') id: string) {
    return this.bannersService.deleteBanner(id);
  }
}
