/* eslint-disable prettier/prettier */
import { JwtService } from '@nestjs/jwt';
import { blockingScope, maintenanceState, normalizeMaintenance, type MaintenanceSettings } from './maintenance.util';
import { UpdateMaintenanceDto } from './dto/update-maintenance.dto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { UpdateFeatureFlagsDto } from './dto/update-feature-flags.dto';
import { UpdateAiConfigDto } from './dto/update-ai-config.dto';
import { UpdateEmailConfigDto } from './dto/update-email-config.dto';
import { UpdatePlacementLimitsDto } from './dto/update-placement-limits.dto';
import { UpdatePromotionPricingDto } from './dto/update-promotion-pricing.dto';
import { PlacementLimitKey } from '../common/promotion-placements.const';
import { UpdatePayoutConfigDto } from './dto/update-payout-config.dto';
import { UpdateManualPaymentConfigDto } from './dto/update-manual-payment-config.dto';
import { UpdateFxConfigDto } from './dto/update-fx-config.dto';
import { UpdateSocialLinksDto } from './dto/update-social-links.dto';
import { SOCIAL_LINK_KEYS } from './schemas/platform-config.schema';

export type FeatureFlagKey =
  | 'aiStudio' | 'marketplace' | 'digitalUploads' | 'affiliateProgram'
  | 'giftCards' | 'posMode' | 'storeBuilder' | 'bulkProductImport' | 'promotions'
  | 'storefrontBlog';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

