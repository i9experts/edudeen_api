/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { ProductQuestion, ProductQuestionDocument } from './schemas/product-question.schema';

export const QUESTIONS_PER_DAY = 20;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

@Injectable()
export class ProductQuestionsService {
  constructor(
    @InjectModel(ProductQuestion.name) private readonly questionModel: Model<ProductQuestionDocument>,
    private readonly databaseService: DatabaseService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private async findProduct(idOrSlug: string) {
    const { productModel } = this.databaseService.repositories;
    let product: any = await productModel.findOne({ slug: idOrSlug, isDelete: false }).select('_id name slug storeId sellerId status').lean();
    if (!product && isValidObjectId(idOrSlug)) product = await productModel.findOne({ _id: idOrSlug, isDelete: false }).select('_id name slug storeId sellerId status').lean();
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  /** Answered questions for the product page, plus the viewer's own pending ones. */
  async listForProduct(idOrSlug: string, viewerId?: string | null) {
    const product = await this.findProduct(idOrSlug);
    const pid = String(product._id);
    const or: any[] = [{ answeredAt: { $ne: null }, hidden: false }];
    if (viewerId) or.push({ askerId: viewerId, hidden: false });
    const rows = await this.questionModel.find({ productId: pid, $or: or }).sort({ answeredAt: -1, createdAt: -1 }).limit(50).lean();
    return {
      success: true,
      data: rows.map(q => ({
        _id: q._id, question: q.question, answer: q.answer, answeredAt: q.answeredAt,
        askerName: q.askerName ? q.askerName.split(' ')[0] : 'A buyer',
        createdAt: (q as any).createdAt, isMine: !!viewerId && q.askerId === viewerId,
      })),
    };
  }

  async ask(userId: string, idOrSlug: string, body: any) {
    const question = str(body?.question, 500);
    if (question.length < 8) throw new BadRequestException('Write your question in a sentence or two');
    const product = await this.findProduct(idOrSlug);
    if (product.status !== 'active') throw new BadRequestException('This listing is not taking questions right now');
    if (String(product.sellerId) === userId) throw new BadRequestException('You cannot ask a question on your own listing');
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const today = await this.questionModel.countDocuments({ askerId: userId, createdAt: { $gte: since } });
    if (today >= QUESTIONS_PER_DAY) throw new BadRequestException('You have asked a lot of questions today — please try again tomorrow');
    const user: any = await this.databaseService.repositories.userModel.findById(userId).select('name').lean().catch(() => null);
    const doc = await this.questionModel.create({
      productId: String(product._id), storeId: String(product.storeId), sellerId: String(product.sellerId),
      askerId: userId, askerName: user?.name ?? '', question,
    });
    void this.notificationsService.notify({
      recipientId: String(product.sellerId), recipientRole: 'seller', type: NOTIFICATION_TYPES.PRODUCT_QUESTION,
      title: `New question on "${product.name}"`, body: question.slice(0, 140),
      data: { productId: String(product._id), storeId: String(product.storeId), link: `/store/${product.storeId}/questions` },
    });
    return { success: true, message: 'Question sent — the seller usually answers within a day', data: { _id: doc._id } };
  }

  async deleteOwn(userId: string, id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Question not found');
    const q = await this.questionModel.findById(id);
    if (!q) throw new NotFoundException('Question not found');
    if (q.askerId !== userId) throw new ForbiddenException('This is not your question');
    if (q.answeredAt) throw new BadRequestException('Answered questions stay up so other buyers can read them');
    await q.deleteOne();
    return { success: true, message: 'Question deleted' };
  }

  async listForSeller(storeId: string, sellerId: string, status?: string) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    const filter: any = { storeId };
    if (status === 'unanswered') Object.assign(filter, { answeredAt: null, hidden: false });
    else if (status === 'answered') Object.assign(filter, { answeredAt: { $ne: null } });
    else if (status === 'hidden') filter.hidden = true;
    const rows = await this.questionModel.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    const ids = [...new Set(rows.map(r => r.productId))].filter(id => isValidObjectId(id));
    const products = await this.databaseService.repositories.productModel.find({ _id: { $in: ids } }).select('_id name slug images').lean();
    const byId = new Map(products.map((p: any) => [String(p._id), p]));
    const unanswered = await this.questionModel.countDocuments({ storeId, answeredAt: null, hidden: false });
    return {
      success: true,
      data: {
        unanswered,
        questions: rows.map(q => {
          const p: any = byId.get(q.productId);
          return { ...q, productName: p?.name ?? 'Removed product', productSlug: p?.slug ?? null, productImage: p?.images?.[0] ?? null };
        }),
      },
    };
  }

  private async ownedQuestion(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    if (!isValidObjectId(id)) throw new NotFoundException('Question not found');
    const q = await this.questionModel.findOne({ _id: id, storeId });
    if (!q) throw new NotFoundException('Question not found');
    return q;
  }

  async answer(storeId: string, sellerId: string, id: string, body: any) {
    const answer = str(body?.answer, 1500);
    if (answer.length < 2) throw new BadRequestException('Write an answer first');
    const q = await this.ownedQuestion(storeId, sellerId, id);
    const first = !q.answeredAt;
    q.answer = answer;
    q.answeredAt = q.answeredAt ?? new Date();
    q.hidden = false;
    await q.save();
    if (first) {
      const product: any = await this.databaseService.repositories.productModel.findById(q.productId).select('name slug').lean();
      void this.notificationsService.notify({
        recipientId: q.askerId, recipientRole: 'user', type: NOTIFICATION_TYPES.QUESTION_ANSWERED,
        title: 'Your question was answered', body: `${product?.name ?? 'A product'}: ${answer.slice(0, 120)}`,
        data: { productId: q.productId, link: product?.slug ? `/product/${product.slug}#questions` : undefined },
      });
    }
    return { success: true, message: 'Answer published', data: q.toObject() };
  }

  async setHidden(storeId: string, sellerId: string, id: string, hidden: boolean) {
    const q = await this.ownedQuestion(storeId, sellerId, id);
    q.hidden = hidden;
    await q.save();
    return { success: true, message: hidden ? 'Question hidden' : 'Question visible again' };
  }
}
