/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { UploadService } from '../upload/upload.service';
import { UploadedAssetsService } from '../upload/uploaded-assets.service';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { CourseProgress, CourseProgressDocument } from './schemas/course.schema';
import { accessDaysAt, accessExpiry, nextAccessDaysLog,certificateCode, cleanCertificateConfig, cleanCertificateDetails, cleanCourseInput, EMPTY_CERT_CONFIG, courseTotals, lessonIds, paidSeatFilter, scoreQuiz } from './course.util';

import { buildRosterView, maskRosterEmail, parseRosterQuery, rosterCsvRows, ROSTER_CSV_HEADER, ROSTER_EXPORT_CAP, ROSTER_GROUP_CAP, type RosterRow } from './students-roster.util';
import { toExportCsv } from '../common/csv-export.util';

const LESSON_LINK_SECONDS = 3600;

@Injectable()
export class CoursesService {
  constructor(
    @InjectModel(CourseProgress.name) private readonly progressModel: Model<CourseProgressDocument>,
    private readonly databaseService: DatabaseService,
    private readonly uploadService: UploadService,
    private readonly uploadedAssets: UploadedAssetsService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly activityLog?: ActivityLogService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private async findProduct(idOrSlug: string) {
    let product: any = await this.r.productModel.findOne({ slug: idOrSlug, isDelete: false, isTest: { $ne: true } }).lean();
    if (!product && isValidObjectId(idOrSlug)) product = await this.r.productModel.findOne({ _id: idOrSlug, isDelete: false, isTest: { $ne: true } }).lean();
    if (!product) throw new NotFoundException('Course not found');
    return product;
  }

  /**
   * Learner-side lookup: a course the seller has since deleted (or switched to draft / paid / free) is still found,
   * because buyers keep it until THEIR own access window ends. `assertLearner` then decides who may open it.
   */
  private async findLearnerProduct(idOrSlug: string) {
    let product: any = await this.r.productModel.findOne({ slug: idOrSlug, isTest: { $ne: true } }).sort({ isDelete: 1 }).lean();
    if (!product && isValidObjectId(idOrSlug)) product = await this.r.productModel.findOne({ _id: idOrSlug, isTest: { $ne: true } }).lean();
    if (!product) throw new NotFoundException('Course not found');
    return product;
  }

  /** True when this user has a paid, non-refunded order line for the product. */
  async hasPurchased(userId: string, productId: string) {
    const order = await this.r.orderModel.findOne({ ...paidSeatFilter(productId), userId }).select('_id').lean();

    return !!order;
  }

  /** Latest paid, non-refunded purchase date of this product by this user (null = never bought). */
  private async lastPurchaseAt(userId: string, productId: string): Promise<Date | null> {
    const orders: any[] = await this.r.orderModel.find({ ...paidSeatFilter(productId), userId }).select('paidAt createdAt').lean();
    if (!orders.length) return null;
    return new Date(Math.max(...orders.map(o => new Date(o.paidAt ?? o.createdAt).getTime())));
  }

  private async assertLearner(userId: string, product: any) {
    if (product.removedByAdmin) throw new NotFoundException('This course is no longer available');
    if (String(product.sellerId) === userId) return; // the teacher can always view their own course
    const boughtAt = await this.lastPurchaseAt(userId, String(product._id));
    // A deleted course only exists for people who bought it.
    if (!boughtAt && product.isDelete) throw new NotFoundException('Course not found');
    if (!boughtAt) throw new ForbiddenException('Buy this course to start learning');
    if (product.deliveryFormat === 'course') {
      const course: any = await this.r.courseModel.findOne({ productId: String(product._id) }).select('accessDays accessDaysLog').lean();
      // The length that applied on the day they bought, not whatever the seller set later.
      const until = accessExpiry(boughtAt, accessDaysAt(course, boughtAt));
      if (until && until.getTime() < Date.now()) throw new ForbiddenException('Your access to this course has ended');
    }
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
        outcomes: course?.outcomes ?? [],
        instructor: course?.instructor ?? { name: '', bio: '' },
        accessDays: course?.accessDays ?? null,
        certificateConfig: { ...EMPTY_CERT_CONFIG, ...(course?.certificateConfig ?? {}) },
        learners: await this.progressModel.countDocuments({ productId }),
      },
    };
  }

  async saveForSeller(storeId: string, sellerId: string, productId: string, body: any) {
    const product = await this.sellerProduct(storeId, sellerId, productId);
    const { sections, certificateEnabled, fileRefs, outcomes, instructor, accessDays } = cleanCourseInput(body);
    // Validated before anything is written; only touched when the request carries it (null clears).
    const certificateConfig = body?.certificateConfig !== undefined ? cleanCertificateConfig(body.certificateConfig) : undefined;
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
    // Changing the access length never touches people who already bought: the log says which length applied from when.
    const accessLog = body?.accessDays !== undefined ? nextAccessDaysLog(existing, accessDays) : null;
    await this.r.courseModel.findOneAndUpdate(
      { productId },
      // Outcomes / instructor / access length are only written when the request carries them (older clients keep what is stored).
      { $set: { sections, certificateEnabled, storeId, sellerId, ...(body?.outcomes !== undefined ? { outcomes } : {}), ...(body?.instructor !== undefined ? { instructor } : {}), ...(body?.accessDays !== undefined ? { accessDays } : {}), ...(accessLog ? { accessDaysLog: accessLog } : {}), ...(certificateConfig ? { certificateConfig } : {}) } },
      { upsert: true, returnDocument: 'after' },
    );
    if (product.deliveryFormat !== 'course') await this.r.productModel.updateOne({ _id: productId }, { $set: { deliveryFormat: 'course' } });
    return { success: true, message: 'Course saved', data: { sections, certificateEnabled, outcomes, instructor, accessDays, certificateConfig: certificateConfig ?? { ...EMPTY_CERT_CONFIG, ...(existing?.certificateConfig ?? {}) } } };
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
    const { lessonCount, totalMinutes } = courseTotals(sections);
    return {
      success: true,
      data: {
        sections, lessons: lessonCount, minutes: totalMinutes, lessonCount, totalMinutes,
        certificateEnabled: course?.certificateEnabled ?? false,
        outcomes: course?.outcomes ?? [],
        instructor: course?.instructor ?? { name: '', bio: '' },
        accessDays: course?.accessDays ?? null,
      },
    };
  }

  /** A lesson marked "free preview" — playable by anyone, no purchase needed. */
  async previewLesson(idOrSlug: string, lessonId: string) {
    const product = await this.findProduct(idOrSlug);
    if (product.status !== 'active') throw new NotFoundException('Course not found');
    if (product.removedByAdmin) throw new NotFoundException('Course not found');
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
    if (l.type === 'video' && l.videoUrl && !l.file?.url) {
      // External (YouTube / Vimeo) video: no file of ours to sign.
      return { ...base, videoUrl: l.videoUrl, media: { kind: 'external', url: l.videoUrl } };
    }
    if ((l.type === 'video' || l.type === 'pdf') && l.file?.url) {
      const mime = this.uploadService.resolveMimeType(l.file.name ?? '', l.file.mimeType ?? (l.type === 'pdf' ? 'application/pdf' : 'video/mp4'));
      const resourceType = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : 'raw';
      const url = this.uploadService.generateSignedUrl(l.file.url, resourceType, LESSON_LINK_SECONDS, l.file.name, true);
      return { ...base, file: { name: l.file.name, mimeType: mime, url }, media: { kind: 'file', url } };
    }
    if (l.type === 'quiz' && l.quiz) {
      // Never send the answers before an attempt.
      return { ...base, quiz: { passPercent: l.quiz.passPercent, questions: l.quiz.questions.map((q: any) => ({ question: q.question, options: q.options })) } };
    }
    return base;
  }

  async getLearnView(userId: string, idOrSlug: string) {
    const product = await this.findLearnerProduct(idOrSlug);
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
        certificateDetails: progress?.certificateDetails ?? null,
        certificateDetailsRequired: !!course.certificateEnabled && !progress?.certificateDetails && !progress?.certificateCode,
        outcomes: course.outcomes ?? [],
        instructor: course.instructor ?? { name: '', bio: '' },
        accessExpiresAt: String(product.sellerId) === userId ? null : accessExpiry(await this.lastPurchaseAt(userId, productId), accessDaysAt(course, await this.lastPurchaseAt(userId, productId))),
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
    const product = await this.findLearnerProduct(idOrSlug);
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
      // The certificate is only issued once the learner has filled the details form; until then it waits (saveCertificateDetails issues it).
      if (course?.certificateEnabled && progress.certificateDetails?.fullName) {
        set.certificateCode = certificateCode();
        set.learnerName = progress.certificateDetails.fullName;
      }
      const claimed: any = await this.progressModel.updateOne({ _id: progress._id, completedAt: null }, { $set: set });
      if (claimed?.modifiedCount !== 0) Object.assign(progress, set);
    }
    return {
      completedLessonIds: progress.completedLessonIds, completedAt: progress.completedAt ?? null, certificateCode: progress.certificateCode ?? null,
      certificateDetailsRequired: !!course?.certificateEnabled && !progress.certificateDetails && !progress.certificateCode,
    };
  }

  async markComplete(userId: string, idOrSlug: string, lessonId: string) {
    const product = await this.findLearnerProduct(idOrSlug);
    await this.assertLearner(userId, product);
    const lesson = await this.findLesson(String(product._id), lessonId);
    if (lesson.type === 'quiz') throw new BadRequestException('Pass the quiz to complete this lesson');
    return { success: true, data: await this.complete(userId, product, lessonId) };
  }

  async submitQuiz(userId: string, idOrSlug: string, lessonId: string, answers: unknown) {
    const product = await this.findLearnerProduct(idOrSlug);
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

  /**
   * The learner's "certificate details" form. Allowed for enrolled learners only and only until the certificate exists
   * (it is printed from these details, so it cannot change afterwards). If the course is already finished the certificate is issued now.
   */
  async saveCertificateDetails(userId: string, idOrSlug: string, body: unknown) {
    const product = await this.findLearnerProduct(idOrSlug);
    await this.assertLearner(userId, product);
    const productId = String(product._id);
    const course: any = await this.r.courseModel.findOne({ productId }).lean();
    if (!course) throw new NotFoundException('The teacher is still preparing this course');
    if (!course.certificateEnabled) throw new BadRequestException('This course does not issue certificates');
    const details = cleanCertificateDetails(body);
    // Atomic: only while no certificate has been issued (a missing/null code both match `null`).
    const res: any = await this.progressModel.findOneAndUpdate(
      { userId, productId, certificateCode: null },
      { $set: { certificateDetails: details } },
      { upsert: true, returnDocument: 'after' },
    ).lean().catch((e: any) => {
      if (e?.code === 11000) return null; // upsert collided with an existing row that already has a certificate
      throw e;
    });
    if (!res) throw new ConflictException('Your certificate has already been issued, so these details can no longer be changed');
    let code: string | null = null;
    const all = lessonIds(course.sections ?? []);
    const finished = all.length > 0 && all.every(id => (res.completedLessonIds ?? []).includes(id));
    if (finished) {
      const set: any = { certificateCode: certificateCode(), learnerName: details.fullName };
      if (!res.completedAt) set.completedAt = new Date();
      const issued: any = await this.progressModel.updateOne({ _id: res._id, certificateCode: null }, { $set: set });
      if (issued?.modifiedCount !== 0) code = set.certificateCode;
    }
    return { success: true, message: code ? 'Certificate issued' : 'Details saved', data: { certificateDetails: details, certificateCode: code, certificateDetailsRequired: false } };
  }

  /** Public certificate check — anyone with the code (an employer, a school) can verify it. Only what the learner typed is shown, never e-mail or account ids. */
  async verifyCertificate(code: string) {
    const p: any = await this.progressModel.findOne({ certificateCode: String(code ?? '').toUpperCase() }).lean();
    if (!p) throw new NotFoundException('No certificate with that code');
    const product: any = await this.r.productModel.findById(p.productId).select('name slug storeId').lean();
    const store: any = product ? await this.r.storeModel.findById(product.storeId).select('name slug logo').lean() : null;
    const course: any = await this.r.courseModel.findOne({ productId: p.productId }).select('instructor certificateConfig').lean();
    const d = p.certificateDetails ?? null;
    const cfg = { ...EMPTY_CERT_CONFIG, ...(course?.certificateConfig ?? {}) };
    return {
      success: true,
      data: {
        code: p.certificateCode, learnerName: d?.fullName ?? p.learnerName, courseName: product?.name ?? 'Course', courseSlug: product?.slug ?? null, teacher: store?.name ?? null, storeSlug: store?.slug ?? null, completedAt: p.completedAt,
        guardianName: d?.guardianName ?? null, institute: d?.institute ?? null, city: d?.city ?? null, country: d?.country ?? null,
        courseTitle: product?.name ?? 'Course', issuedAt: p.completedAt ?? p.updatedAt ?? null, storeName: store?.name ?? null,
        instructorName: course?.instructor?.name || null,
        config: {
          watermarkText: cfg.watermarkText, watermarkImageUrl: cfg.watermarkImageUrl, stampImageUrl: cfg.stampImageUrl,
          signatureName: cfg.signatureName, signatureTitle: cfg.signatureTitle, issuerName: cfg.issuerName,
          ...(cfg.signatureImageUrl ? { signatureImageUrl: cfg.signatureImageUrl } : {}),
          ...(cfg.logoImageUrl ? { logoImageUrl: cfg.logoImageUrl } : {}),
        },
        storeLogoUrl: store?.logo ?? null,
      },
    };
  }

  /** My courses — every course product the buyer owns, with progress. */
  async myCourses(userId: string) {
    const orders: any[] = await this.r.orderModel.find({ userId, isDelete: false, isPaid: true }).select('paidAt createdAt sellerOrders.items').lean();
    const ids = new Set<string>();
    const boughtAt = new Map<string, number>();
    for (const o of orders) {
      const at = new Date(o.paidAt ?? o.createdAt).getTime();
      for (const so of o.sellerOrders ?? []) for (const it of so.items ?? []) {
        if (['cancelled', 'refunded'].includes(it.status)) continue;
        const id = String(it.productId);
        ids.add(id);
        boughtAt.set(id, Math.max(boughtAt.get(id) ?? 0, at));
      }
    }
    const valid = [...ids].filter(id => isValidObjectId(id));
    const products: any[] = await this.r.productModel.find({ _id: { $in: valid }, deliveryFormat: 'course', removedByAdmin: { $ne: true } }).select('_id name slug images deliveryFormat storeId status isTest isDelete').lean();
    const courseIds = products.filter(p => p.deliveryFormat === 'course').map(p => String(p._id));
    const [courses, progress] = await Promise.all([
      this.r.courseModel.find({ productId: { $in: courseIds } }).select('productId sections accessDays accessDaysLog').lean(),
      this.progressModel.find({ userId, productId: { $in: courseIds } }).lean(),
    ]);
    const total = new Map(courses.map((c: any) => [c.productId, lessonIds(c.sections).length]));
    const courseById = new Map(courses.map((c: any) => [c.productId, c]));
    const prog = new Map(progress.map((p: any) => [p.productId, p]));
    return {
      success: true,
      data: products.map(p => {
        const id = String(p._id);
        const pr: any = prog.get(id);
        const lessons = total.get(id) ?? 0;
        const completed = pr?.completedLessonIds?.length ?? 0;
        const expires = p.deliveryFormat === 'course' ? accessExpiry(boughtAt.get(id) ? new Date(boughtAt.get(id)!) : null, accessDaysAt(courseById.get(id), boughtAt.get(id) ? new Date(boughtAt.get(id)!) : null)) : null;
        return {
          productId: id, name: p.name, slug: p.slug, image: p.images?.[0] ?? null, deliveryFormat: p.deliveryFormat,
          lessons, completed, completedAt: pr?.completedAt ?? null, certificateCode: pr?.certificateCode ?? null,
          percent: lessons ? Math.min(100, Math.round((completed / lessons) * 100)) : 0,
          lastLessonId: pr?.lastLessonId ?? null,
          accessExpiresAt: expires,
          accessExpired: !!expires && expires.getTime() < Date.now(),
          // Used by the "continue your course" reminder: never nag about a draft, deleted or test course.
          isPublished: p.status === 'active' && !p.isTest && !p.isDelete,
        };
      }),
    };
  }

  // ── Seller: roster ─────────────────────────────────────────────────────────


  /** Everyone who holds a paid, non-refunded seat, with course progress. Derived from orders, so buyers who never opened a lesson appear too. */
  async studentsForSeller(storeId: string, sellerId: string, productId: string, query: { page?: unknown; limit?: unknown } = {}) {
    await this.sellerProduct(storeId, sellerId, productId);
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)));
    const orders: any[] = await this.r.orderModel.find(paidSeatFilter(productId)).select('userId paidAt createdAt').sort({ createdAt: -1 }).limit(5000).lean();
    const enrolled = new Map<string, Date>();
    for (const o of orders) {
      const uid = String(o.userId);
      const at = new Date(o.paidAt ?? o.createdAt);
      const prev = enrolled.get(uid);
      if (!prev || at < prev) enrolled.set(uid, at);
    }
    const all = [...enrolled.entries()].sort((a, b) => b[1].getTime() - a[1].getTime());
    const slice = all.slice((page - 1) * limit, page * limit);
    const ids = slice.map(([id]) => id);
    const validIds = ids.filter(id => isValidObjectId(id));
    const [users, progress, course]: any[] = await Promise.all([
      this.r.userModel.find({ _id: { $in: validIds } }).select('name email').lean(),
      this.progressModel.find({ productId, userId: { $in: ids } }).lean(),
      this.r.courseModel.findOne({ productId }).select('sections').lean(),
    ]);
    const userById = new Map(users.map((u: any) => [String(u._id), u]));
    const progById = new Map(progress.map((p: any) => [String(p.userId), p]));
    const totalLessons = lessonIds(course?.sections ?? []).length;
    return {
      success: true,
      data: {
        total: all.length,
        students: slice.map(([userId, enrolledAt]) => {
          const u: any = userById.get(userId);
          const p: any = progById.get(userId);
          const done = p?.completedLessonIds?.length ?? 0;
          return {
            userId, name: u?.name ?? 'Learner', email: u?.email ?? null, enrolledAt,
            completedLessons: done, totalLessons,
            percent: totalLessons ? Math.min(100, Math.round((done / totalLessons) * 100)) : 0,
            lastActiveAt: p?.updatedAt ?? null, completedAt: p?.completedAt ?? null, certificateCode: p?.certificateCode ?? null,
          };
        }),
      },
    };
  }

  /**
   * Store-level roster: every buyer of this store's digital products (courses = progress, files = download count),
   * paid seats and free claims alike. Reads existing order/progress data only; nothing is tracked or changed.
   * ONE aggregation groups (buyer, product); progress/status/sort/paging are then applied in memory over at most
   * ROSTER_GROUP_CAP groups (progress lives in another collection, so it cannot be sorted in the order pipeline).
   * Emails are always masked; search matches the NAME only.
   */
  private async rosterRows(storeId: string) {
    const base: any = { isDelete: false, 'sellerOrders.storeId': storeId, $or: [{ isPaid: true }, { isFreeClaim: true }] };
    const itemMatch: any = {
      'sellerOrders.storeId': storeId,
      'sellerOrders.items.type': { $in: ['digital', 'educational'] },
      'sellerOrders.items.status': { $nin: ['cancelled', 'refunded'] },
    };
    const when = { $ifNull: ['$paidAt', '$createdAt'] };
    const groups: any[] = await this.r.orderModel.aggregate([
      { $match: base },
      { $unwind: '$sellerOrders' },
      { $unwind: '$sellerOrders.items' },
      { $match: itemMatch },
      {
        $group: {
          _id: { u: '$userId', p: '$sellerOrders.items.productId' },
          firstAt: { $min: when }, lastAt: { $max: when },
          downloads: { $sum: { $ifNull: ['$sellerOrders.items.downloadCount', 0] } },
          // Free only when EVERY purchase of this product by this buyer was a free claim (a paid purchase makes it Paid).
          free: { $min: { $cond: [{ $eq: ['$isFreeClaim', true] }, 1, 0] } },
        },
      },
      { $sort: { firstAt: -1, '_id.u': 1, '_id.p': 1 } },
      { $limit: ROSTER_GROUP_CAP },
    ]);

    const userIds = [...new Set(groups.map(g => String(g._id.u)))];
    const productIds = [...new Set(groups.map(g => String(g._id.p)))];
    const validProductIds = productIds.filter(id => isValidObjectId(id));
    const [users, products]: any[] = await Promise.all([
      this.r.userModel.find({ _id: { $in: userIds.filter(id => isValidObjectId(id)) } }).select('name').lean(),
      this.r.productModel.find({ _id: { $in: validProductIds } }).select('name deliveryFormat isTest').lean(),
    ]);
    const productById = new Map<string, any>(products.map((p: any) => [String(p._id), p]));
    // Test products never show (rows, stats, chips, CSV all start from here).
    const live = groups.filter(g => !productById.get(String(g._id.p))?.isTest);
    const courseIds = [...new Set(live.map(g => String(g._id.p)).filter(id => productById.get(id)?.deliveryFormat === 'course'))];
    const courseUsers = [...new Set(live.filter(g => courseIds.includes(String(g._id.p))).map(g => String(g._id.u)))];
    const [progress, courses]: any[] = await Promise.all([
      courseIds.length ? this.progressModel.find({ userId: { $in: courseUsers }, productId: { $in: courseIds } }).lean() : Promise.resolve([]),
      courseIds.length ? this.r.courseModel.find({ productId: { $in: courseIds } }).select('productId sections accessDays accessDaysLog').lean() : Promise.resolve([]),
    ]);
    const userById = new Map<string, any>(users.map((u: any) => [String(u._id), u]));
    const progByKey = new Map<string, any>(progress.map((p: any) => [`${p.userId}:${p.productId}`, p]));
    const courseById = new Map<string, any>(courses.map((c: any) => [String(c.productId), c]));

    const rows: RosterRow[] = live.map(g => {
      const userId = String(g._id.u);
      const productId = String(g._id.p);
      const u = userById.get(userId);
      const p = productById.get(productId);
      const isCourse = p?.deliveryFormat === 'course';
      const prog = progByKey.get(`${userId}:${productId}`);
      const course = courseById.get(productId);
      const totalLessons = isCourse ? lessonIds(course?.sections ?? []).length : null;
      const done = isCourse ? (prog?.completedLessonIds?.length ?? 0) : null;
      const until = isCourse ? accessExpiry(g.lastAt, accessDaysAt(course, g.lastAt)) : null;
      return {
        userId, name: u?.name ?? 'Learner', email: null,
        productId, productName: p?.name ?? 'Product', kind: isCourse ? 'course' : 'file',
        enrolledAt: g.firstAt, isFree: g.free === 1,
        percent: isCourse ? (totalLessons ? Math.min(100, Math.round(((done ?? 0) / totalLessons) * 100)) : 0) : null,
        completedLessons: done, totalLessons,
        downloads: isCourse ? null : (g.downloads ?? 0),
        lastActivityAt: isCourse ? (prog?.updatedAt ?? null) : null,
        accessEnded: !!until && until.getTime() < Date.now(),
        completed: isCourse && !!(prog?.completedAt || prog?.certificateCode),
      } as RosterRow;
    });
    return rows;
  }

  async rosterForSeller(storeId: string, sellerId: string, rawQuery: Record<string, unknown> = {}, forExport = false) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const query = parseRosterQuery(rawQuery);
    if (query.productId) {
      const owned = await this.r.productModel.findOne({ _id: query.productId, storeId, isDelete: false, isTest: { $ne: true }, type: 'digital' }).select('_id').lean();
      if (!owned) throw new NotFoundException('Product not found');
    }

    const all = await this.rosterRows(storeId);
    const byProduct = query.productId ? all.filter(r => r.productId === query.productId) : all;
    const needle = (query.q ?? '').toLowerCase();
    const searched = needle ? byProduct.filter(r => r.name.toLowerCase().includes(needle)) : byProduct;
    const view = buildRosterView(searched, byProduct, query);

    if (forExport) {
      const emails = await this.maskedEmails(view.sorted.slice(0, ROSTER_EXPORT_CAP + 1).map(r => r.userId));
      const rows = view.sorted.map(r => ({ ...r, email: emails.get(r.userId) ?? null }));
      return toExportCsv(ROSTER_CSV_HEADER, rosterCsvRows(rows), { cap: ROSTER_EXPORT_CAP, label: 'students' }).csv;
    }

    // Product filter: never test products; active/scheduled ones, or any that still have enrolments (old buyers stay reachable).
    const counts = new Map<string, number>();
    for (const r of all) counts.set(r.productId, (counts.get(r.productId) ?? 0) + 1);
    const storeProducts: any[] = await this.r.productModel
      .find({ storeId, type: 'digital', isTest: { $ne: true } }).select('name status isDelete').sort({ name: 1 }).limit(500).lean();
    const products = storeProducts
      .map((p: any) => ({ id: String(p._id), name: p.name, count: counts.get(String(p._id)) ?? 0, live: !p.isDelete && ['active', 'scheduled'].includes(p.status) }))
      .filter(p => p.live || p.count > 0)
      .map(({ id, name, count }) => ({ id, name, count }));

    const emails = await this.maskedEmails(view.pageRows.map(r => r.userId));
    const rows = view.pageRows.map(r => ({ ...r, email: emails.get(r.userId) ?? null }));
    return {
      success: true,
      data: {
        total: view.total, page: query.page, limit: query.limit, totalPages: Math.max(1, Math.ceil(view.total / query.limit)),
        rows, products, stats: view.stats, statusCounts: view.statusCounts,
      },
    };
  }

  /** Masked e-mails for a set of buyers (the full address never leaves the API). */
  private async maskedEmails(userIds: string[]) {
    const ids = [...new Set(userIds)].filter(id => isValidObjectId(id));
    const out = new Map<string, string | null>();
    if (!ids.length) return out;
    const users: any[] = await this.r.userModel.find({ _id: { $in: ids } }).select('email').lean();
    for (const u of users) out.set(String(u._id), maskRosterEmail(u.email));
    return out;
  }

  /** One student of this store: every digital product they hold here, lesson checklist or download count, and order numbers. */
  async rosterStudentDetail(storeId: string, sellerId: string, userId: string) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const orders: any[] = await this.r.orderModel
      .find({ userId, isDelete: false, 'sellerOrders.storeId': storeId, $or: [{ isPaid: true }, { isFreeClaim: true }] })
      .select('orderNumber paidAt createdAt isFreeClaim sellerOrders').sort({ createdAt: -1 }).limit(200).lean();
    const held = new Map<string, { enrolledAt: Date; lastAt: Date; downloads: number; free: boolean; orders: Map<string, boolean> }>();
    for (const o of orders) {
      const at = new Date(o.paidAt ?? o.createdAt);
      for (const so of o.sellerOrders ?? []) {
        if (String(so.storeId) !== storeId) continue;
        for (const it of so.items ?? []) {
          if (!['digital', 'educational'].includes(it.type) || ['cancelled', 'refunded'].includes(it.status)) continue;
          const pid = String(it.productId);
          const h = held.get(pid) ?? { enrolledAt: at, lastAt: at, downloads: 0, free: true, orders: new Map() };
          if (at < h.enrolledAt) h.enrolledAt = at;
          if (at > h.lastAt) h.lastAt = at;
          h.downloads += it.downloadCount ?? 0;
          if (o.isFreeClaim !== true) h.free = false;
          h.orders.set(String(o.orderNumber), o.isFreeClaim === true);
          held.set(pid, h);
        }
      }
    }
    const productIds = [...held.keys()].filter(id => isValidObjectId(id));
    const [products, user]: any[] = await Promise.all([
      productIds.length ? this.r.productModel.find({ _id: { $in: productIds } }).select('name deliveryFormat isTest').lean() : Promise.resolve([]),
      isValidObjectId(userId) ? this.r.userModel.findById(userId).select('name email').lean() : Promise.resolve(null),
    ]);
    const liveProducts = products.filter((p: any) => !p.isTest && held.has(String(p._id)));
    // Not a student of THIS store (or only of test products): same 404 for every case, no hint about the account.
    if (!liveProducts.length) throw new NotFoundException('Student not found');
    const courseIds = liveProducts.filter((p: any) => p.deliveryFormat === 'course').map((p: any) => String(p._id));
    const [progress, courses]: any[] = await Promise.all([
      courseIds.length ? this.progressModel.find({ userId, productId: { $in: courseIds } }).lean() : Promise.resolve([]),
      courseIds.length ? this.r.courseModel.find({ productId: { $in: courseIds } }).select('productId sections accessDays accessDaysLog').lean() : Promise.resolve([]),
    ]);
    const progById = new Map<string, any>(progress.map((p: any) => [String(p.productId), p]));
    const courseById = new Map<string, any>(courses.map((c: any) => [String(c.productId), c]));

    const items = liveProducts.map((p: any) => {
      const pid = String(p._id);
      const h = held.get(pid)!;
      const isCourse = p.deliveryFormat === 'course';
      const base = {
        productId: pid, productName: p.name, kind: (isCourse ? 'course' : 'file') as 'course' | 'file',
        enrolledAt: h.enrolledAt, isFree: h.free,
        orders: [...h.orders.entries()].map(([orderNumber, free]) => ({ orderNumber, free })),
      };
      if (!isCourse) return { ...base, downloads: h.downloads, percent: null, sections: [], lastActivityAt: null, accessEnded: false };
      const course = courseById.get(pid);
      const prog = progById.get(pid);
      const doneIds = new Set<string>((prog?.completedLessonIds ?? []).map(String));
      const sections = (course?.sections ?? []).map((s: any) => ({
        title: s.title ?? '', lessons: (s.lessons ?? []).map((l: any) => ({ title: l.title ?? 'Lesson', done: doneIds.has(String(l._id)) })),
      }));
      const total = lessonIds(course?.sections ?? []).length;
      const done = doneIds.size;
      const until = accessExpiry(h.lastAt, accessDaysAt(course, h.lastAt));
      return {
        ...base, downloads: null, sections, completedLessons: done, totalLessons: total,
        percent: total ? Math.min(100, Math.round((done / total) * 100)) : 0,
        lastActivityAt: prog?.updatedAt ?? null, accessEnded: !!until && until.getTime() < Date.now(),
      };
    });
    const acts = items.map(i => (i.lastActivityAt ? new Date(i.lastActivityAt).getTime() : 0));
    const lastActivityAt = Math.max(0, ...acts);
    return {
      success: true,
      data: {
        userId, name: user?.name ?? 'Learner', email: maskRosterEmail(user?.email),
        enrolledAt: new Date(Math.min(...items.map(i => new Date(i.enrolledAt).getTime()))),
        lastActivityAt: lastActivityAt ? new Date(lastActivityAt) : null,
        items,
      },
    };
  }
}