// Singleton settings document — always the same (only) row in the collection,
// fetched/created lazily via upsert so there's no separate "seed" step.
@Injectable()
export class AdminConfigService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get model() {
    return this.databaseService.repositories.platformConfigModel;
  }

  // FeatureFlagGuard and the maintenance-mode middleware both call this on
  // (almost) every request — a short in-memory cache avoids a DB round trip
  // per request while still picking up an admin's change within a few
  // seconds. Invalidated eagerly on every write below anyway.
  private cached: { config: any; expiresAt: number } | null = null;
  private readonly CACHE_TTL_MS = 5000;

  private async getRawConfig() {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.config;
    const config = await this.model.findOneAndUpdate({}, {}, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
    this.cached = { config, expiresAt: Date.now() + this.CACHE_TTL_MS };
    return config;
  }

  private invalidateCache() {
    this.cached = null;
  }

  async getConfig() {
    const config = await this.getRawConfig();
    return { success: true, data: config };
  }

  /** Used by FeatureFlagGuard — true unless an admin has explicitly turned this flag off. */
  async isFeatureEnabled(flag: FeatureFlagKey): Promise<boolean> {
    const config = await this.getRawConfig();
    return config.featureFlags?.[flag] !== false;
  }

  /** True while maintenance is actually blocking something (armed and past its start time). */
  async isMaintenanceMode(): Promise<boolean> {
    return maintenanceState(await this.getMaintenance()) === 'active';
  }

  async getMaintenance(): Promise<MaintenanceSettings> {
    const config = await this.getRawConfig();
    return normalizeMaintenance(config.maintenance, config.maintenanceMode);
  }

  /** Public, safe-to-show view for the maintenance page and the site-wide notice banner. */
  async getPublicMaintenance() {
    const m = await this.getMaintenance();
    const state = maintenanceState(m);
    return { success: true, data: { state, ...(state === 'off' ? {} : { scopes: m.scopes, type: m.type, title: m.title, message: m.message, startsAt: m.startsAt, endsAt: m.endsAt, statusNote: m.statusNote, updatedAt: m.updatedAt }) } };
  }

  private verifier = new JwtService({ secret: process.env.JWT_SECRET });

  /** The 503 body for a request that maintenance blocks, or null. Admins (valid admin token) browse normally. */
  async maintenanceBlockFor(method: string, path: string, authorization?: string) {
    const m = await this.getMaintenance();
    const scope = blockingScope(m, method, path);
    if (!scope) return null;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (token) {
      try { if ((this.verifier.verify(token) as any)?.role === 'admin') return null; } catch { /* not a valid token — treated as a visitor */ }
    }
    return { statusCode: 503, maintenanceMode: true, scope, scopes: m.scopes, type: m.type, title: m.title, message: m.message, endsAt: m.endsAt, statusNote: m.statusNote };
  }

  /** How many banners may be simultaneously visible for a given placement — read-side cap only, never a create-time limit. */
  async getPlacementLimit(key: PlacementLimitKey): Promise<number> {
    const config = await this.getRawConfig();
    return config.placementLimits?.[key] ?? 4;
  }

  /** The admin-configured rate card for a placement (hourly/daily/weekly/monthly + multipliers + festival overrides), or {} if unset. */
  async getPromotionPricing(placement: string): Promise<Record<string, any>> {
    const config = await this.getRawConfig();
    return config.promotionPricing?.[placement] ?? {};
  }

  /** Used by FinanceService to gate on-demand withdrawals and the scheduled auto-payout batch per currency. */
  async getPayoutMinimum(currency: string): Promise<number> {
    const config = await this.getRawConfig();
    return currency === 'PKR' ? config.payoutConfig?.minPayoutPKR ?? 1500 : config.payoutConfig?.minPayoutUSD ?? 5;
  }

  /** Platform payout policy — the frequency new seller payout schedules start on ('monthly' unless an admin changed it). */
  async getPayoutFrequency(): Promise<string> {
    const config = await this.getRawConfig();
    return config.payoutConfig?.payoutFrequency ?? 'monthly';
  }

  /** Used by checkout (to decide whether to offer the option) and by the manual-payments module (bank details + FX rate shown to the buyer). */
  async getManualPaymentConfig() {
    const config = await this.getRawConfig();
    return config.manualPaymentConfig;
  }

  async isManualPaymentEnabled(): Promise<boolean> {
    const config = await this.getRawConfig();
    return config.manualPaymentConfig?.enabled === true;
  }

  /** Used by ExchangeRateService's cron refresh + sanity/abnormal-jump checks. */
  async getFxConfig() {
    const config = await this.getRawConfig();
    return config.fxConfig;
  }

  private async logChange(action: string, description: string, meta: AuditMeta) {
    this.activityLogService.log({
      storeId: 'platform',
      category: 'settings',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async updateFeatureFlags(dto: UpdateFeatureFlagsDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`featureFlags.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('feature_flags_updated', `Feature flags updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'Feature flags updated', data: config };
  }

  async updateAiConfig(dto: UpdateAiConfigDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    if (dto.monthlyCreditLimit !== undefined) set['aiConfig.monthlyCreditLimit'] = dto.monthlyCreditLimit;
    if (dto.aiModel !== undefined) set['aiConfig.aiModel'] = dto.aiModel;
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('ai_config_updated', `AI config updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'AI config updated', data: config };
  }

  async updateEmailConfig(dto: UpdateEmailConfigDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`emailConfig.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('email_config_updated', `Email config updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'Email config updated', data: config };
  }

  async updatePlacementLimits(dto: UpdatePlacementLimitsDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`placementLimits.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('placement_limits_updated', `Placement visible-count limits updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'Placement limits updated', data: config };
  }

  async updatePromotionPricing(dto: UpdatePromotionPricingDto, meta: AuditMeta) {
    for (const [placement, card] of Object.entries(dto) as Array<[string, { festivalOverrides?: Array<{ name: string; startAt: string; endAt: string }> } | undefined]>) {
      for (const f of card?.festivalOverrides ?? []) {
        if (new Date(f.endAt) <= new Date(f.startAt)) {
          throw new BadRequestException(`Festival "${f.name}" on ${placement}: endAt must be after startAt`);
        }
      }
    }
    const set: Record<string, unknown> = {};
    for (const [placement, rateCard] of Object.entries(dto)) {
      if (rateCard !== undefined) set[`promotionPricing.${placement}`] = rateCard;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('promotion_pricing_updated', `Promotion pricing updated for: ${Object.keys(dto).join(', ')}`, meta);
    return { success: true, message: 'Promotion pricing updated', data: config };
  }

  async updatePayoutConfig(dto: UpdatePayoutConfigDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`payoutConfig.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('payout_config_updated', `Payout config updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'Payout config updated', data: config };
  }

  async updateManualPaymentConfig(dto: UpdateManualPaymentConfigDto, meta: AuditMeta) {
    // The buyer is charged this rate on manual (PKR) orders. A typo (27.8 / 27800) silently under- or over-charges
    // every order, so it must sit inside the FX sanity band the admin already maintains.
    if (dto.usdToPkrRate !== undefined) {
      const fx = (await this.getFxConfig()) as { sanityBandMinPKR?: number; sanityBandMaxPKR?: number } | undefined;
      const min = fx?.sanityBandMinPKR;
      const max = fx?.sanityBandMaxPKR;
      if ((typeof min === 'number' && dto.usdToPkrRate < min) || (typeof max === 'number' && dto.usdToPkrRate > max)) {
        throw new BadRequestException(`usdToPkrRate must be between ${min ?? '-'} and ${max ?? '-'} (the FX sanity band). Update the FX config first if the market has really moved.`);
      }
    }
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`manualPaymentConfig.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
    this.invalidateCache();
    // Bank account numbers/IBAN intentionally omitted from the audit description — full values are in `dto`/DB, not duplicated into the activity log.
    await this.logChange('manual_payment_config_updated', `Manual payment config updated (enabled=${config.manualPaymentConfig?.enabled}, rate=${config.manualPaymentConfig?.usdToPkrRate})`, meta);
    return { success: true, message: 'Manual payment config updated', data: config };
  }

  async updateFxConfig(dto: UpdateFxConfigDto, meta: AuditMeta) {
    // Validate the band as it will be AFTER this partial update, not just the fields sent.
    if (dto.sanityBandMinPKR !== undefined || dto.sanityBandMaxPKR !== undefined) {
      const current = (await this.getFxConfig()) as { sanityBandMinPKR?: number; sanityBandMaxPKR?: number } | undefined;
      const min = dto.sanityBandMinPKR ?? current?.sanityBandMinPKR;
      const max = dto.sanityBandMaxPKR ?? current?.sanityBandMaxPKR;
      if (typeof min === 'number' && typeof max === 'number' && min >= max) {
        throw new BadRequestException('sanityBandMinPKR must be lower than sanityBandMaxPKR');
      }
    }
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`fxConfig.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('fx_config_updated', `FX config updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'FX config updated', data: config };
  }

  async updateSocialLinks(dto: UpdateSocialLinksDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const key of SOCIAL_LINK_KEYS) {
      const value = dto[key];
      if (value === undefined) continue;
      const trimmed = typeof value === 'string' ? value.trim() : '';
      set[`socialLinks.${key}`] = trimmed ? trimmed : null;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('social_links_updated', `Social links updated: ${Object.keys(set).map(k => k.replace('socialLinks.', '')).join(', ') || 'none'}`, meta);
    return { success: true, message: 'Social links updated', data: config };
  }

  /**
   * Public, read-only slice of the platform config — ONLY fields that are safe
   * for anyone to see (no bank details, no email/AI/fx internals). Used by the
   * public site (footer social icons, seller marketing copy).
   */
  async getPublicConfig() {
    const config = await this.getRawConfig();
    const links = (config.socialLinks ?? {}) as Record<string, string | null | undefined>;
    const socialLinks: Record<string, string> = {};
    for (const key of SOCIAL_LINK_KEYS) {
      const v = links[key];
      if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) socialLinks[key] = v.trim();
    }
    return {
      success: true,
      data: {
        socialLinks,
        payout: {
          frequency: config.payoutConfig?.payoutFrequency ?? 'monthly',
        },
      },
    };
  }

  async setMaintenanceMode(dto: UpdateMaintenanceDto, meta: AuditMeta) {
    const prev = await this.getMaintenance();
    const startsAt = dto.startsAt === undefined ? prev.startsAt : dto.startsAt ? new Date(dto.startsAt) : null;
    const endsAt = dto.endsAt === undefined ? prev.endsAt : dto.endsAt ? new Date(dto.endsAt) : null;
    if (startsAt && endsAt && endsAt <= startsAt) throw new BadRequestException('The expected end time must be after the start time');
    const next: MaintenanceSettings = normalizeMaintenance({
      enabled: dto.maintenanceMode,
      scopes: dto.scopes ?? prev.scopes,
      type: dto.type ?? prev.type,
      title: dto.title ?? prev.title,
      message: dto.message ?? prev.message,
      startsAt, endsAt,
      statusNote: dto.statusNote ?? prev.statusNote,
      updatedAt: new Date(),
    });
    if (next.enabled && next.scopes.includes('all') && next.scopes.length > 1) next.scopes = ['all'];
    const config = await this.model.findOneAndUpdate(
      {},
      { $set: { maintenanceMode: next.enabled, maintenance: next } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    this.invalidateCache();
    const state = maintenanceState(next);
    await this.logChange('maintenance_mode_toggled', `Maintenance ${state === 'off' ? 'turned off' : state} — ${next.type}, affecting ${next.scopes.join(', ')}`, { ...meta });
    return { success: true, message: 'Maintenance mode updated', data: config };
  }
}