/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { AI_FEATURE_KEYS, AiFeatureKey, isFeatureEnabled } from './ai-features';

export const AI_FEATURE_DISABLED = 'AI_FEATURE_DISABLED';

/** Reads the admin kill switches from PlatformConfig.aiConfig (short in-memory cache). */
@Injectable()
export class AiFlagsService {
  private cache: { at: number; flags: Record<string, any>; stores: Record<string, any> } | null = null;
  private static readonly TTL_MS = 8000;

  constructor(private readonly db: DatabaseService) {}

  invalidate() { this.cache = null; }

  private async load() {
    if (this.cache && Date.now() - this.cache.at < AiFlagsService.TTL_MS) return this.cache;
    let flags: Record<string, any> = {};
    let stores: Record<string, any> = {};
    try {
      const cfg: any = await this.db.repositories.platformConfigModel.findOne({}).select('aiConfig').lean();
      flags = cfg?.aiConfig?.featureFlags ?? {};
      stores = cfg?.aiConfig?.storeOverrides ?? {};
    } catch { /* config unreadable -> everything stays enabled */ }
    this.cache = { at: Date.now(), flags, stores };
    return this.cache;
  }

  async isEnabled(feature: AiFeatureKey, storeId?: string | null): Promise<boolean> {
    const c = await this.load();
    return isFeatureEnabled(feature, c.flags, c.stores, storeId);
  }

  async assertEnabled(feature: AiFeatureKey, storeId?: string | null): Promise<void> {
    if (!(await this.isEnabled(feature, storeId))) {
      throw new ForbiddenException({
        success: false, errorCode: AI_FEATURE_DISABLED,
        message: 'This AI feature is currently turned off by the Edudeen team.',
      });
    }
  }

  /** Enabled map for the web app (global flags + this store's overrides). */
  async enabledMap(storeId?: string | null): Promise<Record<AiFeatureKey, boolean>> {
    const c = await this.load();
    return Object.fromEntries(AI_FEATURE_KEYS.map((k) => [k, isFeatureEnabled(k, c.flags, c.stores, storeId)])) as Record<AiFeatureKey, boolean>;
  }

  async rawConfig() {
    const c = await this.load();
    return { featureFlags: c.flags, storeOverrides: c.stores };
  }
}
