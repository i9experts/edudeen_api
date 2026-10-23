import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Param,
  Body,
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
import { OnboardingSlidesService } from './onboarding-slides.service';
import { CreateOnboardingSlideDto } from './dto/create-onboarding-slide.dto';
import { UpdateOnboardingSlideDto } from './dto/update-onboarding-slide.dto';
import { ReorderOnboardingSlidesDto } from './dto/reorder-onboarding-slides.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { assertRasterImage } from '../common/file-signature.util';

const SLIDE_UPLOAD_MIME = /\/(jpg|jpeg|png|webp)$/;
const SLIDE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

@ApiTags('Onboarding Slides')
@Controller('api/onboarding-slides')
export class OnboardingSlidesController {
  constructor(private readonly onboardingSlidesService: OnboardingSlidesService) {}

  // GET active slides — public, consumed by the app's first-launch intro screen
  @Get()
  findActive() {
    return this.onboardingSlidesService.findActive();
  }

  // GET all slides incl. inactive — admin only, for the management list
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Get('admin')
  findAllForAdmin() {
    return this.onboardingSlidesService.findAllForAdmin();
  }

  // POST via JSON image URL — admin only
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createFromUrl(@Body() dto: CreateOnboardingSlideDto) {
    return this.onboardingSlidesService.createFromUrl(dto);
  }

  // POST via file upload — admin only
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: SLIDE_UPLOAD_MAX_BYTES },
      fileFilter: (_req, file, callback) => {
        if (!file.mimetype.match(SLIDE_UPLOAD_MIME)) {
          return callback(new BadRequestException(`Invalid file type "${file.mimetype}". Only jpg, jpeg, png, webp are allowed.`), false);
        }
        callback(null, true);
      },
    }),
  )
  async uploadSlide(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Body('title') title: string,
    @Body('subtitle') subtitle?: string,
    @Body('order') order?: string,
  ) {
    if (!file) throw new BadRequestException('Please provide a slide image file');
    file.mimetype = assertRasterImage(file);
    return this.onboardingSlidesService.uploadSlide(file, req.user.userId, title, subtitle, order !== undefined ? Number(order) : undefined);
  }

  // PATCH edit slide — admin only
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Patch(':id')
  updateSlide(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateOnboardingSlideDto) {
    return this.onboardingSlidesService.updateSlide(id, dto);
  }

  // PUT reorder slides — admin only, bulk order update for drag-and-drop UI
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Put('reorder')
  reorderSlides(@Body() dto: ReorderOnboardingSlidesDto) {
    return this.onboardingSlidesService.reorderSlides(dto);
  }

  // DELETE slide — admin only
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Delete(':id')
  deleteSlide(@Param('id', ParseObjectIdPipe) id: string) {
    return this.onboardingSlidesService.deleteSlide(id);
  }
}
