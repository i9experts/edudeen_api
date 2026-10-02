/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { ProductsService } from '../products/products.service';
import { sanitizeDigitalForPublicView } from '../products/product-public-view.util';
import { SavedList, SavedListDocument } from './schemas/saved-list.schema';

export const MAX_LISTS_PER_USER = 50;
export const MAX_ITEMS_PER_LIST = 200;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function slugFor(name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'list';
  return `${base}-${randomBytes(4).toString('hex')}`;
}

@Injectable()
export class SavedListsService {
  constructor(
    @InjectModel(SavedList.name) private readonly listModel: Model<SavedListDocument>,
    private readonly databaseService: DatabaseService,
    private readonly productsService: ProductsService,
  ) {}

  private async owned(userId: string, id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('List not found');
    const list = await this.listModel.findById(id);
    if (!list) throw new NotFoundException('List not found');
    if (list.userId !== userId) throw new ForbiddenException('This is not your list');
    return list;
  }

  /** The caller's lists with a few cover images, newest activity first. */
  async getMine(userId: string) {
    const lists = await this.listModel.find({ userId }).sort({ updatedAt: -1 }).lean();
    const coverIds = [...new Set(lists.flatMap(l => l.items.slice(-4).map(i => i.productId)))].filter(id => isValidObjectId(id));
    const covers = await this.databaseService.repositories.productModel.find({ _id: { $in: coverIds } }).select('_id images').lean();
    const img = new Map(covers.map((p: any) => [String(p._id), p.images?.[0] ?? null]));
    return {
      success: true,
      data: lists.map(l => ({
        _id: l._id, name: l.name, description: l.description, slug: l.slug, isPublic: l.isPublic,
        itemCount: l.items.length,
        productIds: l.items.map(i => i.productId),
        covers: l.items.slice(-4).reverse().map(i => img.get(i.productId)).filter(Boolean),
        updatedAt: (l as any).updatedAt,
      })),
    };
  }

  async create(userId: string, body: any) {
    const name = str(body?.name, 80);
    if (!name) throw new BadRequestException('Give your list a name');
    const count = await this.listModel.countDocuments({ userId });
    if (count >= MAX_LISTS_PER_USER) throw new BadRequestException(`You can keep up to ${MAX_LISTS_PER_USER} lists`);
    const list = await this.listModel.create({
      userId, name, description: str(body?.description, 300), isPublic: body?.isPublic === true, slug: slugFor(name), items: [],
    });
    if (typeof body?.productId === 'string' && body.productId) await this.addItem(userId, String(list._id), { productId: body.productId });
    return { success: true, message: 'List created', data: await this.listModel.findById(list._id).lean() };
  }

  async update(userId: string, id: string, body: any) {
    const list = await this.owned(userId, id);
    if (body?.name !== undefined) {
      const name = str(body.name, 80);
      if (!name) throw new BadRequestException('Give your list a name');
      list.name = name;
    }
    if (body?.description !== undefined) list.description = str(body.description, 300);
    if (typeof body?.isPublic === 'boolean') list.isPublic = body.isPublic;
    await list.save();
    return { success: true, message: 'List updated', data: list.toObject() };
  }

  async remove(userId: string, id: string) {
    const list = await this.owned(userId, id);
    await list.deleteOne();
    return { success: true, message: 'List deleted' };
  }

  async addItem(userId: string, id: string, body: any) {
    const productId = typeof body?.productId === 'string' ? body.productId : '';
    if (!isValidObjectId(productId)) throw new BadRequestException('Pick a resource to add');
    const exists = await this.databaseService.repositories.productModel.exists({ _id: productId, status: 'active', isDelete: false });
    if (!exists) throw new NotFoundException('That resource is no longer available');
    const list = await this.owned(userId, id);
    if (list.items.some(i => i.productId === productId)) return { success: true, message: 'Already in this list', data: { added: false } };
    if (list.items.length >= MAX_ITEMS_PER_LIST) throw new BadRequestException(`A list can hold up to ${MAX_ITEMS_PER_LIST} resources`);
    list.items.push({ productId, note: str(body?.note, 200), addedAt: new Date() });
    await list.save();
    return { success: true, message: `Added to ${list.name}`, data: { added: true } };
  }

  async updateItemNote(userId: string, id: string, productId: string, body: any) {
    const list = await this.owned(userId, id);
    const item = list.items.find(i => i.productId === productId);
    if (!item) throw new NotFoundException('That resource is not in this list');
    item.note = str(body?.note, 200);
    list.markModified('items');
    await list.save();
    return { success: true, message: 'Note saved' };
  }

  async removeItem(userId: string, id: string, productId: string) {
    const list = await this.owned(userId, id);
    list.items = list.items.filter(i => i.productId !== productId);
    await list.save();
    return { success: true, message: 'Removed from list' };
  }

  /**
   * A list page by its share slug. Private lists are visible only to their
   * owner; everyone else gets the same 404 as a missing slug so private list
   * names don't leak.
   */
  async getBySlug(slug: string, viewerId?: string | null) {
    const list = await this.listModel.findOne({ slug: String(slug ?? '') }).lean();
    const isOwner = !!list && !!viewerId && list.userId === viewerId;
    if (!list || (!list.isPublic && !isOwner)) throw new NotFoundException('List not found');
    const ids = [...list.items].reverse().map(i => i.productId).filter(id => isValidObjectId(id));
    const products = (await this.productsService.getShapedProductsByIds(ids, viewerId ?? null)).map((p: any) => sanitizeDigitalForPublicView(p));
    const notes = new Map(list.items.map(i => [i.productId, i.note]));
    const owner: any = await this.databaseService.repositories.userModel.findById(list.userId).select('name').lean().catch(() => null);
    return {
      success: true,
      data: {
        _id: list._id, name: list.name, description: list.description, slug: list.slug, isPublic: list.isPublic, isOwner,
        ownerName: owner?.name ? String(owner.name).split(' ')[0] : 'A teacher',
        updatedAt: (list as any).updatedAt,
        items: products.map((p: any) => ({ product: p, note: notes.get(String(p._id)) ?? '' })),
      },
    };
  }
}
