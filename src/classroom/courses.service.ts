/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { UploadService } from '../upload/upload.service';
import { UploadedAssetsService } from '../upload/uploaded-assets.service';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { CourseProgress, CourseProgressDocument } from './schemas/course.schema';
import { certificateCode, cleanCourseInput, lessonIds, paidSeatFilter, scoreQuiz } from './course.util';

const LESSON_LINK_SECONDS = 3600;

@Injectable()
export class CoursesService {
  constructor(
    @InjectModel(CourseProgress.name) private readonly progressModel: Model<CourseProgressDocument>,
    private readonly databaseService: DatabaseService,
    private readonly uploadService: UploadService,
    private readonly uploadedAssets: UploadedAssetsService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private async findProduct(idOrSlug: string) {
    let product: any = await this.r.productModel.findOne({ slug: idOrSlug, isDelete: false }).lean();
    if (!product && isValidObjectId(idOrSlug)) product = await this.r.productModel.findOne({ _id: idOrSlug, isDelete: false }).lean();
    if (!product) throw new NotFoundException('Course not found');
    return product;
  }

  /** True when this user has a paid, non-refunded order line for the product. */
  async hasPurchased(userId: string, productId: string) {
    const order = await this.r.orderModel.findOne({ ...paidSeatFilter(productId), userId }).select('_id').lean();

    return !!order;
  }

  private async assertLearner(userId: string, product: any) {
    if (product.removedByAdmin) throw new NotFoundException('This course is no longer available');
    if (String(product.sellerId) === userId) return; // the teacher can always view their own course
    if (!(await this.hasPurchased(userId, String(product._id)))) throw new ForbiddenException('Buy this course to start learning');
  }

  // ── Seller: course builder ────────────────────────────────────────────────

  private async sellerProduct(storeId: string, sellerId: string, productId: string) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    if (!isValidObjectId(productId)) throw new NotFoundException('Product not found');
    const product: any = await this.r.productModel.findOne({ _id: productId, storeId, isDelete: false }).lean();
    if (!product) throw new NotFoundException('Product not found');
    if (product.type !== 'digital') throw new BadRequestException('Only digital products can be courses');
    return product;
  }

  async getForSeller(storeId: string, sellerId: string, productId: string) {
    const product = await this.sellerProduct(storeId, sellerId, productId);
    const course: any = await this.r.courseModel.findOne({ productId }).lean();
    return {
      success: true,
      data: {
        product: { _id: String(product._id), name: product.name, slug: product.slug, status: product.status, deliveryFormat: product.deliveryFormat ?? 'download' },
        sections: course?.sections ?? [],
        certificateEnabled: course?.certificateEnabled ?? true,
        learners: await this.progressModel.countDocuments({ productId }),
      },
    };
  }

  async saveForSeller(storeId: string, sellerId: string, productId: string, body: any) {
    const product = await this.sellerProduct(storeId, sellerId, productId);
    const { sections, certificateEnabled, fileRefs } = cleanCourseInput(body);
    const existing: any = await this.r.courseModel.findOne({ productId }).lean();
    const knownFiles = new Map<string, any>();
    for (const s of existing?.sections ?? []) for (const l of s.lessons ?? []) if (l.file?.url) knownFiles.set(l.file.url, l.file);

    // Every file must be one this seller uploaded; size/type come from our upload record.
    const trusted = new Map<string, { size: number | null; mimeType: string | null }>();
    for (const ref of fileRefs) {
      const known = knownFiles.get(ref.url);
      const t = await this.uploadedAssets.assertOwned(sellerId, ref.url, 'digital_product', { alreadyReferenced: !!known });
      trusted.set(ref.url, { size: t?.fileSize ?? known?.size ?? null, mimeType: t?.mimeType ?? known?.mimeType ?? null });
    }
    for (const s of sections) for (const l of s.lessons) if (l.file) Object.assign(l.file, trusted.get(l.file.url) ?? {});

    const totalLessons = sections.reduce((n, s) => n + s.lessons.length, 0);
    if (!totalLessons && ['active', 'pending_review', 'scheduled'].includes(product.status) && product.deliveryFormat === 'course') {
      throw new BadRequestException('A published course needs at least one lesson — unpublish it first to empty it');
    }
    await this.r.courseModel.findOneAndUpdate(
      { productId },
      { $set: { sections, certificateEnabled, storeId, sellerId } },
      { upsert: true, returnDocument: 'after' },
    );
    if (product.deliveryFormat !== 'course') await this.r.productModel.updateOne({ _id: productId }, { $set: { deliveryFormat: 'course', liveSession: null } });
    return { success: true, message: 'Course saved', data: { sections, certificateEnabled } };
  }

