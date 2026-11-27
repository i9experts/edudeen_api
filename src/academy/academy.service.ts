/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { escapeRegex } from '../common/query-safety.util';
import { slugifyTitle } from '../common/slug.util';
import { Store, StoreDocument } from '../store/schemas/store.schema';
import { AcademyCourse, AcademyCourseDocument, AcademyProgress, AcademyProgressDocument, ACADEMY_CATEGORIES, type AcademyCategory } from './schemas/academy.schema';
import { ACADEMY_SORTS, applyLessonComplete, cleanCourseInput, sellerVisibilityFilter, sortFor, type AcademySort } from './academy.util';

interface AuditMeta { adminId: string; ip?: string; userAgent?: string }

const LIST_FIELDS = 'title slug summary coverImage category countries language isRecommended viewCount publishedAt lessons._id lessons.durationMinutes';

@Injectable()
export class AcademyService {
  constructor(
    @InjectModel(AcademyCourse.name) private readonly courseModel: Model<AcademyCourseDocument>,
    @InjectModel(AcademyProgress.name) private readonly progressModel: Model<AcademyProgressDocument>,
    @InjectModel(Store.name) private readonly storeModel: Model<StoreDocument>,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private log(action: string, description: string, meta: AuditMeta, targetId?: string) {
    void this.activityLogService.log({
      storeId: 'platform', category: 'academy', action, description,
      actorId: meta.adminId, actorRole: 'admin', targetId, targetType: 'academy_course',
      ip: meta.ip, userAgent: meta.userAgent,
    });
  }

  async uniqueSlug(title: string, excludeId?: string): Promise<string> {
    const base = slugifyTitle(title, 80) || 'course';
    let slug = base;
    for (let i = 2; await this.courseModel.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }); i++) slug = `${base}-${i}`;
    return slug;
  }

  // ── Admin ──────────────────────────────────────────────────────────────
  async adminList(query: { status?: string; search?: string }) {
    const filter: Record<string, unknown> = {};
    if (query.status === 'draft' || query.status === 'published') filter.status = query.status;
    if (query.search) filter.title = { $regex: escapeRegex(String(query.search).slice(0, 100)), $options: 'i' };
    const items = await this.courseModel.find(filter).sort({ order: 1, createdAt: -1 }).select('-lessons.body').lean();
    return { success: true, data: items };
  }

  async adminGet(id: string) {
    const course = await this.courseModel.findById(id).lean();
    if (!course) throw new NotFoundException('Course not found');
    return { success: true, data: course };
  }

  async create(body: Record<string, unknown>, meta: AuditMeta) {
    const input = cleanCourseInput(body, false);
    const course = await this.courseModel.create({ ...input, slug: await this.uniqueSlug(input.title!), status: 'draft', createdBy: meta.adminId });
    this.log('academy_course_created', `Academy course "${course.title}" created`, meta, String(course._id));
    return { success: true, message: 'Course created', data: course };
  }

  async update(id: string, body: Record<string, unknown>, meta: AuditMeta) {
    const existing = await this.courseModel.findById(id);
    if (!existing) throw new NotFoundException('Course not found');
    const input = cleanCourseInput(body, true);
    const set: Record<string, unknown> = { ...input };
    if (input.title && input.title !== existing.title) set.slug = await this.uniqueSlug(input.title, id);
    if (existing.status === 'published' && input.lessons && input.lessons.length === 0) {
      throw new BadRequestException('A published course needs at least one lesson');
    }
    const course = await this.courseModel.findByIdAndUpdate(id, { $set: set }, { returnDocument: 'after' }).lean();
    this.log('academy_course_updated', `Academy course "${course!.title}" updated`, meta, id);
    return { success: true, message: 'Course saved', data: course };
  }

  async setStatus(id: string, status: unknown, meta: AuditMeta) {
    if (status !== 'draft' && status !== 'published') throw new BadRequestException('status must be draft or published');
    const course = await this.courseModel.findById(id);
    if (!course) throw new NotFoundException('Course not found');
    if (status === 'published' && !course.lessons.length) throw new BadRequestException('Add at least one lesson before publishing');
    course.status = status;
    if (status === 'published' && !course.publishedAt) course.publishedAt = new Date();
    await course.save();
    this.log('academy_course_status', `Academy course "${course.title}" set to ${status}`, meta, id);
    return { success: true, message: status === 'published' ? 'Course published' : 'Course moved to drafts', data: course };
  }

  async remove(id: string, meta: AuditMeta) {
    const course = await this.courseModel.findByIdAndDelete(id);
    if (!course) throw new NotFoundException('Course not found');
    await this.progressModel.deleteMany({ courseId: id });
    this.log('academy_course_deleted', `Academy course "${course.title}" deleted`, meta, id);
    return { success: true, message: 'Course deleted' };
  }

  // ── Seller ─────────────────────────────────────────────────────────────
  /** Countries the seller sells from (their stores). No store yet -> only all-country courses. */
  async sellerCountries(sellerId: string): Promise<string[]> {
    const codes = await this.storeModel.distinct('country', { sellerId, isDelete: { $ne: true } });
    return (codes as unknown[]).filter((c): c is string => typeof c === 'string' && !!c);
  }

  async sellerList(sellerId: string, query: { sort?: string; category?: string; search?: string }) {
    const filter: Record<string, unknown> = sellerVisibilityFilter(await this.sellerCountries(sellerId));
    if (query.category && ACADEMY_CATEGORIES.includes(query.category as AcademyCategory)) filter.category = query.category;
    if (query.search) {
      const rx = { $regex: escapeRegex(String(query.search).slice(0, 100)), $options: 'i' };
      filter.$and = [{ $or: [{ title: rx }, { summary: rx }] }];
    }
    const sort = ACADEMY_SORTS.includes(query.sort as AcademySort) ? (query.sort as AcademySort) : 'recommended';
    const [courses, progress] = await Promise.all([
      this.courseModel.find(filter).sort(sortFor(sort)).limit(200).select(LIST_FIELDS).lean(),
      this.progressModel.find({ sellerId }).select('courseId completedLessonIds completedAt').lean(),
    ]);
    const byCourse = new Map(progress.map(p => [p.courseId, p]));
    const data = courses.map(c => {
      const p = byCourse.get(String(c._id));
      const lessonIds = new Set((c.lessons ?? []).map(l => String((l as { _id?: unknown })._id)));
      const done = (p?.completedLessonIds ?? []).filter(id => lessonIds.has(id)).length;
      const minutes = (c.lessons ?? []).reduce((s, l) => s + (l.durationMinutes ?? 0), 0);
      const rest: Record<string, unknown> = { ...c };
      delete rest.lessons;
      return { ...rest, lessonCount: lessonIds.size, totalMinutes: minutes, completedCount: done, completed: !!p?.completedAt };
    });
    return { success: true, data };
  }

  async sellerGet(sellerId: string, slug: string) {
    const filter = { ...sellerVisibilityFilter(await this.sellerCountries(sellerId)), slug: String(slug).slice(0, 120) };
    const course = await this.courseModel.findOneAndUpdate(filter, { $inc: { viewCount: 1 } }, { returnDocument: 'after' }).select('-createdBy').lean();
    if (!course) throw new NotFoundException('Course not found');
    const progress = await this.progressModel.findOneAndUpdate(
      { sellerId, courseId: String(course._id) },
      { $set: { lastViewedAt: new Date() }, $setOnInsert: { completedLessonIds: [], completedAt: null } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    return { success: true, data: { course, progress: { completedLessonIds: progress?.completedLessonIds ?? [], completedAt: progress?.completedAt ?? null } } };
  }

  async completeLesson(sellerId: string, courseId: string, lessonId: string) {
    if (!isValidObjectId(courseId)) throw new NotFoundException('Course not found');
    const filter = { ...sellerVisibilityFilter(await this.sellerCountries(sellerId)), _id: courseId };
    const course = await this.courseModel.findOne(filter).select('lessons._id').lean();
    if (!course) throw new NotFoundException('Course not found');
    const lessonIds = (course.lessons ?? []).map(l => String((l as { _id?: unknown })._id));
    if (!lessonIds.includes(lessonId)) throw new NotFoundException('Lesson not found');
    const existing = await this.progressModel.findOne({ sellerId, courseId }).lean();
    const next = applyLessonComplete(lessonIds, existing?.completedLessonIds ?? [], lessonId);
    const progress = await this.progressModel.findOneAndUpdate(
      { sellerId, courseId },
      { $set: { completedLessonIds: next.completedLessonIds, completedAt: next.done ? (existing?.completedAt ?? new Date()) : null, lastViewedAt: new Date() } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    return { success: true, data: { completedLessonIds: progress?.completedLessonIds ?? [], completedAt: progress?.completedAt ?? null } };
  }
}
