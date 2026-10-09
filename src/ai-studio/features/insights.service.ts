/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from 'src/common/store-ownership.util';
import { AiService } from '../core/ai.service';

export interface WeeklyStats {
  weekRevenue: number; prevWeekRevenue: number; revenueChangePct: number | null;
  weekOrders: number; prevWeekOrders: number;
  topProducts: Array<{ name: string; units: number; revenue: number }>;
  newReviews: number; avgNewRating: number | null; lowRatedReviews: number;
  cancelledOrders: number;
  lowViewProducts: Array<{ name: string; views: number }>;
  activeProducts: number;
}

/** Pure: % change with a guard for a zero baseline. */
export function pctChange(now: number, prev: number): number | null {
  if (!prev) return now ? null : 0;
  return Math.round(((now - prev) / prev) * 1000) / 10;
}

export const INSIGHTS_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    highlights: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, why: { type: 'string' } }, required: ['title', 'why'], additionalProperties: false } },
  },
  required: ['headline', 'highlights', 'actions'],
  additionalProperties: false,
};

@Injectable()
export class InsightsService {
  constructor(private readonly db: DatabaseService, private readonly ai: AiService) {}
  private get r() { return this.db.repositories; }

  /** All numbers are computed here in code; Claude only turns them into a short digest + 3 actions. */
  async computeStats(storeId: string, now = new Date()): Promise<WeeklyStats> {
    const week = new Date(now.getTime() - 7 * 86_400_000);
    const prev = new Date(now.getTime() - 14 * 86_400_000);
    const orders: any[] = await this.r.orderModel.find({ 'sellerOrders.storeId': storeId, createdAt: { $gte: prev } }).select('createdAt sellerOrders').lean();
    let weekRevenue = 0, prevWeekRevenue = 0, weekOrders = 0, prevWeekOrders = 0, cancelled = 0;
    const byProduct = new Map<string, { name: string; units: number; revenue: number }>();
    for (const o of orders) {
      const inWeek = new Date(o.createdAt) >= week;
      for (const so of o.sellerOrders ?? []) {
        if (so.storeId !== storeId) continue;
        if (so.status === 'cancelled') { if (inWeek) cancelled++; continue; }
        const amount = so.subtotal ?? 0;
        if (inWeek) {
          weekRevenue += amount; weekOrders++;
          for (const it of so.items ?? []) {
            const cur = byProduct.get(String(it.productId)) ?? { name: it.name, units: 0, revenue: 0 };
            cur.units += it.quantity ?? 1; cur.revenue += it.totalPrice ?? 0; byProduct.set(String(it.productId), cur);
          }
        } else { prevWeekRevenue += amount; prevWeekOrders++; }
      }
    }
    const reviews: any[] = await this.r.ratingModel.find({ storeId, createdAt: { $gte: week }, isDelete: { $ne: true } }).select('rating').lean();
    const rated = reviews.filter((x) => typeof x.rating === 'number');
    const products: any[] = await this.r.productModel.find({ storeId, status: 'active', isDelete: false }).select('name viewCount').sort({ viewCount: 1 }).limit(3).lean();
    const activeProducts = await this.r.productModel.countDocuments({ storeId, status: 'active', isDelete: false });
    return {
      weekRevenue: Math.round(weekRevenue * 100) / 100, prevWeekRevenue: Math.round(prevWeekRevenue * 100) / 100,
      revenueChangePct: pctChange(weekRevenue, prevWeekRevenue), weekOrders, prevWeekOrders,
      topProducts: [...byProduct.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 3),
      newReviews: reviews.length, avgNewRating: rated.length ? Math.round((rated.reduce((n, x) => n + x.rating, 0) / rated.length) * 10) / 10 : null,
      lowRatedReviews: rated.filter((x) => x.rating <= 2).length, cancelledOrders: cancelled,
      lowViewProducts: products.map((p) => ({ name: p.name, views: p.viewCount ?? 0 })), activeProducts,
    };
  }

  async generate(sellerId: string, storeId: string) {
    const store: any = await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    const stats = await this.computeStats(storeId);
    const digest = await this.ai.withCredits('weekly_insights', storeId, sellerId, async () => {
      const out = await this.ai.generate({
        feature: 'weekly_insights', tier: 'standard', storeId, sellerId, maxTokens: 900, schema: INSIGHTS_SCHEMA,
        system: 'You write a weekly business digest for an independent seller on an education marketplace. The statistics are computed and final: quote them exactly, never recompute or invent numbers. Be encouraging and specific. headline: one sentence. highlights: 3-5 short bullets. actions: exactly 3 practical next steps (e.g. improve a low-view listing, reply to a low rating, run a promotion) with a short reason each.',
        messages: [{ role: 'user', content: `Store: ${store.name}\nStats (last 7 days vs the 7 before):\n${JSON.stringify(stats, null, 1)}` }],
      });
      return out.json;
    });
    const saved = { digest, stats, at: new Date().toISOString() };
    await this.r.aiGenerationModel.create({
      scope: 'seller', sellerId, storeId, toolType: 'weekly_insights', status: 'succeeded', inputPayload: {}, outputPayload: saved,
      providerUsed: 'claude', creditsCharged: this.ai['credits']?.costOf('weekly_insights') ?? 0, sessionId: new Types.ObjectId().toString(), isCallLog: false,
    }).catch(() => undefined);
    return { success: true, data: saved };
  }

  async latest(sellerId: string, storeId: string) {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    const row: any = await this.r.aiGenerationModel.findOne({ storeId, toolType: 'weekly_insights', isCallLog: false, status: 'succeeded' }).sort({ createdAt: -1 }).lean();
    return { success: true, data: row?.outputPayload ?? null };
  }
}
