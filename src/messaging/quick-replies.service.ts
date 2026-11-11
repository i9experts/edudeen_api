/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';
import { QuickReply, QuickReplyDocument } from './schemas/quick-reply.schema';
import { DEFAULT_QUICK_REPLIES, QUICK_REPLY_MAX } from './quick-replies.util';

const MAX_MSG = `Maximum ${QUICK_REPLY_MAX} quick replies`;

@Injectable()
export class QuickRepliesService {
  constructor(
    private readonly db: DatabaseService,
    @InjectModel(QuickReply.name) private readonly model: Model<QuickReplyDocument>,
  ) {}

  private get stores() { return this.db.repositories.storeModel; }

  private async assertOwner(storeId: string, sellerId: string) {
    const store = await this.stores.findOne({ _id: storeId, sellerId, isDelete: false }).select('_id').lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
  }

  // First list only: an atomic flag claim means two parallel first calls seed once, and a deleted default never returns.
  private async seedOnce(storeId: string) {
    const claimed = await this.stores.findOneAndUpdate(
      { _id: storeId, quickRepliesSeeded: { $ne: true } },
      { $set: { quickRepliesSeeded: true } },
      { projection: { _id: 1 } },
    );
    if (!claimed) return;
    try {
      if (await this.model.exists({ storeId })) return;
      await this.model.insertMany(DEFAULT_QUICK_REPLIES.map((d, i) => ({ ...d, storeId, sortOrder: i, isDefault: true })));
    } catch {
      await this.stores.updateOne({ _id: storeId }, { $set: { quickRepliesSeeded: false } }).catch(() => undefined);
    }
  }

  async list(sellerId: string, storeId: string) {
    await this.assertOwner(storeId, sellerId);
    await this.seedOnce(storeId);
    const replies = await this.model.find({ storeId }).sort({ sortOrder: 1, _id: 1 }).limit(QUICK_REPLY_MAX).lean();
    return { replies, max: QUICK_REPLY_MAX };
  }

  async create(sellerId: string, dto: { storeId: string; title: string; body: string; category: string }) {
    await this.assertOwner(dto.storeId, sellerId);
    if ((await this.model.countDocuments({ storeId: dto.storeId })) >= QUICK_REPLY_MAX) throw new BadRequestException(MAX_MSG);
    const last = await this.model.findOne({ storeId: dto.storeId }).sort({ sortOrder: -1 }).select('sortOrder').lean();
    const doc: any = await this.model.create({
      storeId: dto.storeId, title: dto.title, body: dto.body, category: dto.category,
      sortOrder: (last?.sortOrder ?? -1) + 1, isDefault: false,
    } as any);
    // Race guard: parallel creates can pass the check together, so keep the oldest N and hand the extra one back.
    const keep = await this.model.find({ storeId: dto.storeId }).sort({ _id: 1 }).limit(QUICK_REPLY_MAX).select('_id').lean();
    if (!keep.some(k => String(k._id) === String(doc._id))) {
      await this.model.deleteOne({ _id: doc._id });
      throw new BadRequestException(MAX_MSG);
    }
    return doc.toObject();
  }

  async update(sellerId: string, id: string, dto: { storeId: string; title?: string; body?: string; category?: string }) {
    await this.assertOwner(dto.storeId, sellerId);
    const set: Record<string, string> = {};
    if (dto.title !== undefined) set.title = dto.title;
    if (dto.body !== undefined) set.body = dto.body;
    if (dto.category !== undefined) set.category = dto.category;
    const doc = await this.model.findOneAndUpdate({ _id: id, storeId: dto.storeId }, { $set: set }, { new: true }).lean();
    if (!doc) throw new NotFoundException('Quick reply not found');
    return doc;
  }

  async remove(sellerId: string, id: string, storeId: string) {
    await this.assertOwner(storeId, sellerId);
    const res = await this.model.deleteOne({ _id: id, storeId });
    if (!res.deletedCount) throw new NotFoundException('Quick reply not found');
    return { success: true };
  }
}
