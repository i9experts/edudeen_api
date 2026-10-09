/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../redis/redis.service';
import { SemanticIndexService } from '../embeddings/semantic-index.service';
import { WeeklyDigestService } from '../features/weekly-digest.service';

/**
 * AI background jobs. Same pattern as scheduler/scheduler.service.ts: every job runs under a Redis distributed lock so a
 * horizontally scaled API runs it once; with Redis down the tick is skipped (and logged), never run unprotected.
 * Kept in the AI module so the shared scheduler file stays untouched.
 */
@Injectable()
export class AiCronService {
  private readonly logger = new Logger(AiCronService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly semantic: SemanticIndexService,
    private readonly digest: WeeklyDigestService,
  ) {}

  private async runLocked(name: string, ttlMs: number, fn: () => Promise<void>) {
    try {
      const r = await this.redis.withLock(`cron-lock:${name}`, ttlMs, fn);
      if (r === 'lock_not_acquired' && !this.redis.isConnected) this.logger.warn(`Skipped "${name}" - Redis is unavailable`);
    } catch (err) {
      this.logger.error(`Cron job "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Picks up products created/updated in the last 20 minutes (overlap on purpose; the text hash makes it idempotent). */
  @Cron('*/5 * * * *')
  async embedRecentProducts() {
    if (!this.semantic.isAvailable()) return;
    await this.runLocked('ai-embed-recent', 4 * 60_000, async () => {
      const r = await this.semantic.sync({ sinceMs: 20 * 60_000, maxEmbed: 200 });
      if (r.embedded) this.logger.log(`Embedded ${r.embedded} product(s) (${r.unchanged} unchanged)`);
    });
  }

  /** Nightly full pass: catches anything missed, finishes a backfill in chunks, and drops vectors of removed products. */
  @Cron('30 3 * * *')
  async embedBackfillNightly() {
    if (!this.semantic.isAvailable()) return;
    await this.runLocked('ai-embed-nightly', 30 * 60_000, async () => {
      const r = await this.semantic.sync({ maxEmbed: 1000 });
      const pruned = await this.semantic.prune();
      this.logger.log(`Embedding backfill: embedded ${r.embedded}, remaining ${r.remaining}, pruned ${pruned}`);
    });
  }

  /** Hourly: opted-in stores that have no digest yet this ISO week (so it runs Monday 00:15 and catches stragglers). */
  @Cron('15 * * * *')
  async weeklyDigests() {
    await this.runLocked('ai-weekly-digests', 30 * 60_000, async () => {
      const r = await this.digest.runDue();
      if (r.considered) this.logger.log(`Weekly digests: ${JSON.stringify(r)}`);
    });
  }
}
