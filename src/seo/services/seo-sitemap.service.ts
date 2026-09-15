/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from 'src/database/databaseservice';
import { QUEUE_NAMES, SEO_SITEMAP_REGENERATE_JOB } from 'src/queues/queue.constants';
import { SITEMAP_URL_LIMIT_PER_CHUNK, SitemapType } from '../schemas/seo-sitemap-cache.schema';

const PLATFORM_ORIGIN = 'https://edudeen.com';

/**
 * Chunked sitemap generation — see architecture plan Refinement #7. Each
 * `SeoSitemapCache` document holds one chunk of at most
 * `SITEMAP_URL_LIMIT_PER_CHUNK` URLs; `getSitemapIndex()` lists every chunk
 * across every type/store so `/sitemap.xml` can reference them all.
 * Regeneration always runs on the `seo-sitemap` queue (never inline in an
 * HTTP request) since a full-catalog rebuild can take real time.
 */
@Injectable()
export class SeoSitemapService {
  constructor(
    private readonly db: DatabaseService,
    @InjectQueue(QUEUE_NAMES.SEO_SITEMAP) private readonly sitemapQueue: Queue,
  ) {}

  /** Called by the admin/seller "regenerate" endpoint and by the daily cron — always queues, never runs inline. */
  async enqueueRegenerate(scope: { type?: SitemapType; storeId?: string } = {}): Promise<{ queued: true }> {
    await this.sitemapQueue.add(SEO_SITEMAP_REGENERATE_JOB, scope, {
      jobId: `regen-${scope.type ?? 'all'}-${scope.storeId ?? 'platform'}`,
    });
    return { queued: true };
  }

  async getStatus() {
    const chunks = await this.db.repositories.seoSitemapCacheModel
      .find({})
      .select('type storeId chunkIndex urlCount generatedAt')
      .lean();
    const totalUrls = chunks.reduce((sum, c: any) => sum + (c.urlCount ?? 0), 0);
    const lastGeneratedAt = chunks.reduce((latest: Date | null, c: any) => {
      if (!c.generatedAt) return latest;
      return !latest || c.generatedAt > latest ? c.generatedAt : latest;
    }, null as Date | null);
    return { chunkCount: chunks.length, totalUrls, lastGeneratedAt, chunks };
  }

  /** Invoked by SeoSitemapProcessor — does the real work off the request path. */
  async regenerate(scope: { type?: SitemapType; storeId?: string } = {}): Promise<void> {
    const types: SitemapType[] = scope.type ? [scope.type] : ['products', 'stores', 'categories', 'pages', 'storefront_content'];
    for (const type of types) {
      if (type === 'products') await this.regenerateProducts(scope.storeId);
      else if (type === 'stores') await this.regenerateStores();
      else if (type === 'categories') await this.regenerateCategories();
      else if (type === 'pages') await this.regeneratePages();
      else if (type === 'storefront_content') await this.regenerateStorefrontContent();
    }
  }

  private async regenerateProducts(storeId?: string) {
    const { productModel } = this.db.repositories;
    const filter: Record<string, any> = { status: 'active', isDelete: false };
    if (storeId) filter.storeId = storeId;

    const cursor = productModel.find(filter).select('slug updatedAt').lean().cursor();
    const urls: Array<{ loc: string; lastmod?: Date }> = [];
    for await (const doc of cursor as any) {
      urls.push({ loc: `${PLATFORM_ORIGIN}/product/${doc.slug}`, lastmod: doc.updatedAt });
    }
    await this.writeChunks('products', storeId ?? null, urls);
  }

  private async regenerateStores() {
    const { storeModel } = this.db.repositories;
    const stores = await storeModel.find({ status: 'active', isDelete: false }).select('slug updatedAt').lean();
    const urls = stores.map((s: any) => ({ loc: `${PLATFORM_ORIGIN}/${s.slug}`, lastmod: s.updatedAt }));
    await this.writeChunks('stores', null, urls);
  }

  private async regenerateCategories() {
    const { categoryModel } = this.db.repositories;
    // Pre-migration categories without a slug yet (backfilled lazily on next
    // read via CategoriesService.ensureSlug) are skipped here rather than
    // emitting a broken `/marketplace/undefined` sitemap entry.
    const categories = await categoryModel
      .find({ status: 'active', isDelete: false, slug: { $exists: true, $ne: null } })
      .select('slug updatedAt')
      .lean();
    const urls = categories.map((c: any) => ({ loc: `${PLATFORM_ORIGIN}/marketplace/${c.slug}`, lastmod: c.updatedAt }));
    await this.writeChunks('categories', null, urls);
  }

