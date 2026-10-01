/* eslint-disable prettier/prettier */
import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { CreateCanonicalRuleDto } from '../dto/create-canonical-rule.dto';
import { UpdateCanonicalRuleDto } from '../dto/update-canonical-rule.dto';
import { assertSafeSeoDestination } from './seo-url-safety.util';

import { clampInt } from 'src/common/query-safety.util';
@Injectable()
export class SeoCanonicalService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
  ) {}

  private get model() {
    return this.db.repositories.seoCanonicalRuleModel;
  }

  async create(storeId: string | null, dto: CreateCanonicalRuleDto, actor: { id: string; name?: string; role?: string }) {
    assertSafeSeoDestination(dto.canonicalUrl);

    const existing = await this.model.findOne({ storeId, pathPattern: dto.pathPattern });
    if (existing) throw new ConflictException(`A canonical rule for "${dto.pathPattern}" already exists${storeId ? ' for this store' : ' at the platform level'}.`);

    const rule = await this.model.create({
      storeId,
      pathPattern: dto.pathPattern,
      canonicalUrl: dto.canonicalUrl,
      isActive: dto.isActive ?? true,
    });

    await this.activityLog.log({
      storeId: storeId ?? undefined,
      category: 'seo',
      action: 'seo_canonical_rule_created',
      description: `Canonical rule created: ${dto.pathPattern} → ${dto.canonicalUrl}`,
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetId: rule._id.toString(),
      targetType: 'seo_canonical_rule',
    });

    return rule;
  }

  async list(storeId: string | null, query: { page?: number; limit?: number }) {
    const page = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(100, Math.max(1, clampInt(query.limit, 20, 1, 100)));
    const filter = { storeId, isDelete: false };

    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);

    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async update(storeId: string | null, ruleId: string, dto: UpdateCanonicalRuleDto, actor: { id: string; name?: string; role?: string }) {
    const rule = await this.findOwned(storeId, ruleId);
    if (dto.canonicalUrl) assertSafeSeoDestination(dto.canonicalUrl);

    // Explicit fields only (see SeoRedirectsService.update).
    if (dto.pathPattern !== undefined) rule.pathPattern = dto.pathPattern;
    if (dto.canonicalUrl !== undefined) rule.canonicalUrl = dto.canonicalUrl;
    if (dto.isActive !== undefined) rule.isActive = dto.isActive;
    await rule.save();

    await this.activityLog.log({
      storeId: storeId ?? undefined,
      category: 'seo',
      action: 'seo_canonical_rule_updated',
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetId: ruleId,
      targetType: 'seo_canonical_rule',
    });

    return rule;
  }

  async delete(storeId: string | null, ruleId: string, actor: { id: string; name?: string; role?: string }) {
    const rule = await this.findOwned(storeId, ruleId);
    rule.isDelete = true;
    rule.isActive = false;
    await rule.save();

    await this.activityLog.log({
      storeId: storeId ?? undefined,
      category: 'seo',
      action: 'seo_canonical_rule_deleted',
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetId: ruleId,
      targetType: 'seo_canonical_rule',
    });

    return { success: true };
  }

  /** Used by SeoResolutionService when resolving a filter/pagination path with no product/category/store entity behind it directly. */
  async resolveForPath(storeId: string | null, path: string): Promise<string | null> {
    const rules = await this.model.find({ storeId, isActive: true, isDelete: false }).lean();
    const match = rules.find((r) => matchesPattern(path, (r as any).pathPattern));
    return match ? (match as any).canonicalUrl : null;
  }

  private async findOwned(storeId: string | null, ruleId: string) {
    const rule = await this.model.findOne({ _id: ruleId, storeId, isDelete: false });
    if (!rule) throw new NotFoundException('Canonical rule not found.');
    return rule;
  }
}

/** Minimal `:param`-style matcher — good enough for the small, admin/seller-curated rule lists this feature targets. */
function matchesPattern(path: string, pattern: string): boolean {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(':') || part === pathParts[i]);
}
