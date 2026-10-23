import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { HomeCard, HomeCardDocument } from './schemas/home-card.schema';
import { CreateHomeCardDto, HomeCardTileDto, UpdateHomeCardDto } from './dto/home-card.dto';
import { isSafeLinkTarget } from '../common/link-target.util';

const MAX_CARDS = 60;

function cleanLink(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (!isSafeLinkTarget(v)) throw new BadRequestException('link must be an in-site path (starting with /) or an http(s) URL');
  return String(v).trim();
}

function cleanImage(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  try {
    if (new URL(String(v)).protocol === 'https:') return String(v).trim();
  } catch {
    /* fall through */
  }
  throw new BadRequestException('imageUrl must be an https URL');
}

function cleanTiles(tiles: HomeCardTileDto[] | undefined) {
  return (tiles ?? []).slice(0, 4).map((t) => ({
    label: (t.label ?? '').trim().slice(0, 40),
    imageUrl: cleanImage(t.imageUrl),
    link: cleanLink(t.link),
  }));
}

@Injectable()
export class HomeCardsService {
  constructor(@InjectModel(HomeCard.name) private readonly model: Model<HomeCardDocument>) {}

  /** Public: active cards in admin order. */
  async listPublic() {
    const data = await this.model.find({ status: 'active' }).sort({ order: 1, createdAt: 1 }).lean();
    return { success: true, count: data.length, data };
  }

  async listAdmin() {
    const data = await this.model.find({}).sort({ order: 1, createdAt: 1 }).lean();
    return { success: true, count: data.length, data };
  }

  async create(dto: CreateHomeCardDto) {
    if ((await this.model.estimatedDocumentCount()) >= MAX_CARDS) {
      throw new BadRequestException(`You can have at most ${MAX_CARDS} home cards`);
    }
    const last = await this.model.findOne({}).sort({ order: -1 }).select('order').lean();
    const doc = await this.model.create({
      title: dto.title.trim(),
      layout: dto.layout ?? 'grid4',
      tiles: cleanTiles(dto.tiles),
      imageUrl: cleanImage(dto.imageUrl),
      link: cleanLink(dto.link),
      ctaLabel: (dto.ctaLabel ?? '').trim(),
      status: dto.status ?? 'active',
      order: last ? (last.order ?? 0) + 1 : 0,
    });
    return { success: true, data: doc.toObject() };
  }

  async update(id: string, dto: UpdateHomeCardDto) {
    const set: Record<string, unknown> = {};
    if (dto.title !== undefined) set.title = dto.title.trim();
    if (dto.layout !== undefined) set.layout = dto.layout;
    if (dto.tiles !== undefined) set.tiles = cleanTiles(dto.tiles);
    if (dto.imageUrl !== undefined) set.imageUrl = cleanImage(dto.imageUrl);
    if (dto.link !== undefined) set.link = cleanLink(dto.link);
    if (dto.ctaLabel !== undefined) set.ctaLabel = dto.ctaLabel.trim();
    if (dto.status !== undefined) set.status = dto.status;
    if (dto.order !== undefined) set.order = dto.order;
    const doc = await this.model.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
    if (!doc) throw new NotFoundException('Home card not found');
    return { success: true, data: doc };
  }

  async remove(id: string) {
    const res = await this.model.deleteOne({ _id: id });
    if (!res.deletedCount) throw new NotFoundException('Home card not found');
    return { success: true };
  }

  /** ids = the full desired order (first = top). */
  async reorder(ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Duplicate ids');
    await this.model.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: i } } } })));
    return { success: true };
  }
}