  private async regeneratePages() {
    const { seoLandingPageModel } = this.db.repositories;
    const pages = await seoLandingPageModel.find({ status: 'published', isDelete: false }).select('slug updatedAt').lean();
    const urls = pages.map((p: any) => ({ loc: `${PLATFORM_ORIGIN}/pages/${p.slug}`, lastmod: p.updatedAt }));
    await this.writeChunks('pages', null, urls);
  }

  /** Seller-authored storefront content — custom `StorePage`s and `BlogPost`s, scoped to `status:'active'` stores only (a suspended/rejected store's pages/posts shouldn't be indexed even if individually marked published). */
  private async regenerateStorefrontContent() {
    const { storeModel, storePageModel, blogPostModel } = this.db.repositories;
    const stores = await storeModel.find({ status: 'active', isDelete: false }).select('_id slug').lean();
    const slugById = new Map(stores.map((s: any) => [s._id.toString(), s.slug]));
    const storeIds = stores.map((s: any) => s._id.toString());
    if (storeIds.length === 0) { await this.writeChunks('storefront_content', null, []); return; }

    const [pages, posts] = await Promise.all([
      storePageModel.find({ storeId: { $in: storeIds }, type: 'custom', status: 'published', isDelete: false }).select('storeId slug updatedAt').lean(),
      blogPostModel.find({ storeId: { $in: storeIds }, status: 'published', isDelete: false }).select('storeId slug updatedAt').lean(),
    ]);

    const urls = [
      ...pages
        .filter((p: any) => slugById.has(p.storeId))
        .map((p: any) => ({ loc: `${PLATFORM_ORIGIN}/${slugById.get(p.storeId)}/${p.slug}`, lastmod: p.updatedAt })),
      ...posts
        .filter((p: any) => slugById.has(p.storeId))
        .map((p: any) => ({ loc: `${PLATFORM_ORIGIN}/${slugById.get(p.storeId)}/blog/${p.slug}`, lastmod: p.updatedAt })),
    ];
    await this.writeChunks('storefront_content', null, urls);
  }

  private async writeChunks(type: SitemapType, storeId: string | null, urls: Array<{ loc: string; lastmod?: Date }>) {
    const { seoSitemapCacheModel } = this.db.repositories;
    const chunkCount = Math.max(1, Math.ceil(urls.length / SITEMAP_URL_LIMIT_PER_CHUNK));

    for (let i = 0; i < chunkCount; i++) {
      const slice = urls.slice(i * SITEMAP_URL_LIMIT_PER_CHUNK, (i + 1) * SITEMAP_URL_LIMIT_PER_CHUNK);
      const xml = buildUrlsetXml(slice);
      await seoSitemapCacheModel.findOneAndUpdate(
        { type, storeId, chunkIndex: i },
        { $set: { xml, urlCount: slice.length, generatedAt: new Date() } },
        { upsert: true },
      );
    }
    // Drop any now-stale chunks beyond the new count (catalog shrank since last regen).
    await seoSitemapCacheModel.deleteMany({ type, storeId, chunkIndex: { $gte: chunkCount } });
  }

  async getChunkXml(type: SitemapType, storeId: string | null, chunkIndex: number): Promise<string | null> {
    const chunk = await this.db.repositories.seoSitemapCacheModel.findOne({ type, storeId, chunkIndex }).lean();
    return (chunk as any)?.xml ?? null;
  }

  async getSitemapIndexXml(): Promise<string> {
    const chunks = await this.db.repositories.seoSitemapCacheModel.find({}).select('type storeId chunkIndex generatedAt').lean();
    const entries = chunks.map((c: any) => {
      const suffix = c.storeId ? `${c.type}-${c.storeId}-${c.chunkIndex}` : `${c.type}-${c.chunkIndex}`;
      return `  <sitemap>\n    <loc>${PLATFORM_ORIGIN}/sitemap-${suffix}.xml</loc>\n    <lastmod>${(c.generatedAt ?? new Date()).toISOString()}</lastmod>\n  </sitemap>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</sitemapindex>`;
  }
}

function buildUrlsetXml(urls: Array<{ loc: string; lastmod?: Date }>): string {
  const entries = urls.map((u) => {
    const lastmod = u.lastmod ? `\n    <lastmod>${new Date(u.lastmod).toISOString()}</lastmod>` : '';
    return `  <url>\n    <loc>${escapeXml(u.loc)}</loc>${lastmod}\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
