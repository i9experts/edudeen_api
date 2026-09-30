import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { DatabaseService } from '../database/databaseservice';
import { MediaLibraryService } from '../media-library/media-library.service';
import { CreateOnboardingSlideDto } from './dto/create-onboarding-slide.dto';
import { UpdateOnboardingSlideDto } from './dto/update-onboarding-slide.dto';
import { ReorderOnboardingSlidesDto } from './dto/reorder-onboarding-slides.dto';

// Slides render full-bleed behind title/subtitle text on phones only — no
// desktop hero use case here, so a much smaller cap than the marketing
// banner's (2560) is enough while keeping Cloudinary storage cheap.
const SLIDE_MAX_DIMENSION = 1920;

@Injectable()
export class OnboardingSlidesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly mediaLibraryService: MediaLibraryService,
  ) {}

  private get slideModel() {
    return this.databaseService.repositories.onboardingSlideModel;
  }

  // ── GET ACTIVE (public) — consumed by the app's intro screen ──────────────

  async findActive() {
    const slides = await this.slideModel.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).lean();
    return { success: true, count: slides.length, data: slides };
  }

  // ── GET ALL incl. inactive (admin) — for the management list ──────────────

  async findAllForAdmin() {
    const slides = await this.slideModel.find().sort({ order: 1, createdAt: 1 }).lean();
    return { success: true, count: slides.length, data: slides };
  }

  // ── CREATE FROM URL (admin) ────────────────────────────────────────────────

  async createFromUrl(dto: CreateOnboardingSlideDto) {
    if (!dto.imageUrl) throw new BadRequestException('imageUrl is required');

    let hosted: { secure_url: string; public_id: string };
    try {
      hosted = await cloudinary.uploader.upload(dto.imageUrl, {
        folder: 'uploads/onboarding-slides',
        resource_type: 'image',
        transformation: [{ width: SLIDE_MAX_DIMENSION, height: SLIDE_MAX_DIMENSION, crop: 'limit' }],
      });
    } catch (err) {
      throw new BadRequestException(`Could not fetch that image URL: ${err.message || 'unknown error'}`);
    }

    const currentCount = await this.slideModel.countDocuments();

    const slide = await this.slideModel.create({
      title: dto.title,
      subtitle: dto.subtitle || '',
      imageUrl: hosted.secure_url,
      publicId: hosted.public_id,
      order: dto.order ?? currentCount,
      isActive: true,
    });

    return { success: true, message: 'Onboarding slide created successfully', data: slide };
  }

  // ── UPLOAD FILE (admin) ─────────────────────────────────────────────────────

  async uploadSlide(file: Express.Multer.File, adminId: string, title: string, subtitle?: string, order?: number) {
    if (!file) throw new BadRequestException('Please provide a slide image file');
    if (!title) throw new BadRequestException('title is required');

    const uploaded = await this.mediaLibraryService.uploadAndTrack(file, 'admin', adminId, {
      folder: 'uploads/onboarding-slides',
      maxDimension: SLIDE_MAX_DIMENSION,
    });

    const currentCount = await this.slideModel.countDocuments();

    const slide = await this.slideModel.create({
      title,
      subtitle: subtitle || '',
      imageUrl: uploaded.url,
      publicId: uploaded.publicId,
      order: order ?? currentCount,
      isActive: true,
    });

    return { success: true, message: 'Onboarding slide uploaded successfully', data: slide };
  }

  // ── EDIT (admin) ────────────────────────────────────────────────────────────

  async updateSlide(id: string, dto: UpdateOnboardingSlideDto) {
    const slide = await this.slideModel.findById(id);
    if (!slide) throw new NotFoundException('Onboarding slide not found');

    const updated = await this.slideModel.findByIdAndUpdate(id, { $set: dto }, { returnDocument: 'after', runValidators: true });
    return { success: true, message: 'Onboarding slide updated successfully', data: updated };
  }

  // ── REORDER (admin) — bulk order update for drag-and-drop management ───────

  async reorderSlides(dto: ReorderOnboardingSlidesDto) {
    await Promise.all(dto.items.map((item) => this.slideModel.updateOne({ _id: item.id }, { $set: { order: item.order } })));
    return this.findAllForAdmin();
  }

  // ── DELETE (admin) ──────────────────────────────────────────────────────────

  async deleteSlide(id: string) {
    const slide = await this.slideModel.findById(id);
    if (!slide) throw new NotFoundException('Onboarding slide not found');

    if (slide.publicId) {
      try {
        await cloudinary.uploader.destroy(slide.publicId);
      } catch (err) {
        console.warn('Could not delete from Cloudinary:', err.message);
      }
    }

    await this.slideModel.deleteOne({ _id: id });
    return { success: true, message: 'Onboarding slide deleted successfully' };
  }
}
