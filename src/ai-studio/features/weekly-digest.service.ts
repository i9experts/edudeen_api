/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from 'src/common/store-ownership.util';
import { NotificationsService } from '../../notifications/notifications.service';
import { AiService } from '../core/ai.service';
import { InsightsService } from './insights.service';
import { AiStudioSetting, AiStudioSettingDocument } from '../schemas/ai-studio-setting.schema';

/** Pure: ISO-8601 week key such as "2026-W41" (weeks start on Monday). */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export interface DigestRunResult { considered: number; generated: number; skippedCredits: number; skippedOff: number; failed: number }

/**
 * Opt-in weekly digest. A store is only ever processed after its seller switched it on (default OFF). Credits are only debited
 * through the normal wallet hold (AiService.withCredits): when the store cannot pay, the run is skipped and the seller is told once.
 * The admin kill switch (`weekly_insights`, global or per store) and "AI not configured" both stop the run with no debit.
 */
@Injectable()
export class WeeklyDigestService {
  private readonly logger = new Logger(WeeklyDigestService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ai: AiService,
    private readonly insights: InsightsService,
    private readonly notifications: NotificationsService,
    @InjectModel(AiStudioSetting.name) private readonly settings: Model<AiStudioSettingDocument>,
  ) {}

  async getSettings(sellerId: string, storeId: string) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
    const s: any = await this.settings.findOne({ storeId }).lean();
    return {
      success: true,
      data: {
        weeklyDigestEnabled: !!s?.weeklyDigestEnabled,
        lastRunAt: s?.weeklyDigestLastRunAt ?? null,
        creditsPerDigest: this.ai['credits']?.costOf('weekly_insights') ?? 0,
        aiAvailable: this.ai.isAvailable(),
      },
    };
  }

  async setWeeklyDigest(sellerId: string, storeId: string, enabled: boolean) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
    await this.settings.updateOne(
      { storeId },
      { $set: { sellerId, weeklyDigestEnabled: enabled, ...(enabled ? { weeklyDigestEnabledAt: new Date(), weeklyDigestSkipNotified: false, weeklyDigestNextTryAt: null } : {}) } },
      { upsert: true },
    );
    return { success: true, message: enabled ? 'Weekly digest turned on. It runs once a week and uses AI credits.' : 'Weekly digest turned off.', data: { weeklyDigestEnabled: enabled } };
  }

  /** One scheduler pass over opted-in stores that have not had a digest this ISO week. Bounded by `max` per pass. */
  async runDue(now = new Date(), max = 100): Promise<DigestRunResult> {
    const out: DigestRunResult = { considered: 0, generated: 0, skippedCredits: 0, skippedOff: 0, failed: 0 };
    if (!this.ai.isAvailable()) return out; // no key: nothing runs, nothing is debited
    const week = isoWeekKey(now);
    const due: any[] = await this.settings.find({
      weeklyDigestEnabled: true,
      weeklyDigestLastWeek: { $ne: week },
      $or: [{ weeklyDigestNextTryAt: null }, { weeklyDigestNextTryAt: { $lte: now } }],
    }).limit(max).lean();
    for (const s of due) {
      out.considered++;
      try {
        const store: any = await this.db.repositories.storeModel.findOne({ _id: s.storeId, isDelete: false }).select('name status sellerId').lean();
        if (!store || store.sellerId !== s.sellerId || !['active', 'pending'].includes(store.status)) { out.skippedOff++; continue; }
        if (!(await this.ai.isFeatureOn('weekly_insights', s.storeId))) { out.skippedOff++; continue; }
        await this.insights.generate(s.sellerId, s.storeId);
        out.generated++;
        await this.settings.updateOne({ storeId: s.storeId }, { $set: { weeklyDigestLastWeek: week, weeklyDigestLastRunAt: now, weeklyDigestSkipNotified: false, weeklyDigestNextTryAt: null } });
        await this.notifications.notify({
          recipientId: s.sellerId, recipientRole: 'seller', type: 'ai_weekly_digest',
          title: 'Your weekly insights are ready', body: `A new AI digest for ${store.name ?? 'your store'} is on your dashboard.`,
          data: { storeId: s.storeId, link: `/store/${s.storeId}/dashboard` },
        }).catch(() => undefined);
      } catch (err: any) {
        const code = err?.response?.errorCode ?? err?.getResponse?.()?.errorCode;
        if (code === 'INSUFFICIENT_AI_CREDITS') {
          out.skippedCredits++;
          const retry = new Date(now.getTime() + 6 * 3600_000);
          await this.settings.updateOne({ storeId: s.storeId }, { $set: { weeklyDigestNextTryAt: retry } });
          if (!s.weeklyDigestSkipNotified) {
            await this.settings.updateOne({ storeId: s.storeId }, { $set: { weeklyDigestSkipNotified: true } });
            await this.notifications.notify({
              recipientId: s.sellerId, recipientRole: 'seller', type: 'ai_weekly_digest_skipped',
              title: 'Weekly insights skipped', body: 'Your store does not have enough AI credits for this week\'s digest. It will run when you have credits, or you can turn it off in AI Studio.',
              data: { storeId: s.storeId, link: `/store/${s.storeId}/ai/studio` },
            }).catch(() => undefined);
          }
        } else if (code === 'AI_FEATURE_DISABLED') {
          out.skippedOff++;
        } else {
          out.failed++;
          this.logger.warn(`weekly digest failed for store ${s.storeId}: ${err?.message ?? err}`);
          await this.settings.updateOne({ storeId: s.storeId }, { $set: { weeklyDigestNextTryAt: new Date(now.getTime() + 6 * 3600_000) } }).catch(() => undefined);
        }
      }
    }
    return out;
  }
}