  // ── Public outline (product page "Course content") ─────────────────────────

  async outline(idOrSlug: string) {
    const product = await this.findProduct(idOrSlug);
    if (product.status !== 'active') throw new NotFoundException('Course not found');
    const course: any = await this.r.courseModel.findOne({ productId: String(product._id) }).lean();
    const sections = (course?.sections ?? []).map((s: any) => ({
      _id: s._id, title: s.title,
      lessons: s.lessons.map((l: any) => ({ _id: l._id, title: l.title, type: l.type, durationMinutes: l.durationMinutes, isPreview: l.isPreview })),
    }));
    const lessons = sections.reduce((n: number, s: any) => n + s.lessons.length, 0);
    const minutes = sections.reduce((n: number, s: any) => n + s.lessons.reduce((m: number, l: any) => m + (l.durationMinutes ?? 0), 0), 0);
    return { success: true, data: { sections, lessons, minutes, certificateEnabled: course?.certificateEnabled ?? false } };
  }

  /** A lesson marked "free preview" — playable by anyone, no purchase needed. */
  async previewLesson(idOrSlug: string, lessonId: string) {
    const product = await this.findProduct(idOrSlug);
    if (product.status !== 'active') throw new NotFoundException('Course not found');
    const lesson = await this.findLesson(String(product._id), lessonId);
    if (!lesson.isPreview) throw new ForbiddenException('Buy this course to watch this lesson');
    return { success: true, data: this.shapeLesson(lesson) };
  }

  // ── Learner ───────────────────────────────────────────────────────────────

  private async findLesson(productId: string, lessonId: string) {
    const course: any = await this.r.courseModel.findOne({ productId }).lean();
    for (const s of course?.sections ?? []) for (const l of s.lessons ?? []) if (l._id === lessonId) return l;
    throw new NotFoundException('Lesson not found');
  }

  private shapeLesson(l: any) {
    const base = { _id: l._id, title: l.title, type: l.type, text: l.text ?? '', durationMinutes: l.durationMinutes };
    if ((l.type === 'video' || l.type === 'pdf') && l.file?.url) {
      const mime = this.uploadService.resolveMimeType(l.file.name ?? '', l.file.mimeType ?? (l.type === 'pdf' ? 'application/pdf' : 'video/mp4'));
      const resourceType = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : 'raw';
      return { ...base, file: { name: l.file.name, mimeType: mime, url: this.uploadService.generateSignedUrl(l.file.url, resourceType, LESSON_LINK_SECONDS, l.file.name, true) } };
    }
    if (l.type === 'quiz' && l.quiz) {
      // Never send the answers before an attempt.
      return { ...base, quiz: { passPercent: l.quiz.passPercent, questions: l.quiz.questions.map((q: any) => ({ question: q.question, options: q.options })) } };
    }
    return base;
  }

