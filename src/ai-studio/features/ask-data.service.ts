/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { AiService, AiToolDef } from '../core/ai.service';

/** Pure: clamp a model-supplied number into a safe range. */
export function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
}

export const ASK_TOOLS: AiToolDef[] = [
  { name: 'orders_summary', description: 'Order counts and gross order value over the last N days, optionally grouped by day, orderStatus or paymentType.',
    input_schema: { type: 'object', properties: { days: { type: 'integer' }, groupBy: { type: 'string', enum: ['none', 'day', 'orderStatus', 'paymentType'] } } } },
  { name: 'top_products', description: 'Best-selling products (by purchase count) with views and rating.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer' } } } },
  { name: 'top_stores', description: 'Stores ranked by revenue over the last N days.',
    input_schema: { type: 'object', properties: { days: { type: 'integer' }, limit: { type: 'integer' } } } },
  { name: 'listing_status_counts', description: 'Number of listings per status (active, pending_review, rejected, draft...).', input_schema: { type: 'object', properties: {} } },
  { name: 'new_users', description: 'New buyer and seller signups over the last N days.', input_schema: { type: 'object', properties: { days: { type: 'integer' } } } },
  { name: 'ai_usage', description: 'AI feature usage: calls, failures, tokens and estimated cost per feature over the last N days.', input_schema: { type: 'object', properties: { days: { type: 'integer' } } } },
  { name: 'review_stats', description: 'Review counts and average rating over the last N days, plus flagged reviews.', input_schema: { type: 'object', properties: { days: { type: 'integer' } } } },
];

/**
 * Admin "ask your data". The model may ONLY call the read-only, parameter-clamped tools above, which run fixed
 * aggregations written here. It never sees or writes a raw query, collection name or pipeline.
 */
@Injectable()
export class AskDataService {
  constructor(private readonly db: DatabaseService, private readonly ai: AiService) {}
  private get r() { return this.db.repositories; }
  private since(days: number) { return new Date(Date.now() - days * 86_400_000); }

  async runTool(name: string, input: Record<string, any>): Promise<unknown> {
    const days = clampNum(input?.days, 1, 365, 30);
    switch (name) {
      case 'orders_summary': {
        const groupBy = ['day', 'orderStatus', 'paymentType'].includes(input?.groupBy) ? input.groupBy : 'none';
        const key = groupBy === 'day' ? { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } : groupBy === 'none' ? null : `$${groupBy}`;
        const rows = await this.r.orderModel.aggregate([
          { $match: { createdAt: { $gte: this.since(days) } } },
          { $group: { _id: key, orders: { $sum: 1 }, grossValue: { $sum: '$totalAmount' } } },
          { $sort: { _id: 1 } }, { $limit: 100 },
        ]);
        return { days, note: 'Gross value mixes currencies (PKR/USD) as stored; treat as indicative.', rows: rows.map((x) => ({ group: x._id, orders: x.orders, grossValue: Math.round(x.grossValue) })) };
      }
      case 'top_products': {
        const rows: any[] = await this.r.productModel.find({ isDelete: false, status: 'active' }).sort({ purchaseCount: -1 }).limit(clampNum(input?.limit, 1, 20, 10))
          .select('name purchaseCount viewCount averageRating totalRatings').lean();
        return rows.map((p) => ({ name: p.name, purchases: p.purchaseCount, views: p.viewCount, rating: p.averageRating, ratings: p.totalRatings }));
      }
      case 'top_stores': {
        const rows = await this.r.orderModel.aggregate([
          { $match: { createdAt: { $gte: this.since(days) } } }, { $unwind: '$sellerOrders' },
          { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
          { $group: { _id: '$sellerOrders.storeId', revenue: { $sum: '$sellerOrders.subtotal' }, orders: { $sum: 1 } } },
          { $sort: { revenue: -1 } }, { $limit: clampNum(input?.limit, 1, 20, 10) },
        ]);
        const stores: any[] = await this.r.storeModel.find({ _id: { $in: rows.map((x) => x._id).filter((id) => /^[a-f0-9]{24}$/i.test(String(id))) } }).select('name').lean();
        const names = new Map(stores.map((s) => [s._id.toString(), s.name]));
        return rows.map((x) => ({ store: names.get(String(x._id)) ?? String(x._id), revenue: Math.round(x.revenue), orders: x.orders }));
      }
      case 'listing_status_counts': {
        const rows = await this.r.productModel.aggregate([{ $match: { isDelete: false } }, { $group: { _id: '$status', count: { $sum: 1 } } }]);
        return rows.map((x) => ({ status: x._id, count: x.count }));
      }
      case 'new_users': {
        const [buyers, sellers] = await Promise.all([
          this.r.userModel.countDocuments({ createdAt: { $gte: this.since(days) } }),
          this.r.sellerModel.countDocuments({ createdAt: { $gte: this.since(days) } }),
        ]);
        return { days, newBuyers: buyers, newSellers: sellers };
      }
      case 'ai_usage': {
        const rows = await this.r.aiGenerationModel.aggregate([
          { $match: { createdAt: { $gte: this.since(days) }, isCallLog: true } },
          { $group: { _id: '$toolType', calls: { $sum: 1 }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }, tokensIn: { $sum: '$tokensIn' }, tokensOut: { $sum: '$tokensOut' }, costUsd: { $sum: '$costUsd' } } },
          { $sort: { calls: -1 } },
        ]);
        return rows.map((x) => ({ feature: x._id, calls: x.calls, failed: x.failed, tokensIn: x.tokensIn, tokensOut: x.tokensOut, estCostUsd: Math.round(x.costUsd * 1000) / 1000 }));
      }
      case 'review_stats': {
        const [agg] = await this.r.ratingModel.aggregate([
          { $match: { createdAt: { $gte: this.since(days) }, isDelete: { $ne: true } } },
          { $group: { _id: null, count: { $sum: 1 }, avg: { $avg: '$rating' }, flagged: { $sum: { $cond: ['$isFlagged', 1, 0] } } } },
        ]);
        return { days, count: agg?.count ?? 0, averageRating: agg?.avg ? Math.round(agg.avg * 100) / 100 : null, flagged: agg?.flagged ?? 0 };
      }
      default:
        throw new Error('unknown tool');
    }
  }

  async ask(adminId: string, question: string) {
    const q = String(question ?? '').trim().slice(0, 500);
    if (q.length < 3) throw new BadRequestException('Ask a question (at least 3 characters).');
    const out = await this.ai.runToolLoop(
      {
        feature: 'ask_data', tier: 'standard', adminId, maxTokens: 900, tools: ASK_TOOLS, stripPii: false,
        system: 'You are a data analyst for the Edudeen admin team. Answer ONLY from the tools provided (read-only aggregates). Call the tools you need, then answer in a few clear sentences with the key numbers; add a small markdown table only if it helps. If the tools cannot answer the question, say what is missing instead of guessing. Never reveal personal data. Mention the time window used.',
        messages: [{ role: 'user', content: q }],
      },
      (name, input) => this.runTool(name, input),
      5,
    );
    return { success: true, data: { answer: out.text.trim(), sources: out.toolResults.map((t) => ({ tool: t.name, input: t.input })), costUsd: out.costUsd } };
  }
}
