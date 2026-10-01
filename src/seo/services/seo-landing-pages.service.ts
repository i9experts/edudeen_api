/* eslint-disable prettier/prettier */
import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { CreateLandingPageDto } from '../dto/create-landing-page.dto';
import { UpdateLandingPageDto } from '../dto/update-landing-page.dto';

import { clampInt } from 'src/common/query-safety.util';
@Injectable()
export class SeoLandingPagesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
  ) {}

  private get model() {
    return this.db.repositories.seoLandingPageModel;
  }

  async create(dto: CreateLandingPageDto, actor: { id: string; name?: string; role?: string }) {
    const existing = await this.model.findOne({ slug: dto.slug });
    if (existing) throw new ConflictException(`A landing page with slug "${dto.slug}" already exists.`);

    const page = await this.model.create({ ...dto, createdByAdminId: actor.id });

    await this.activityLog.log({
      category: 'seo',
      action: 'landing_page_created',
      description: `Landing page "${dto.title}" created`,
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: page._id.toString(), targetType: 'seo_landing_page',
    });

    return page;
  }

  async list(query: { page?: number; limit?: number; status?: string }) {
    const page = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(100, Math.max(1, clampInt(query.limit, 20, 1, 100)));
    const filter: Record<string, any> = { isDelete: false };
    if (query.status) filter.status = query.status;

    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async getById(id: string) {
    const page = await this.model.findOne({ _id: id, isDelete: false }).lean();
    if (!page) throw new NotFoundException('Landing page not found.');
    return page;
  }

  async update(id: string, dto: UpdateLandingPageDto, actor: { id: string; name?: string; role?: string }) {
    const page = await this.model.findOne({ _id: id, isDelete: false });
    if (!page) throw new NotFoundException('Landing page not found.');

    Object.assign(page, dto);
    await page.save();

    await this.activityLog.log({
      category: 'seo',
      action: 'landing_page_updated',
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: id, targetType: 'seo_landing_page',
    });

    return page;
  }

  async delete(id: string, actor: { id: string; name?: string; role?: string }) {
    const page = await this.model.findOne({ _id: id, isDelete: false });
    if (!page) throw new NotFoundException('Landing page not found.');

    page.isDelete = true;
    page.status = 'draft';
    await page.save();

    await this.activityLog.log({
      category: 'seo',
      action: 'landing_page_deleted',
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: id, targetType: 'seo_landing_page',
    });

    return { success: true };
  }
}