  async getLearnView(userId: string, idOrSlug: string) {
    const product = await this.findProduct(idOrSlug);
    await this.assertLearner(userId, product);
    const productId = String(product._id);
    const course: any = await this.r.courseModel.findOne({ productId }).lean();
    if (!course) throw new NotFoundException('The teacher is still preparing this course');
    const progress: any = await this.progressModel.findOne({ userId, productId }).lean();
    const store: any = await this.r.storeModel.findById(product.storeId).select('name slug').lean();
    return {
      success: true,
      data: {
        product: { _id: productId, name: product.name, slug: product.slug, image: product.images?.[0] ?? null, storeName: store?.name ?? null, storeSlug: store?.slug ?? null },
        sections: course.sections.map((s: any) => ({ _id: s._id, title: s.title, lessons: s.lessons.map((l: any) => ({ _id: l._id, title: l.title, type: l.type, durationMinutes: l.durationMinutes })) })),
        certificateEnabled: course.certificateEnabled,
        progress: {
          completedLessonIds: progress?.completedLessonIds ?? [],
          quizScores: progress?.quizScores ?? {},
          lastLessonId: progress?.lastLessonId ?? null,
          completedAt: progress?.completedAt ?? null,
          certificateCode: progress?.certificateCode ?? null,
        },
      },
    };
  }

  async getLesson(userId: string, idOrSlug: string, lessonId: string) {
    const product = await this.findProduct(idOrSlug);
    await this.assertLearner(userId, product);
    const lesson = await this.findLesson(String(product._id), lessonId);
    await this.progressModel.updateOne({ userId, productId: String(product._id) }, { $set: { lastLessonId: lessonId } }, { upsert: true });
    return { success: true, data: this.shapeLesson(lesson) };
  }

  /** Records a finished lesson; issues the certificate when it was the last one. */
  private async complete(userId: string, product: any, lessonId: string, quizScore?: number) {
    const productId = String(product._id);
    const update: any = { $addToSet: { completedLessonIds: lessonId }, $set: { lastLessonId: lessonId } };
    if (quizScore !== undefined) update.$set[`quizScores.${lessonId}`] = quizScore;
    const progress: any = await this.progressModel.findOneAndUpdate({ userId, productId }, update, { upsert: true, returnDocument: 'after' }).lean();
    const course: any = await this.r.courseModel.findOne({ productId }).lean();
    const all = lessonIds(course?.sections ?? []);
    const done = all.length > 0 && all.every(id => progress.completedLessonIds.includes(id));
    if (done && !progress.completedAt) {
      const set: any = { completedAt: new Date() };
      if (course?.certificateEnabled) {
        const user: any = await this.r.userModel.findById(userId).select('name').lean().catch(() => null);
        set.certificateCode = certificateCode();
        set.learnerName = user?.name ?? 'Learner';
      }
      await this.progressModel.updateOne({ _id: progress._id, completedAt: null }, { $set: set });
      Object.assign(progress, set);
    }
    return { completedLessonIds: progress.completedLessonIds, completedAt: progress.completedAt ?? null, certificateCode: progress.certificateCode ?? null };
  }

  async markComplete(userId: string, idOrSlug: string, lessonId: string) {
    const product = await this.findProduct(idOrSlug);
    await this.assertLearner(userId, product);
    const lesson = await this.findLesson(String(product._id), lessonId);
    if (lesson.type === 'quiz') throw new BadRequestException('Pass the quiz to complete this lesson');
    return { success: true, data: await this.complete(userId, product, lessonId) };
  }

  async submitQuiz(userId: string, idOrSlug: string, lessonId: string, answers: unknown) {
    const product = await this.findProduct(idOrSlug);
    await this.assertLearner(userId, product);
    const lesson = await this.findLesson(String(product._id), lessonId);
    if (lesson.type !== 'quiz' || !lesson.quiz) throw new BadRequestException('This lesson is not a quiz');
    const result = scoreQuiz(lesson.quiz, answers);
    const progress = result.passed ? await this.complete(userId, product, lessonId, result.percent) : null;
    return {
      success: true,
      message: result.passed ? `Passed — ${result.percent}%` : `${result.percent}% — you need ${lesson.quiz.passPercent}% to pass. Try again.`,
      data: { ...result, passPercent: lesson.quiz.passPercent, answers: lesson.quiz.questions.map((q: any) => q.answerIndex), progress },
    };
  }

