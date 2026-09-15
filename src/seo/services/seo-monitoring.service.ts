/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from 'src/database/databaseservice';
import { SeoIntegrationsService } from './seo-integrations.service';

const FLUSH_INTERVAL_MS = 10_000;
const MAX_BUFFER_SIZE = 5_000; // oldest-drop safety valve under extreme load

interface CrawlHit {
  userAgent: string;
  path: string;
  statusCode: number;
  storeId: string | null;
  ip: string | null;
  botName: string | null;
  createdAt: Date;
}

const KNOWN_BOTS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'Googlebot', pattern: /googlebot/i },
  { name: 'Bingbot', pattern: /bingbot/i },
  { name: 'facebookexternalhit', pattern: /facebookexternalhit/i },
  { name: 'Twitterbot', pattern: /twitterbot/i },
  { name: 'LinkedInBot', pattern: /linkedinbot/i },
  { name: 'Slackbot', pattern: /slackbot/i },
  { name: 'AhrefsBot', pattern: /ahrefsbot/i },
  { name: 'SemrushBot', pattern: /semrushbot/i },
];

export function detectBotName(userAgent: string): string | null {
  return KNOWN_BOTS.find((b) => b.pattern.test(userAgent))?.name ?? null;
}

/**
 * Crawl-hit logging (see architecture plan Refinement #5): buffered
 * in-memory, flushed via `insertMany` every ~10s rather than one write per
 * bot request — external crawler traffic is not something we control the
 * rate of, so it must never become a synchronous DB write on the request
 * hot path. Also owns Index/Core-Web-Vitals snapshot read + refresh.
 */
