import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PlatformTestimonial, PlatformTestimonialDocument } from './schemas/platform-testimonial.schema';
import { CreateTestimonialDto, UpdateTestimonialDto } from './dto/testimonial.dto';

@Injectable()
export class TestimonialsService {
  constructor(
    @InjectModel(PlatformTestimonial.name)
    private testimonialModel: Model<PlatformTestimonialDocument>,
  ) {}

  // ─── PUBLIC — homepage social-proof section ─────────────────────────────
  async findAllActive(limit: number) {
    const testimonials = await this.testimonialModel
      .find({ isActive: true })
      .sort({ order: 1, createdAt: -1 })
      .limit(limit)
      .lean();

    return {
      success: true,
      count: testimonials.length,
      data: testimonials.map((t: any) => ({
        id: t._id.toString(),
        name: t.sellerName,
        storeName: t.storeName ?? null,
        rating: t.rating,
        text: t.text,
        isVerifiedSeller: t.isVerifiedSeller,
      })),
    };
  }

  // ─── ADMIN ───────────────────────────────────────────────────────────────
  async findAll() {
    const testimonials = await this.testimonialModel.find().sort({ order: 1, createdAt: -1 }).exec();
    const active = testimonials.filter((t) => t.isActive).length;
    const inactive = testimonials.length - active;

    return { success: true, count: testimonials.length, stats: { active, inactive }, data: testimonials };
  }

  async create(dto: CreateTestimonialDto) {
    const testimonial = await this.testimonialModel.create(dto);
    return { success: true, message: 'Testimonial created successfully', data: testimonial };
  }

  async update(id: string, dto: UpdateTestimonialDto) {
    const testimonial = await this.testimonialModel.findByIdAndUpdate(id, dto, { returnDocument: 'after' }).exec();
    if (!testimonial) throw new NotFoundException('Testimonial not found');
    return { success: true, message: 'Testimonial updated successfully', data: testimonial };
  }

  async toggleActive(id: string) {
    const testimonial = await this.testimonialModel.findById(id).exec();
    if (!testimonial) throw new NotFoundException('Testimonial not found');

    testimonial.isActive = !testimonial.isActive;
    await testimonial.save();

    return { success: true, message: `Testimonial ${testimonial.isActive ? 'activated' : 'deactivated'}`, data: testimonial };
  }

  async remove(id: string) {
    const testimonial = await this.testimonialModel.findByIdAndDelete(id).exec();
    if (!testimonial) throw new NotFoundException('Testimonial not found');
    return { success: true, message: 'Testimonial deleted successfully' };
  }
}
