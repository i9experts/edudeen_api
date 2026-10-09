import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Faq, FaqDocument } from './schemas/faq.schema';
import { CreateFaqDto, UpdateFaqDto } from './dto/faq.dto';
import { UpdateSeoMetaDto } from 'src/seo/dto/update-seo-meta.dto';

@Injectable()
export class FaqService {
  constructor(
    @InjectModel(Faq.name)
    private faqModel: Model<FaqDocument>,
  ) {}

  // ─────────────────────────────────────────
  // PUBLIC - Get Active FAQs
  // ─────────────────────────────────────────

  async findAllActive(category?: string) {
    const filter: any = { isActive: true };
    if (category) filter.category = category.toLowerCase();

    const faqs = await this.faqModel
      .find(filter)
      .sort({ order: 1, createdAt: -1 })
      .exec();

    return {
      success: true,
      count: faqs.length,
      data: faqs,
    };
  }

  // ─────────────────────────────────────────
  // ADMIN - Get All FAQs
  // ─────────────────────────────────────────

  async findAll() {
    const faqs = await this.faqModel.find().sort({ createdAt: -1 }).exec();

    const active = faqs.filter((f) => f.isActive).length;
    const inactive = faqs.length - active;

    return {
      success: true,
      count: faqs.length,
      stats: { active, inactive },
      data: faqs,
    };
  }

  // ─────────────────────────────────────────
  // ADMIN - Get Categories
  // ─────────────────────────────────────────

  async getCategories() {
    const categories = await this.faqModel.distinct('category').exec();

    return {
      success: true,
      count: categories.length,
      data: categories.sort(),
    };
  }

  // ─────────────────────────────────────────
  // ADMIN - Create FAQ
  // ─────────────────────────────────────────

  async create(dto: CreateFaqDto) {
    const faq = await this.faqModel.create({
      ...dto,
      category: dto.category?.toLowerCase() || 'general',
    });

    console.log('✅ FAQ created:', faq.question);

    return {
      success: true,
      message: 'FAQ created successfully',
      data: faq,
    };
  }

  // ─────────────────────────────────────────
  // ADMIN - Update FAQ
  // ─────────────────────────────────────────

  async update(id: string, dto: UpdateFaqDto) {
    const updateData = { ...dto };
    if (dto.category) {
      updateData.category = dto.category.toLowerCase();
    }

    const faq = await this.faqModel
      .findByIdAndUpdate(id, updateData, { returnDocument: 'after' })
      .exec();

    if (!faq) {
      throw new NotFoundException('FAQ not found');
    }

    console.log('✅ FAQ updated:', id);

    return {
      success: true,
      message: 'FAQ updated successfully',
      data: faq,
    };
  }

  // ─────────────────────────────────────────
  // ADMIN - Toggle Active Status
  // ─────────────────────────────────────────

  async toggleActive(id: string) {
    const faq = await this.faqModel.findById(id).exec();

    if (!faq) {
      throw new NotFoundException('FAQ not found');
    }

    faq.isActive = !faq.isActive;
    await faq.save();

    console.log(`✅ FAQ ${faq.isActive ? 'activated' : 'deactivated'}:`, id);

    return {
      success: true,
      message: `FAQ ${faq.isActive ? 'activated' : 'deactivated'} successfully`,
      data: faq,
    };
  }

  // ─────────────────────────────────────────
  // ADMIN - Delete FAQ
  // ─────────────────────────────────────────

  async remove(id: string) {
    const faq = await this.faqModel.findByIdAndDelete(id).exec();

    if (!faq) {
      throw new NotFoundException('FAQ not found');
    }

    console.log('✅ FAQ deleted:', id);

    return {
      success: true,
      message: 'FAQ deleted successfully',
    };
  }

  // ─────────────────────────────────────────
  // PUBLIC - Search FAQs
  // ─────────────────────────────────────────

  async search(query: string) {
    // No search text -> no results (a missing $search value made MongoDB throw a 500).
    if (typeof query !== 'string' || !query.trim()) return { success: true, count: 0, query: '', data: [] };
    const faqs = await this.faqModel
      .find({
        isActive: true,
        $text: { $search: query },
      })
      .sort({ score: { $meta: 'textScore' } })
      .exec();

    return {
      success: true,
      count: faqs.length,
      query,
      data: faqs,
    };
  }

  // ─────────────────────────────────────────
  // ADMIN SEO — Help Center meta override
  // ─────────────────────────────────────────

  async getSeo(id: string) {
    const faq = await this.faqModel.findById(id).exec();
    if (!faq) throw new NotFoundException('FAQ not found');
    return faq.seo ?? {};
  }

  async updateSeo(id: string, dto: UpdateSeoMetaDto) {
    const faq = await this.faqModel.findById(id).exec();
    if (!faq) throw new NotFoundException('FAQ not found');

    faq.seo = { ...(faq.seo as any), ...dto, updatedAt: new Date() };
    await faq.save();

    return { success: true, data: faq.seo };
  }
}
