/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from 'src/common/store-ownership.util';
import { AiService } from '../core/ai.service';

export interface CodSignals {
  isCod: boolean;
  accountAgeDays: number | null;
  priorOrders: number;
  priorCancelled: number;
  priorReturned: number;
  orderTotal: number;
  avgOrderTotal: number | null;
  hasPhone: boolean;
  addressComplete: boolean;
  itemCount: number;
  hasPhysicalItems: boolean;
  ordersLast24h: number;
}

export interface CodRisk { score: number; level: 'low' | 'medium' | 'high'; factors: Array<{ code: string; points: number; text: string }> }

/** Pure, deterministic COD risk score 0-100 (the model only EXPLAINS it, never sets it). */
export function computeCodRisk(s: CodSignals): CodRisk {
  const factors: CodRisk['factors'] = [];
  const add = (code: string, points: number, text: string) => factors.push({ code, points, text });
  if (!s.isCod) return { score: 0, level: 'low', factors: [{ code: 'not_cod', points: 0, text: 'Prepaid order: no cash-on-delivery risk.' }] };

  if (s.accountAgeDays != null && s.accountAgeDays < 2) add('new_account', 20, 'Account is less than 2 days old.');
  else if (s.accountAgeDays != null && s.accountAgeDays < 14) add('young_account', 8, 'Account is less than 2 weeks old.');
  if (s.priorOrders === 0) add('first_order', 12, 'First order from this buyer.');
  if (s.priorOrders > 0) {
    const badRate = (s.priorCancelled + s.priorReturned) / s.priorOrders;
    if (badRate >= 0.5) add('bad_history', 30, `${s.priorCancelled} cancelled and ${s.priorReturned} returned out of ${s.priorOrders} past orders.`);
    else if (badRate >= 0.25) add('some_bad_history', 15, 'A noticeable share of past orders were cancelled or returned.');
  }
  if (s.priorOrders >= 3 && s.priorCancelled + s.priorReturned === 0) add('good_history', -12, 'Buyer has several clean past orders.');
  if (s.avgOrderTotal && s.orderTotal > s.avgOrderTotal * 3 && s.orderTotal > 3000) add('unusually_large', 15, 'Order is much larger than this buyer\'s usual order.');
  if (s.orderTotal >= 15000) add('high_value', 12, 'High-value cash order.');
  if (!s.hasPhone && s.hasPhysicalItems) add('no_phone', 15, 'No phone number for the courier.');
  if (!s.addressComplete && s.hasPhysicalItems) add('weak_address', 10, 'Delivery address looks incomplete.');
  if (s.ordersLast24h >= 3) add('burst', 15, 'Several orders placed within 24 hours.');
  if (s.itemCount >= 10) add('many_items', 5, 'Very many items in one order.');

  const score = Math.max(0, Math.min(100, factors.reduce((n, f) => n + f.points, 0)));
  return { score, level: score >= 55 ? 'high' : score >= 25 ? 'medium' : 'low', factors };
}

@Injectable()
export class CodRiskService {
  constructor(private readonly db: DatabaseService, private readonly ai: AiService) {}

  async forOrder(sellerId: string, storeId: string, orderId: string, explain = true) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
    const r = this.db.repositories;
    const order: any = await r.orderModel.findOne({ _id: orderId, 'sellerOrders.storeId': storeId }).lean();
    if (!order) throw new NotFoundException('Order not found');
    const user: any = await r.userModel.findById(order.userId).select('createdAt').lean().catch(() => null);
    const past: any[] = await r.orderModel.find({ userId: order.userId, _id: { $ne: order._id } }).select('totalAmount orderStatus hasReturn createdAt').limit(100).lean();
    const items = (order.sellerOrders ?? []).flatMap((so: any) => so.items ?? []);
    const addr = order.shippingAddress;
    const dayAgo = Date.now() - 86_400_000;
    const signals: CodSignals = {
      isCod: order.paymentType === 'cash_on_delivery',
      accountAgeDays: user?.createdAt ? Math.floor((Date.now() - new Date(user.createdAt).getTime()) / 86_400_000) : null,
      priorOrders: past.length,
      priorCancelled: past.filter((o) => o.orderStatus === 'cancelled').length,
      priorReturned: past.filter((o) => o.hasReturn).length,
      orderTotal: order.totalAmount ?? 0,
      avgOrderTotal: past.length ? past.reduce((n, o) => n + (o.totalAmount ?? 0), 0) / past.length : null,
      hasPhone: !!addr?.phoneNumber,
      addressComplete: !!(addr?.addressLine1 && addr?.city),
      itemCount: items.length,
      hasPhysicalItems: items.some((i: any) => (i.type ?? i.productType) === 'physical'),
      ordersLast24h: past.filter((o) => new Date(o.createdAt).getTime() > dayAgo).length + 1,
    };
    const risk = computeCodRisk(signals);

    let explanation: string | null = null;
    if (explain && signals.isCod && this.ai.isAvailable() && (await this.ai.isFeatureOn('cod_risk', storeId))) {
      try {
        const out = await this.ai.generate({
          feature: 'cod_risk', tier: 'fast', storeId, sellerId, maxTokens: 250,
          system: 'You explain a pre-computed cash-on-delivery risk score to a small-shop seller in 2-3 plain sentences and suggest one practical step (e.g. call the buyer to confirm, ask for a bank-transfer advance). The score and factors are final: narrate them, never change or add numbers or factors, never accuse the buyer.',
          messages: [{ role: 'user', content: `Score: ${risk.score}/100 (${risk.level}).\nFactors:\n${risk.factors.map((f) => `- ${f.text}`).join('\n')}` }],
        });
        explanation = out.text.trim().slice(0, 600) || null;
      } catch { /* the score is still useful without prose */ }
    }
    return { success: true, data: { orderId, ...risk, explanation, explainedByAi: !!explanation } };
  }
}
