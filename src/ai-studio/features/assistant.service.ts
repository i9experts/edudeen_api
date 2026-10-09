/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { AiService, AiToolDef } from '../core/ai.service';
import { AiCatalogService, ProductCard, normalizeFilters } from './catalog.service';

export const ASSISTANT_TOOLS: AiToolDef[] = [
  {
    name: 'search_products',
    description: 'Search the Edudeen catalogue. Use for any request to find or recommend products. Returns real products only.',
    input_schema: {
      type: 'object',
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, description: 'Subject/topic words (English or Urdu)' },
        educationLevel: { type: 'string' }, productType: { type: 'string', enum: ['physical', 'digital', 'educational'] },
        age: { type: 'integer' }, maxPrice: { type: 'number' }, minPrice: { type: 'number' },
        sort: { type: 'string', enum: ['newest', 'price_asc', 'price_desc', 'rating', 'popularity'] },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'get_product',
    description: 'Get details of one product by id or slug (from earlier search results).',
    input_schema: { type: 'object', properties: { idOrSlug: { type: 'string' } }, required: ['idOrSlug'] },
  },
  {
    name: 'get_my_orders',
    description: 'List the signed-in buyer\'s most recent orders (order number, status, payment, total, date).',
    input_schema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'get_order_status',
    description: 'Status of one of the signed-in buyer\'s orders by order number.',
    input_schema: { type: 'object', properties: { orderNumber: { type: 'string' } }, required: ['orderNumber'] },
  },
];

const SYSTEM = [
  'You are Edudeen\'s shopping assistant for parents, students and teachers. Be brief, warm and helpful. Reply in the language the user writes (English, Urdu or Roman Urdu).',
  'RULES: (1) Only recommend products that were returned by search_products / get_product in THIS conversation; NEVER invent a product, price, rating, seller or link. If search returns nothing, say so and suggest a broader search.',
  '(2) For orders use get_my_orders / get_order_status only; if the user is not signed in, ask them to sign in. Never discuss other people\'s orders.',
  '(3) You cannot place orders, change payments, issue refunds or give religious rulings. For those, point to the right page (Orders, Help) or suggest asking a qualified scholar.',
  '(4) Refer to products by exact name; the app shows the product cards with links, so do not print URLs.',
].join('\n');

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

/** Pure: validate/trim the client-supplied history (the model only ever sees plain text turns). */
export function sanitizeHistory(raw: unknown, maxTurns = 12, maxChars = 1500): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns = raw
    .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content.trim().slice(0, maxChars) }))
    .slice(-maxTurns);
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

@Injectable()
export class AssistantService {
  constructor(private readonly db: DatabaseService, private readonly ai: AiService, private readonly catalog: AiCatalogService) {}

  /** `buyerId` is null for guests. Order tools are bound to this id in code; the model can never pick another user. */
  async chat(buyerId: string | null, rawMessages: unknown) {
    const messages = sanitizeHistory(rawMessages);
    if (!messages.length || messages[messages.length - 1].role !== 'user') throw new BadRequestException('Send at least one user message.');
    const cards = new Map<string, ProductCard>();

    const out = await this.ai.runToolLoop(
      { feature: 'shopping_assistant', tier: 'fast', userId: buyerId, maxTokens: 700, system: SYSTEM, tools: ASSISTANT_TOOLS, messages },
      async (name, input) => {
        if (name === 'search_products') {
          const list = await this.catalog.search(normalizeFilters(input), 8);
          list.forEach((c) => cards.set(c.id, c));
          return { count: list.length, products: list.map((c) => ({ id: c.id, slug: c.slug, name: c.name, price: c.price, currency: c.currency, rating: c.rating, ratingCount: c.ratingCount, type: c.productType })) };
        }
        if (name === 'get_product') {
          const p = await this.catalog.getOne(String(input.idOrSlug ?? '').slice(0, 120));
          if (!p) return { error: 'not_found' };
          cards.set(p.id, p);
          return p;
        }
        if (name === 'get_my_orders' || name === 'get_order_status') {
          if (!buyerId) return { error: 'login_required' };
          const filter: any = { userId: buyerId };
          if (name === 'get_order_status') filter.orderNumber = String(input.orderNumber ?? '').slice(0, 40);
          const orders: any[] = await this.db.repositories.orderModel.find(filter).sort({ createdAt: -1 })
            .limit(name === 'get_my_orders' ? Math.min(Math.max(Number(input.limit) || 5, 1), 10) : 1)
            .select('orderNumber orderStatus paymentStatus paymentType totalAmount currency createdAt sellerOrders.status sellerOrders.tracking').lean();
          if (!orders.length) return { error: 'not_found' };
          return orders.map((o) => ({
            orderNumber: o.orderNumber, status: o.orderStatus, payment: o.paymentStatus, paymentType: o.paymentType,
            total: o.totalAmount, currency: o.currency, placedAt: o.createdAt,
            shipments: (o.sellerOrders ?? []).map((so: any) => ({ status: so.status, tracking: so.tracking ? { carrier: so.tracking.carrier ?? null, trackingNumber: so.tracking.trackingNumber ?? null } : null })),
          }));
        }
        return { error: 'unknown_tool' };
      },
    );
    return { success: true, data: { reply: out.text.trim(), products: [...cards.values()].slice(0, 8) } };
  }
}
