/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CoursesService } from './courses.service';
import { cleanCourseExtras, cleanCourseInput, cleanVideoUrl, accessExpiry } from './course.util';
import { PaymentService } from '../payment/payment.service';

const P = '64b0000000000000000000a1';
const chain = (v: any) => ({ select: () => chain(v), lean: () => Promise.resolve(v), sort: () => chain(v), limit: () => chain(v), then: (r: any) => Promise.resolve(v).then(r) });

function makeCourses(opts: { product?: any; course?: any; orders?: any[]; modified?: number } = {}) {
  const product = opts.product ?? { _id: P, name: 'Algebra', slug: 'algebra', sellerId: 'seller1', storeId: 's1', status: 'active', deliveryFormat: 'course' };
  const course = opts.course ?? {
    productId: P, certificateEnabled: true, outcomes: ['Solve equations'], instructor: { name: 'Ms Ayesha', bio: 'Maths teacher' }, accessDays: null,
    sections: [{ _id: 's1', title: 'Intro', lessons: [
      { _id: 'l1', title: 'Welcome', type: 'video', file: { url: 'private/secret-video.mp4', name: 'v.mp4', mimeType: 'video/mp4' }, videoUrl: null, isPreview: true, durationMinutes: 5 },
      { _id: 'l2', title: 'Paid video', type: 'video', file: { url: 'private/paid.mp4', name: 'p.mp4', mimeType: 'video/mp4' }, videoUrl: null, isPreview: false, durationMinutes: 10 },
      { _id: 'l3', title: 'External', type: 'video', file: null, videoUrl: 'https://www.youtube.com/watch?v=abc', isPreview: false, durationMinutes: 7 },
    ] }],
  };
  const orders = opts.orders ?? [];
  const repos: any = {
    productModel: {
      findOne: jest.fn(() => chain(product)),
      updateOne: jest.fn(async () => ({ modifiedCount: opts.modified ?? 1 })),
    },
    courseModel: { findOne: jest.fn(() => chain(course)) },
    orderModel: { find: jest.fn(() => chain(orders)), findOne: jest.fn(() => chain(orders[0] ?? null)), countDocuments: jest.fn(async () => orders.length) },
    storeModel: { findById: jest.fn(() => chain({ name: 'Store', slug: 'store' })) },
    userModel: { find: jest.fn(() => chain([])) },
  };
  const progressModel: any = { findOne: jest.fn(() => chain(null)), updateOne: jest.fn(async () => ({})), countDocuments: jest.fn(async () => 0), find: jest.fn(() => chain([])) };
  const upload: any = { resolveMimeType: (_n: string, m: string) => m, generateSignedUrl: jest.fn((id: string) => `https://signed.example/${id}?sig=1`) };
  const notifications: any = { notify: jest.fn(async () => undefined) };
  const activity: any = { log: jest.fn(async () => true) };
  const svc = new CoursesService(progressModel, { repositories: repos } as any, upload, {} as any, notifications, activity);
  return { svc, repos, upload, notifications, activity };
}
const paid = (date = new Date()) => [{ userId: 'buyer1', paidAt: date, createdAt: date }];