@Injectable()
export class SeoMonitoringService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SeoMonitoringService.name);
  private buffer: CrawlHit[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly integrations: SeoIntegrationsService,
  ) {}

  onModuleInit() {
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  async onModuleDestroy() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush(); // don't drop the last partial buffer on shutdown
  }

  /** Called from the crawl-tracking middleware — must never throw or block the response. */
  recordHitIfBot(userAgent: string | undefined, path: string, statusCode: number, storeId: string | null, ip: string | null): void {
    if (!userAgent) return;
    const botName = detectBotName(userAgent);
    if (!botName) return; // only bot traffic is worth logging here — real users go through normal analytics

    if (this.buffer.length >= MAX_BUFFER_SIZE) this.buffer.shift(); // oldest-drop rather than unbounded growth
    this.buffer.push({ userAgent, path, statusCode, storeId, ip, botName, createdAt: new Date() });
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.db.repositories.seoCrawlLogModel.insertMany(batch, { ordered: false });
    } catch (err: any) {
      this.logger.warn(`Crawl-log flush failed for ${batch.length} entries: ${err?.message}`);
    }
  }

  async getCrawlLogs(storeId: string | null, query: { page?: number; limit?: number; botName?: string }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const filter: Record<string, any> = storeId ? { storeId } : {};
    if (query.botName) filter.botName = query.botName;

    const [items, total] = await Promise.all([
      this.db.repositories.seoCrawlLogModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.db.repositories.seoCrawlLogModel.countDocuments(filter),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async getCrawlStats(storeId: string | null) {
    const filter: Record<string, any> = storeId ? { storeId } : {};
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [byBot, errorCount] = await Promise.all([
      this.db.repositories.seoCrawlLogModel.aggregate([
        { $match: { ...filter, createdAt: { $gte: since } } },
        { $group: { _id: '$botName', hits: { $sum: 1 } } },
        { $sort: { hits: -1 } },
      ]),
      this.db.repositories.seoCrawlLogModel.countDocuments({ ...filter, createdAt: { $gte: since }, statusCode: { $gte: 400 } }),
    ]);
    return { last30Days: { byBot, errorHits: errorCount } };
  }

  // ── Index coverage snapshots ──────────────────────────────────────────────

  async getIndexSnapshots(scope: 'platform' | 'store', storeId: string | null, limit = 30) {
    return this.db.repositories.seoIndexSnapshotModel
      .find({ scope, storeId })
      .sort({ snapshotDate: -1 })
      .limit(limit)
      .lean();
  }

  /** Pulls fresh coverage data from every connected GSC/Bing integration for this scope and stores a dated snapshot. */
  async refreshIndexSnapshots(scope: 'platform' | 'store', storeId: string | null): Promise<{ synced: number; failed: number }> {
    const to = new Date();
    const from = new Date(to.getTime() - 28 * 24 * 60 * 60 * 1000);
    let synced = 0;
    let failed = 0;

    for (const provider of ['gsc', 'bing'] as const) {
      try {
        const { coverage } = await this.integrations.sync({ scope, storeId }, provider, from, to);
        await this.db.repositories.seoIndexSnapshotModel.create({
          scope, storeId, provider,
          indexedCount: coverage.indexedCount,
          excludedCount: coverage.excludedCount,
          errors: coverage.errors,
          snapshotDate: to,
        });
        synced++;
      } catch {
        failed++; // most commonly: integration not connected for this scope — not an operational error worth crashing over
      }
    }
    return { synced, failed };
  }

  // ── Cron entry points — sync every connected integration, not just one scope ─

  /** Called by the nightly `syncSearchConsoleData` cron — pulls coverage+performance for every connected GSC/Bing integration across every scope. */
  async syncAllSearchConsoleData(): Promise<{ synced: number; failed: number }> {
    return this.syncAllForProviders(['gsc', 'bing']);
  }

  /** Called by the nightly `syncGoogleAnalyticsData` cron. */
  async syncAllGoogleAnalyticsData(): Promise<{ synced: number; failed: number }> {
    return this.syncAllForProviders(['ga4']);
  }

  private async syncAllForProviders(providers: Array<'gsc' | 'bing' | 'ga4'>): Promise<{ synced: number; failed: number }> {
    const to = new Date();
    const from = new Date(to.getTime() - 28 * 24 * 60 * 60 * 1000);
    const integrations = await this.db.repositories.seoIntegrationModel
      .find({ provider: { $in: providers }, status: { $ne: 'disconnected' } })
      .lean();

    let synced = 0;
    let failed = 0;
    for (const integration of integrations as any[]) {
      try {
        const { coverage, performance } = await this.integrations.sync(
          { scope: integration.scope, storeId: integration.storeId },
          integration.provider,
          from,
          to,
        );

        if (integration.provider !== 'ga4') {
          await this.db.repositories.seoIndexSnapshotModel.create({
            scope: integration.scope, storeId: integration.storeId, provider: integration.provider,
            indexedCount: coverage.indexedCount, excludedCount: coverage.excludedCount, errors: coverage.errors,
            snapshotDate: to,
          });
        }

        for (const row of performance) {
          await this.db.repositories.seoAnalyticsSnapshotModel.findOneAndUpdate(
            { scope: integration.scope, storeId: integration.storeId, provider: integration.provider, date: row.date },
            { $set: { clicks: row.clicks ?? null, impressions: row.impressions ?? null, ctr: row.ctr ?? null, avgPosition: row.avgPosition ?? null, organicSessions: row.organicSessions ?? null } },
            { upsert: true },
          );
        }
        synced++;
      } catch (err: any) {
        this.logger.warn(`SEO integration sync failed for ${integration.provider}/${integration.storeId ?? 'platform'}: ${err?.message}`);
        failed++;
      }
    }
    return { synced, failed };
  }

  /** Top-trafficked product/store URLs for the weekly CWV cron — PSI has real per-call latency and rate limits, so this is deliberately capped rather than scanning the whole catalog. */
  async getTopUrlsForCwv(limit = 40): Promise<string[]> {
    const [topProducts, topStores] = await Promise.all([
      this.db.repositories.productModel.find({ status: 'active', isDelete: false }).sort({ purchaseCount: -1 }).limit(limit * 0.7).select('slug').lean(),
      this.db.repositories.storeModel.find({ status: 'active', isDelete: false }).sort({ followersCount: -1 }).limit(limit * 0.3).select('slug').lean(),
    ]);
    return [
      ...(topProducts as any[]).map((p) => `https://edudeen.com/product/${p.slug}`),
      ...(topStores as any[]).map((s) => `https://edudeen.com/${s.slug}`),
    ];
  }

  // ── Core Web Vitals ────────────────────────────────────────────────────────

  async getCoreWebVitals(storeId: string | null, limit = 50) {
    return this.db.repositories.seoCoreWebVitalsSnapshotModel
      .find(storeId ? { storeId } : {})
      .sort({ measuredAt: -1 })
      .limit(limit)
      .lean();
  }

  /** Pulls field data (CrUX) via the public PageSpeed Insights API for a fixed set of URLs. */
  async refreshCoreWebVitals(urls: string[], storeId: string | null): Promise<{ measured: number; failed: number }> {
    const apiKey = this.config.get<string>('PAGESPEED_INSIGHTS_API_KEY');
    let measured = 0;
    let failed = 0;

    for (const url of urls) {
      try {
        const params = new URLSearchParams({ url, strategy: 'mobile', ...(apiKey ? { key: apiKey } : {}) });
        const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params.toString()}`);
        if (!res.ok) { failed++; continue; }
        const data = await res.json();
        const crux = data.loadingExperience?.metrics ?? {};

        await this.db.repositories.seoCoreWebVitalsSnapshotModel.create({
          url, storeId, source: 'crux',
          lcp: crux.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
          inp: crux.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
          cls: crux.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null ? crux.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
        });
        measured++;
      } catch {
        failed++;
      }
    }
    return { measured, failed };
  }
}
