/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { CreateRedirectDto } from '../dto/create-redirect.dto';
import { UpdateRedirectDto } from '../dto/update-redirect.dto';
import { assertSafeSeoDestination } from './seo-url-safety.util';

/**
 * Shared between the admin (`storeId: null`, platform-wide) and seller
 * (`storeId` set, gated by `customRedirectsAllowed`) redirect controllers —
 * one collection, one service, matching how `analytics/utils/*` is shared
 * between seller and admin analytics elsewhere in this codebase.
 */
@Injectable()
export class SeoRedirectsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
  ) {}

  private get model() {
    return this.db.repositories.seoRedirectModel;
  }

  async create(storeId: string | null, dto: CreateRedirectDto, actor: { id: string; name?: string; role?: string }) {
    assertSafeSeoDestination(dto.destination);
    const source = normalizeSource(dto.source);

    const existing = await this.model.findOne({ storeId, source });
    if (existing) throw new ConflictException(`A redirect for "${source}" already exists${storeId ? ' for this store' : ' at the platform level'}.`);

    const redirect = await this.model.create({
      storeId,
      source,
      destination: dto.destination,
      statusCode: dto.statusCode ?? 301,
      isActive: dto.isActive ?? true,
    });

    await this.activityLog.log({
      storeId: storeId ?? undefined,
      category: 'seo',
      action: 'seo_redirect_created',
      description: `Redirect created: ${source} → ${dto.destination}`,
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetId: redirect._id.toString(),
      targetType: 'seo_redirect',
    });

    return redirect;
  }

  async list(storeId: string | null, query: { page?: number; limit?: number; isActive?: boolean }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const filter: Record<string, any> = { storeId, isDelete: false };
    if (query.isActive !== undefined) filter.isActive = query.isActive;

    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);

    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async update(storeId: string | null, redirectId: string, dto: UpdateRedirectDto, actor: { id: string; name?: string; role?: string }) {
    const redirect = await this.findOwned(storeId, redirectId);
    if (dto.destination) assertSafeSeoDestination(dto.destination);
    // Explicit fields only. Object.assign(doc, dto) let a seller PATCH `{"storeId": null}` (a platform-wide redirect),
    // `{"isDelete": ...}` or another store's id — the global ValidationPipe does not strip unknown keys.
    if (dto.source) redirect.source = normalizeSource(dto.source);
    if (dto.destination !== undefined) redirect.destination = dto.destination;
    if (dto.statusCode !== undefined) redirect.statusCode = dto.statusCode;
    if (dto.isActive !== undefined) redirect.isActive = dto.isActive;
    if (redirect.source === redirect.destination) throw new BadRequestException('A redirect cannot point to itself.');
    try {
      await redirect.save();
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) throw new BadRequestException('A redirect for this source already exists.');
      throw err;
    }

    await this.activityLog.log({
      storeId: storeId ?? undefined,
      category: 'seo',
      action: 'seo_redirect_updated',
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetId: redirectId,
      targetType: 'seo_redirect',
    });

    return redirect;
  }

  async delete(storeId: string | null, redirectId: string, actor: { id: string; name?: string; role?: string }) {
    const redirect = await this.findOwned(storeId, redirectId);
    redirect.isDelete = true;
    redirect.isActive = false;
    await redirect.save();

    await this.activityLog.log({
      storeId: storeId ?? undefined,
      category: 'seo',
      action: 'seo_redirect_deleted',
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetId: redirectId,
      targetType: 'seo_redirect',
    });

    return { success: true };
  }

  /** Used by the (future) request-time redirect middleware/render layer — kept close to writes so both stay in sync. */
  async resolve(storeId: string | null, path: string) {
    const source = normalizeSource(path);
    const redirect = await this.model.findOne({ storeId, source, isActive: true, isDelete: false }).lean();
    if (redirect) {
      // Fire-and-forget hit counter — not awaited, must never slow down the actual redirect.
      this.model.updateOne({ _id: (redirect as any)._id }, { $inc: { hitCount: 1 }, $set: { lastHitAt: new Date() } }).catch(() => {});
    }
    return redirect;
  }

  private async findOwned(storeId: string | null, redirectId: string) {
    const redirect = await this.model.findOne({ _id: redirectId, storeId, isDelete: false });
    if (!redirect) throw new NotFoundException('Redirect not found.');
    return redirect;
  }
}

function normalizeSource(source: string): string {
  const trimmed = source.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
