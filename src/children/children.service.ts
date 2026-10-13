/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { EducationLevel } from '../products/schemas/product.schema';
import { canonicalClass, levelForClass } from '../products/class-levels';
import { ChildProfile, ChildProfileDocument } from './children.schema';
import { PremiumEntitlementsService } from '../premium/premium-entitlements.service';

export const MAX_CHILDREN = 8;
const LEVELS = new Set<string>(Object.values(EducationLevel));

export interface ChildInput { name?: unknown; educationLevel?: unknown; gradeLabel?: unknown; age?: unknown; subjects?: unknown }
interface Clean { name: string; educationLevel: string; gradeLabel: string; age: number | null; subjects: string[] }

/** Validates + normalises input. `partial` = PATCH (only provided keys are returned). */
export function cleanChildInput(body: ChildInput, partial = false): Partial<Clean> {
  const out: Partial<Clean> = {};
  let b = body ?? {};
  if (!partial || b.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 1 || name.length > 60) throw new BadRequestException('Child name must be 1-60 characters');
    out.name = name;
  }
  // gradeLabel is now a class value (class-3). Known classes derive the level; free text from before is kept as typed.
  const cls = b.gradeLabel !== undefined ? canonicalClass(b.gradeLabel) : null;
  if (cls) b = { ...b, educationLevel: levelForClass(cls) ?? b.educationLevel };
  if (!partial || b.educationLevel !== undefined) {
    if (typeof b.educationLevel !== 'string' || !LEVELS.has(b.educationLevel)) throw new BadRequestException('Choose a valid level');
    out.educationLevel = b.educationLevel;
  }
  if (b.gradeLabel !== undefined) {
    const g = typeof b.gradeLabel === 'string' ? b.gradeLabel.trim() : '';
    if (g.length > 30) throw new BadRequestException('Class label is too long (max 30)');
    out.gradeLabel = cls ?? g;
  }
  if (b.age !== undefined) {
    if (b.age === null || b.age === '') out.age = null;
    else {
      const n = Number(b.age);
      if (!Number.isInteger(n) || n < 2 || n > 25) throw new BadRequestException('Age must be a whole number between 2 and 25');
      out.age = n;
    }
  }
  if (b.subjects !== undefined) {
    if (!Array.isArray(b.subjects) || b.subjects.length > 10) throw new BadRequestException('At most 10 subjects');
    const subs = b.subjects.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
    if (subs.some((s) => s.length > 40)) throw new BadRequestException('Subject is too long (max 40)');
    out.subjects = [...new Set(subs)];
  }
  return out;
}

@Injectable()
export class ChildrenService {
  constructor(
    @InjectModel(ChildProfile.name) private readonly model: Model<ChildProfileDocument>,
    // Edudeen Premium raises the limit (default 15 vs 8). Absent = the standard limit.
    @Optional() private readonly premium?: PremiumEntitlementsService,
  ) {}

  async list(userId: string) {
    const rows = await this.model.find({ userId }).sort({ createdAt: 1 }).lean();
    return { success: true, data: rows };
  }

  async create(userId: string, body: ChildInput) {
    const data = cleanChildInput(body);
    const limit = this.premium ? (await this.premium.getEntitlements(userId)).childrenLimit : MAX_CHILDREN;
    if ((await this.model.countDocuments({ userId })) >= limit) {
      throw new BadRequestException(`You can save up to ${limit} children`);
    }
    const row = await this.model.create({ ...data, userId });
    return { success: true, data: row.toObject ? row.toObject() : row };
  }

  async update(userId: string, id: string, body: ChildInput) {
    if (!isValidObjectId(id)) throw new NotFoundException('Child not found');
    const data = cleanChildInput(body, true);
    const row = await this.model.findOneAndUpdate({ _id: id, userId }, { $set: data }, { new: true }).lean();
    if (!row) throw new NotFoundException('Child not found');
    return { success: true, data: row };
  }

  async remove(userId: string, id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Child not found');
    const res = await this.model.deleteOne({ _id: id, userId });
    if (!res.deletedCount) throw new NotFoundException('Child not found');
    return { success: true, data: { deleted: true } };
  }
}