  /** Public certificate check — anyone with the code (an employer, a school) can verify it. */
  async verifyCertificate(code: string) {
    const p: any = await this.progressModel.findOne({ certificateCode: String(code ?? '').toUpperCase() }).lean();
    if (!p) throw new NotFoundException('No certificate with that code');
    const product: any = await this.r.productModel.findById(p.productId).select('name slug storeId').lean();
    const store: any = product ? await this.r.storeModel.findById(product.storeId).select('name slug').lean() : null;
    return {
      success: true,
      data: { code: p.certificateCode, learnerName: p.learnerName, courseName: product?.name ?? 'Course', courseSlug: product?.slug ?? null, teacher: store?.name ?? null, storeSlug: store?.slug ?? null, completedAt: p.completedAt },
    };
  }

  /** My courses — every course product the buyer owns, with progress. */
  async myCourses(userId: string) {
    const orders: any[] = await this.r.orderModel.find({ userId, isDelete: false, isPaid: true }).select('sellerOrders.items').lean();
    const ids = new Set<string>();
    for (const o of orders) for (const so of o.sellerOrders ?? []) for (const it of so.items ?? []) if (!['cancelled', 'refunded'].includes(it.status)) ids.add(String(it.productId));
    const valid = [...ids].filter(id => isValidObjectId(id));
    const products: any[] = await this.r.productModel.find({ _id: { $in: valid }, deliveryFormat: { $in: ['course', 'live_class'] }, removedByAdmin: { $ne: true } }).select('_id name slug images deliveryFormat liveSession storeId').lean();
    const courseIds = products.filter(p => p.deliveryFormat === 'course').map(p => String(p._id));
    const [courses, progress] = await Promise.all([
      this.r.courseModel.find({ productId: { $in: courseIds } }).select('productId sections').lean(),
      this.progressModel.find({ userId, productId: { $in: courseIds } }).lean(),
    ]);
    const total = new Map(courses.map((c: any) => [c.productId, lessonIds(c.sections).length]));
    const prog = new Map(progress.map((p: any) => [p.productId, p]));
    return {
      success: true,
      data: products.map(p => {
        const id = String(p._id);
        const pr: any = prog.get(id);
        return {
          productId: id, name: p.name, slug: p.slug, image: p.images?.[0] ?? null, deliveryFormat: p.deliveryFormat,
          lessons: total.get(id) ?? 0, completed: pr?.completedLessonIds?.length ?? 0, completedAt: pr?.completedAt ?? null, certificateCode: pr?.certificateCode ?? null,
          liveSession: p.deliveryFormat === 'live_class' && p.liveSession ? { startsAt: p.liveSession.startsAt, durationMinutes: p.liveSession.durationMinutes, platform: p.liveSession.platform } : null,
        };
      }),
    };
  }

  /** The meeting link of a live class — buyers (and the teacher) only. */
  async liveAccess(userId: string, idOrSlug: string) {
    const product = await this.findProduct(idOrSlug);
    if (product.deliveryFormat !== 'live_class' || !product.liveSession) throw new NotFoundException('This is not a live class');
    await this.assertLearner(userId, product);
    const { startsAt, durationMinutes, platform, meetingUrl, notes } = product.liveSession;
    const endsAt = new Date(new Date(startsAt).getTime() + durationMinutes * 60000);
    return { success: true, data: { name: product.name, startsAt, endsAt, durationMinutes, platform, meetingUrl, notes, ended: endsAt.getTime() < Date.now() } };
  }

  /** Seats left in a live class, for the product page. */
  async seats(idOrSlug: string) {
    const product = await this.findProduct(idOrSlug);
    const capacity = product.liveSession?.capacity ?? null;
    if (product.deliveryFormat !== 'live_class' || !capacity) return { success: true, data: { capacity: null, left: null } };
    const taken = await this.r.orderModel.countDocuments(paidSeatFilter(String(product._id)));
    return { success: true, data: { capacity, left: Math.max(0, capacity - taken) } };
  }
}
