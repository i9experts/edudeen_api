/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ProductsService } from 'src/products/products.service';
import { StoreService } from 'src/store/store.service';

const MAX_RECENT_SEARCHES = 15;
const MAX_RECENTLY_VIEWED = 30;
const MAX_QUERY_LENGTH = 100;

/** Buyer-facing product search + per-user search history and recently-viewed
 *  products. Product shaping (variants + subscriber pricing) is delegated to
 *  ProductsService so search results match the by-category response shape. */
@Injectable()
export class SearchService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly productsService: ProductsService,
    private readonly storeService: StoreService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  // ── Product search ─────────────────────────────────────────────────────────

  /** Runs the search and, for logged-in callers, records the term (fire-and-
   *  forget — a history write must never fail the search itself). */
  async searchProducts(q: string, page: number, limit: number, userId: string | null, viewerId: string | null = userId) {
    // viewerId (for member pricing) can be set without recording history (userId null).
    const result = await this.productsService.searchProducts(q, page, limit, viewerId);

    if (userId && (q || '').trim()) {
      this.recordSearch(userId, q).catch(() => undefined);
    }
    return result;
  }

  // ── Store search ────────────────────────────────────────────────────────────
  // Delegates straight to StoreService.listPublicStores — no recent-search
  // history side effect for stores (that history is product-only today).

  async searchStores(q: string, page: number, limit: number) {
    return this.storeService.listPublicStores({ q, page, limit });
  }

  // ── Recent searches ────────────────────────────────────────────────────────

  private trendingCache: { at: number; data: { query: string; searches: number }[] } | null = null;

  /** What buyers are searching for lately, across everyone: terms searched by
   *  at least two different people in the last 14 days, most-searched first.
   *  (One person's search never shows up here on its own.) Cached ~10 minutes. */
  async getTrendingSearches(limit = 8) {
    if (this.trendingCache && Date.now() - this.trendingCache.at < 10 * 60 * 1000) {
      return { success: true, data: this.trendingCache.data.slice(0, limit) };
    }
    const since = new Date(Date.now() - 14 * 24 * 3600 * 1000);
    const rows: { _id: string; display: string; users: number; searches: number }[] = await this.r.recentSearchModel.aggregate([
      { $match: { updatedAt: { $gte: since } } },
      { $group: { _id: '$query', display: { $last: '$displayQuery' }, users: { $sum: 1 }, searches: { $sum: '$count' } } },
      { $match: { users: { $gte: 2 } } },
      { $sort: { users: -1, searches: -1 } },
      { $limit: 20 },
    ]);
    const data = rows.map(r => ({ query: r.display || r._id, searches: r.searches }));
    this.trendingCache = { at: Date.now(), data };
    return { success: true, data: data.slice(0, limit) };
  }

  async recordSearch(userId: string, rawQuery: string) {
    const displayQuery = (rawQuery || '').trim().slice(0, MAX_QUERY_LENGTH);
    const query = displayQuery.toLowerCase();
    if (!query) return;

    const { recentSearchModel } = this.r;
    await recentSearchModel.findOneAndUpdate(
      { userId, query },
      { $set: { displayQuery }, $inc: { count: 1 } },
      { upsert: true, returnDocument: 'after' },
    );

    // Prune beyond the cap so the collection can't grow unbounded per user.
    const extras = await recentSearchModel
      .find({ userId })
      .sort({ updatedAt: -1 })
      .skip(MAX_RECENT_SEARCHES)
      .select('_id')
      .lean();
    if (extras.length > 0) {
      await recentSearchModel.deleteMany({ _id: { $in: extras.map((e) => e._id) } });
    }
  }

  async getRecentSearches(userId: string, limit: number = 10) {
    const searches = await this.r.recentSearchModel
      .find({ userId })
      .sort({ updatedAt: -1 })
      .limit(Math.min(limit, MAX_RECENT_SEARCHES))
      .lean();

    return {
      success: true,
      data: searches.map((s) => ({
        searchId: s._id.toString(),
        query: s.displayQuery || s.query,
      })),
    };
  }

  async deleteRecentSearch(userId: string, searchId: string) {
    const deleted = await this.r.recentSearchModel.findOneAndDelete({ _id: searchId, userId });
    if (!deleted) throw new BadRequestException('Search entry not found');
    return { success: true, message: 'Search removed' };
  }

  async clearRecentSearches(userId: string) {
    await this.r.recentSearchModel.deleteMany({ userId });
    return { success: true, message: 'Search history cleared' };
  }

  // ── Recently viewed products ───────────────────────────────────────────────

  async recordProductView(userId: string, productId: string) {
    if (!productId || typeof productId !== 'string') {
      throw new BadRequestException('productId is required');
    }

    const { recentlyViewedModel } = this.r;
    await recentlyViewedModel.findOneAndUpdate(
      { userId, productId },
      { $inc: { viewCount: 1 } },
      { upsert: true, returnDocument: 'after' },
    );

    const extras = await recentlyViewedModel
      .find({ userId })
      .sort({ updatedAt: -1 })
      .skip(MAX_RECENTLY_VIEWED)
      .select('_id')
      .lean();
    if (extras.length > 0) {
      await recentlyViewedModel.deleteMany({ _id: { $in: extras.map((e) => e._id) } });
    }

    return { success: true, message: 'View recorded' };
  }

  /** Products the user opened, newest first — deleted/inactive products drop
   *  out automatically because the shaping only returns active ones. */
  async getRecentlyViewed(userId: string, limit: number = 10) {
    const entries = await this.r.recentlyViewedModel
      .find({ userId })
      .sort({ updatedAt: -1 })
      .limit(Math.min(limit, MAX_RECENTLY_VIEWED))
      .lean();

    const products = await this.productsService.getShapedProductsByIds(
      entries.map((e) => e.productId),
      userId,
    );

    return { success: true, data: { products } };
  }

  async clearRecentlyViewed(userId: string) {
    await this.r.recentlyViewedModel.deleteMany({ userId });
    return { success: true, message: 'Recently viewed cleared' };
  }
}