describe('course access (server-side)', () => {
  it('an unpaid user cannot fetch a paid lesson or its media', async () => {
    const { svc, upload } = makeCourses({ orders: [] });
    await expect(svc.getLesson('buyer1', P, 'l2')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getLearnView('buyer1', P)).rejects.toBeInstanceOf(ForbiddenException);
    expect(upload.generateSignedUrl).not.toHaveBeenCalled();
  });

  it('a paid user gets a signed link, external videos come back as external media', async () => {
    const { svc } = makeCourses({ orders: paid() });
    const file: any = await svc.getLesson('buyer1', P, 'l2');
    expect(file.data.media.kind).toBe('file');
    expect(file.data.media.url).toContain('signed.example');
    const ext: any = await svc.getLesson('buyer1', P, 'l3');
    expect(ext.data.media).toEqual({ kind: 'external', url: 'https://www.youtube.com/watch?v=abc' });
    expect(ext.data.videoUrl).toContain('youtube.com');
  });

  it('the free-preview lesson is open to anyone, a paid one is not', async () => {
    const { svc } = makeCourses({ orders: [] });
    const ok: any = await svc.previewLesson(P, 'l1');
    expect(ok.data.media.kind).toBe('file');
    await expect(svc.previewLesson(P, 'l2')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.previewLesson(P, 'l3')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the public outline never exposes file urls or the video link of a non-preview lesson', async () => {
    const { svc } = makeCourses();
    const out: any = await svc.outline(P);
    const json = JSON.stringify(out);
    expect(json).not.toContain('secret-video');
    expect(json).not.toContain('paid.mp4');
    expect(json).not.toContain('youtube.com');
    expect(out.data).toEqual(expect.objectContaining({ lessonCount: 3, totalMinutes: 22, outcomes: ['Solve equations'], accessDays: null, certificateEnabled: true }));
    expect(out.data.instructor.name).toBe('Ms Ayesha');
  });

  it('access ends accessDays after the purchase (the teacher is exempt)', async () => {
    const course = { productId: P, accessDays: 30, certificateEnabled: false, sections: [{ _id: 's1', title: 'A', lessons: [{ _id: 'l1', title: 'x', type: 'text', text: 'hi', isPreview: false }] }] };
    const old = new Date(Date.now() - 40 * 86400000);
    const expired = makeCourses({ course, orders: paid(old) });
    await expect(expired.svc.getLesson('buyer1', P, 'l1')).rejects.toThrow('Your access to this course has ended');
    const fresh = makeCourses({ course, orders: paid(new Date(Date.now() - 5 * 86400000)) });
    await expect(fresh.svc.getLesson('buyer1', P, 'l1')).resolves.toBeDefined();
    const teacher = makeCourses({ course, orders: [] });
    await expect(teacher.svc.getLesson('seller1', P, 'l1')).resolves.toBeDefined();
    expect(accessExpiry(old, 30)!.getTime()).toBeLessThan(Date.now());
    expect(accessExpiry(old, null)).toBeNull();
  });
});

describe('course builder input', () => {
  const base = (lesson: any, extra: any = {}) => ({ sections: [{ title: 'S', lessons: [lesson] }], ...extra });
  it('accepts a YouTube/Vimeo link instead of an upload, rejects other hosts and http', () => {
    const ok = cleanCourseInput(base({ title: 'V', type: 'video', videoUrl: 'https://youtu.be/abc123' }));
    expect(ok.sections[0].lessons[0].videoUrl).toContain('youtu.be');
    expect(ok.fileRefs).toHaveLength(0);
    expect(() => cleanCourseInput(base({ title: 'V', type: 'video' }))).toThrow(BadRequestException);
    expect(() => cleanVideoUrl('https://evil.example/watch')).toThrow(BadRequestException);
    expect(() => cleanVideoUrl('http://youtube.com/watch?v=1')).toThrow(BadRequestException);
    expect(() => cleanVideoUrl('https://youtube.com.evil.example/x')).toThrow(BadRequestException);
    expect(cleanVideoUrl('https://vimeo.com/123456')).toContain('vimeo.com');
  });
  it('validates outcomes, instructor and access duration', () => {
    expect(cleanCourseExtras({ outcomes: ['  a  ', '', 'b'], instructor: { name: 'N', bio: 'B' }, accessDays: 90 })).toEqual({ outcomes: ['a', 'b'], instructor: { name: 'N', bio: 'B' }, accessDays: 90 });
    expect(cleanCourseExtras({}).accessDays).toBeNull();
    expect(() => cleanCourseExtras({ outcomes: Array(11).fill('x') })).toThrow(BadRequestException);
    expect(() => cleanCourseExtras({ outcomes: ['x'.repeat(201)] })).toThrow(BadRequestException);
    expect(() => cleanCourseExtras({ instructor: { name: 'x'.repeat(101) } })).toThrow(BadRequestException);
    expect(() => cleanCourseExtras({ instructor: { bio: 'x'.repeat(1001) } })).toThrow(BadRequestException);
    expect(() => cleanCourseExtras({ accessDays: 0 })).toThrow(BadRequestException);
    expect(() => cleanCourseExtras({ accessDays: 3651 })).toThrow(BadRequestException);
    expect(() => cleanCourseExtras({ accessDays: 1.5 })).toThrow(BadRequestException);
  });
});

describe('Cash on Delivery for digital items', () => {
  it('Cash on Delivery is refused for course items (they are digital) and no order is placed', async () => {
    const checkoutDoc: any = { _id: 'c1', userId: 'u1', status: 'pending', expiredAt: null, currency: 'USD', totalAmount: 10, orderPlacementStartedAt: null, fxSnapshots: [], items: [{ type: 'digital', storeId: 'A', variantId: 'v1', quantity: 1, name: 'Course', totalPrice: 10, currency: 'USD' }] };
    const repos: any = {
      checkoutModel: { findOne: jest.fn(async () => ({ ...checkoutDoc })), findOneAndUpdate: jest.fn(async () => ({ ...checkoutDoc })), findByIdAndUpdate: jest.fn(async () => ({})), updateOne: jest.fn(async () => ({})) },
      storeModel: { find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) },
      productVariantModel: { findOne: jest.fn(async () => ({ stock: 10, unlimitedStock: true })), find: jest.fn(() => chain([])) },
      paymentTransactionModel: { create: jest.fn(async () => ({})), findOne: jest.fn(async () => null) },
      orderModel: {}, addressModel: {}, cartModel: {},
    };
    const svc: any = new PaymentService({ repositories: repos } as any, {} as any, { get: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any, { log: jest.fn() } as any, {} as any, {} as any, {} as any);
    svc.createOrder = jest.fn();
    await expect(svc.codPayment('u1', { checkoutId: 'c1' })).rejects.toThrow(/Cash on Delivery is not available for digital products/);
    expect(svc.createOrder).not.toHaveBeenCalled();
  });
});
