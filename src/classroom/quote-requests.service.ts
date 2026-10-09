/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { INSTITUTION_TYPES, QuoteRequest, QuoteRequestDocument } from './schemas/quote-request.schema';
import { cleanNetTerms, cleanPurchaseOrder } from './quote-terms.util';

export const MAX_OPEN_QUOTES_PER_BUYER = 10;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function quoteNumber() {
  const d = new Date();
  return `QR-${d.getFullYear().toString().slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Validates the buyer's request form; returns clean fields or throws one readable message. */
export function cleanQuoteInput(body: any) {
  const institutionName = str(body?.institutionName, 120);
  const contactName = str(body?.contactName, 80);
  const contactPhone = str(body?.contactPhone, 30);
  const quantity = Number(body?.quantity);
  if (!institutionName) throw new BadRequestException('Enter your school or institute name');
  if (!contactName) throw new BadRequestException('Enter a contact person');
  if (!/^[+\d][\d\s-]{6,}$/.test(contactPhone)) throw new BadRequestException('Enter a phone number the seller can call');
  if (!Number.isInteger(quantity) || quantity < 2 || quantity > 100000) throw new BadRequestException('Quantity should be between 2 and 100,000');
  const institutionType = (INSTITUTION_TYPES as readonly string[]).includes(body?.institutionType) ? body.institutionType : 'school';
  return { institutionName, institutionType, city: str(body?.city, 60), contactName, contactPhone, quantity, message: str(body?.message, 2000) };
}

@Injectable()
export class QuoteRequestsService {
  constructor(
    @InjectModel(QuoteRequest.name) private readonly quoteModel: Model<QuoteRequestDocument>,
    private readonly databaseService: DatabaseService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async create(userId: string, body: any) {
    const input = cleanQuoteInput(body);
    const productId = typeof body?.productId === 'string' ? body.productId : '';
    if (!isValidObjectId(productId)) throw new BadRequestException('Pick a resource to get a quote for');
    const product: any = await this.databaseService.repositories.productModel
      .findOne({ _id: productId, status: 'active', isDelete: false }).select('_id name storeId sellerId').lean();
    if (!product) throw new NotFoundException('That resource is no longer available');
    if (String(product.sellerId) === userId) throw new BadRequestException('You cannot request a quote from your own store');
    const open = await this.quoteModel.countDocuments({ buyerId: userId, status: { $in: ['pending', 'quoted'] } });
    if (open >= MAX_OPEN_QUOTES_PER_BUYER) throw new BadRequestException('You already have several open quote requests — wait for replies first');
    const user: any = await this.databaseService.repositories.userModel.findById(userId).select('email').lean().catch(() => null);
    const doc = await this.quoteModel.create({
      ...input, number: quoteNumber(), buyerId: userId, buyerEmail: user?.email ?? '',
      storeId: String(product.storeId), sellerId: String(product.sellerId), productId: String(product._id), productName: product.name,
    });
    void this.notificationsService.notify({
      recipientId: String(product.sellerId), recipientRole: 'seller', type: NOTIFICATION_TYPES.QUOTE_REQUESTED,
      title: `Quote request from ${input.institutionName}`, body: `${input.quantity} × ${product.name}`,
      data: { quoteId: String(doc._id), storeId: String(product.storeId), link: `/store/${product.storeId}/quotes` },
    });
    return { success: true, message: 'Quote request sent — the seller will reply with a price', data: doc.toObject() };
  }

  async listMine(userId: string) {
    const rows = await this.quoteModel.find({ buyerId: userId }).sort({ createdAt: -1 }).limit(100).lean();
    return { success: true, data: await this.withStoreNames(rows) };
  }

  private async withStoreNames(rows: any[]) {
    const ids = [...new Set(rows.map(r => r.storeId))].filter(id => isValidObjectId(id));
    const stores = await this.databaseService.repositories.storeModel.find({ _id: { $in: ids } }).select('_id name slug contactEmail contactPhone').lean();
    const byId = new Map(stores.map((s: any) => [String(s._id), s]));
    return rows.map(r => {
      const s: any = byId.get(r.storeId);
      return { ...r, storeName: s?.name ?? 'Store', storeSlug: s?.slug ?? null };
    });
  }

  /** One quote, for the buyer who asked or the seller who received it (printable quotation page). */
  async getOne(userId: string, id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Quote not found');
    const q: any = await this.quoteModel.findById(id).lean();
    if (!q) throw new NotFoundException('Quote not found');
    if (q.buyerId !== userId && q.sellerId !== userId) throw new ForbiddenException('This quote is not yours');
    const store: any = await this.databaseService.repositories.storeModel.findById(q.storeId).select('name slug contactEmail contactPhone').lean();
    return {
      success: true,
      data: { ...q, storeName: store?.name ?? 'Store', storeSlug: store?.slug ?? null, storeContactEmail: store?.contactEmail ?? null, storeContactPhone: store?.contactPhone ?? null, viewer: q.buyerId === userId ? 'buyer' : 'seller' },
    };
  }

  async respondAsBuyer(userId: string, id: string, action: 'accept' | 'decline' | 'cancel') {
    if (!isValidObjectId(id)) throw new NotFoundException('Quote not found');
    const q = await this.quoteModel.findById(id);
    if (!q || q.buyerId !== userId) throw new NotFoundException('Quote not found');
    if (action === 'cancel') {
      if (q.status !== 'pending') throw new BadRequestException('Only a request still waiting for a price can be cancelled');
      q.status = 'cancelled';
    } else {
      if (q.status !== 'quoted' || !q.offer) throw new BadRequestException('There is no price to respond to yet');
      if (action === 'accept' && q.offer.validUntil && new Date(q.offer.validUntil).getTime() < Date.now()) {
        throw new BadRequestException('This quote has expired — ask the seller for a fresh one');
      }
      q.status = action === 'accept' ? 'accepted' : 'declined';
    }
    q.respondedAt = new Date();
    await q.save();
    if (action !== 'cancel') {
      void this.notificationsService.notify({
        recipientId: q.sellerId, recipientRole: 'seller',
        type: action === 'accept' ? NOTIFICATION_TYPES.QUOTE_ACCEPTED : NOTIFICATION_TYPES.QUOTE_DECLINED,
        title: action === 'accept' ? `${q.institutionName} accepted your quote` : `${q.institutionName} declined your quote`,
        body: `${q.number} · ${q.quantity} × ${q.productName}`,
        data: { quoteId: String(q._id), storeId: q.storeId, link: `/store/${q.storeId}/quotes` },
      });
    }
    const label = { accept: 'Quote accepted — the seller will contact you to arrange payment and delivery', decline: 'Quote declined', cancel: 'Request cancelled' }[action];
    return { success: true, message: label, data: q.toObject() };
  }

  /** Buyer adds the institution's purchase order (number and/or uploaded file) to a quote that has a price. */
  async attachPurchaseOrder(userId: string, id: string, body: any) {
    if (!isValidObjectId(id)) throw new NotFoundException('Quote not found');
    const q = await this.quoteModel.findById(id);
    if (!q || q.buyerId !== userId) throw new NotFoundException('Quote not found');
    if (!['quoted', 'accepted'].includes(q.status)) throw new BadRequestException('A purchase order can be added once the seller has sent a price');
    let po;
    try { po = cleanPurchaseOrder(body); } catch (e: any) { throw new BadRequestException(e?.message); }
    q.purchaseOrderNumber = po.purchaseOrderNumber;
    q.purchaseOrderUrl = po.purchaseOrderUrl;
    await q.save();
    void this.notificationsService.notify({
      recipientId: q.sellerId, recipientRole: 'seller', type: NOTIFICATION_TYPES.QUOTE_ACCEPTED,
      title: `Purchase order added for ${q.number}`, body: po.purchaseOrderNumber ? `PO ${po.purchaseOrderNumber}` : 'A purchase order file was uploaded',
      data: { quoteId: String(q._id), storeId: q.storeId, link: `/store/${q.storeId}/quotes` },
    });
    return { success: true, message: 'Purchase order saved', data: q.toObject() };
  }

  async listForSeller(storeId: string, sellerId: string, status?: string) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    const filter: any = { storeId };
    if (typeof status === 'string' && ['pending', 'quoted', 'accepted', 'declined', 'cancelled'].includes(status)) filter.status = status;
    const rows = await this.quoteModel.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    const pending = await this.quoteModel.countDocuments({ storeId, status: 'pending' });
    return { success: true, data: { pending, quotes: rows } };
  }

  async sendOffer(storeId: string, sellerId: string, id: string, body: any) {
    const store = await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    if (!isValidObjectId(id)) throw new NotFoundException('Quote not found');
    const q = await this.quoteModel.findOne({ _id: id, storeId });
    if (!q) throw new NotFoundException('Quote not found');
    if (!['pending', 'quoted'].includes(q.status)) throw new BadRequestException('This request is already closed');
    const unitPrice = Number(body?.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0 || unitPrice > 10_000_000) throw new BadRequestException('Enter a price per unit');
    let validUntil: Date | null = null;
    if (body?.validUntil) {
      validUntil = new Date(body.validUntil);
      if (Number.isNaN(validUntil.getTime()) || validUntil.getTime() < Date.now()) throw new BadRequestException('"Valid until" must be a future date');
    }
    const rounded = Math.round(unitPrice * 100) / 100;
    let netTerms: string;
    try { netTerms = cleanNetTerms(body?.netTerms); } catch (e: any) { throw new BadRequestException(e?.message); }
    q.offer = { unitPrice: rounded, totalPrice: Math.round(rounded * q.quantity * 100) / 100, currency: (store as any).baseCurrency || 'PKR', validUntil, note: str(body?.note, 1000), netTerms };
    q.status = 'quoted';
    q.quotedAt = new Date();
    await q.save();
    void this.notificationsService.notify({
      recipientId: q.buyerId, recipientRole: 'user', type: NOTIFICATION_TYPES.QUOTE_SENT,
      title: `Your quote for ${q.productName} is ready`, body: `${q.quantity} units · ${q.offer.currency} ${q.offer.totalPrice.toLocaleString()}`,
      data: { quoteId: String(q._id), link: '/account/quotes' },
    });
    return { success: true, message: 'Quote sent to the buyer', data: q.toObject() };
  }

  async declineAsSeller(storeId: string, sellerId: string, id: string, body: any) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    if (!isValidObjectId(id)) throw new NotFoundException('Quote not found');
    const q = await this.quoteModel.findOne({ _id: id, storeId });
    if (!q) throw new NotFoundException('Quote not found');
    if (!['pending', 'quoted'].includes(q.status)) throw new BadRequestException('This request is already closed');
    q.status = 'declined';
    q.declineReason = str(body?.reason, 500);
    q.respondedAt = new Date();
    await q.save();
    void this.notificationsService.notify({
      recipientId: q.buyerId, recipientRole: 'user', type: NOTIFICATION_TYPES.QUOTE_DECLINED,
      title: `The seller can't quote for ${q.productName}`, body: q.declineReason || 'Try another store or a smaller quantity.',
      data: { quoteId: String(q._id), link: '/account/quotes' },
    });
    return { success: true, message: 'Request declined' };
  }
}
