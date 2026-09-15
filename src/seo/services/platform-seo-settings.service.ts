/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { UpdatePlatformSeoSettingsDto } from '../dto/update-platform-seo-settings.dto';
import { UpsertSeoRuleDto } from '../dto/seo-rule.dto';

const SINGLETON_KEY = 'global';

const DEFAULT_ORGANIZATION_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Edudeen',
  url: 'https://edudeen.com',
};

const DEFAULT_WEBSITE_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Edudeen',
  url: 'https://edudeen.com',
};

/**
 * Owns the single `PlatformSeoSettings` row — global meta templates, robots
 * body, structured-data config, AI SEO kill switch, and audit-rule
 * thresholds. Singleton-ness is enforced here (never in the controller):
 * every read/write goes through `getOrCreate`, which upserts on first use so
 * there's never a "settings don't exist yet" branch anywhere else in the app.
 */
@Injectable()
export class PlatformSeoService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
  ) {}

  private get model() {
    return this.db.repositories.platformSeoSettingsModel;
  }

  async getOrCreate() {
    const existing = await this.model.findOne({ key: SINGLETON_KEY });
    if (existing) return existing;

    return this.model.create({
      key: SINGLETON_KEY,
      organizationSchema: DEFAULT_ORGANIZATION_SCHEMA,
      websiteSchema: DEFAULT_WEBSITE_SCHEMA,
    });
  }

  async getSettings() {
    return (await this.getOrCreate()).toObject();
  }

  async updateSettings(dto: UpdatePlatformSeoSettingsDto, actor: { id: string; name?: string; role?: string }) {
    const settings = await this.getOrCreate();
    Object.assign(settings, dto, { updatedByAdminId: actor.id });
    await settings.save();

    await this.activityLog.log({
      category: 'seo',
      action: 'platform_seo_settings_updated',
      description: 'Global platform SEO settings updated',
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetType: 'platform_seo_settings',
      metadata: { changedFields: Object.keys(dto) },
    });

    return settings.toObject();
  }

  // ── SEO Rules — config thresholds for SeoAuditService's fixed, code-defined
  // checks (see architecture plan Refinement #3: NOT a generic rule engine).
  async listRules() {
    return (await this.getOrCreate()).rules ?? [];
  }

  async upsertRule(dto: UpsertSeoRuleDto, actor: { id: string; name?: string; role?: string }) {
    const settings = await this.getOrCreate();
    const existingIndex = settings.rules.findIndex((r: any) => r.code === dto.code);
    const rule = {
      code: dto.code,
      enabled: dto.enabled ?? true,
      thresholds: dto.thresholds ?? {},
      severity: dto.severity ?? 'warning',
    };
    if (existingIndex >= 0) settings.rules[existingIndex] = rule as any;
    else settings.rules.push(rule as any);
    settings.updatedByAdminId = actor.id;
    await settings.save();

    await this.activityLog.log({
      category: 'seo',
      action: existingIndex >= 0 ? 'seo_rule_updated' : 'seo_rule_created',
      description: `SEO rule "${dto.code}" ${existingIndex >= 0 ? 'updated' : 'created'}`,
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetId: dto.code,
      targetType: 'seo_rule',
    });

    return rule;
  }

  async deleteRule(code: string, actor: { id: string; name?: string; role?: string }) {
    const settings = await this.getOrCreate();
    const before = settings.rules.length;
    settings.rules = settings.rules.filter((r: any) => r.code !== code) as any;
    if (settings.rules.length === before) throw new NotFoundException(`No SEO rule with code "${code}".`);
    await settings.save();

    await this.activityLog.log({
      category: 'seo',
      action: 'seo_rule_deleted',
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetId: code,
      targetType: 'seo_rule',
    });

    return { success: true };
  }

  /** Resolved robots.txt including sitemap directives — sitemap URLs stay in sync automatically since they're appended here, not stored in the settings body itself. */
  async getResolvedRobotsTxt(): Promise<string> {
    const settings = await this.getOrCreate();
    return `${settings.robotsTxtBody}\nSitemap: https://edudeen.com/sitemap.xml\n`;
  }
}
