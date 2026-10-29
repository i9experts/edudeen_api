/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CoursesService } from './courses.service';
import { cleanCourseExtras, cleanCourseInput, cleanVideoUrl, accessExpiry } from './course.util';
import { joinWindowOpen, liveClassEmail, liveStatusOf, reminderCopy, registrationOpen } from './live-class.util';
import { claimLiveSeats, releaseLiveSeats, seatsLeft } from './live-seats.util';
import { cleanDeliveryFormat } from '../products/product-input.util';
import { sanitizeDigitalForPublicView } from '../products/product-public-view.util';
import { PaymentService } from '../payment/payment.service';

const P = '64b0000000000000000000a1';
const chain = (v: any) => ({ select: () => chain(v), lean: () => Promise.resolve(v), sort: () => chain(v), limit: () => chain(v), then: (r: any) => Promise.resolve(v).then(r) });
const minutes = (m: number) => new Date(Date.now() + m * 60000);

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

describe('live class: link, window, cancel', () => {
  const live = (over: any = {}) => ({ startsAt: minutes(20), durationMinutes: 60, platform: 'zoom', meetingUrl: 'https://zoom.us/j/1', capacity: 10, notes: '', status: 'scheduled', recordingUrl: 'https://youtu.be/rec', ...over });
  const product = (l: any) => ({ _id: P, name: 'Live Maths', slug: 'live-maths', sellerId: 'seller1', storeId: 's1', status: 'active', type: 'digital', deliveryFormat: 'live_class', liveSession: l });

  it('meetingUrl and recordingUrl never reach public product responses', () => {
    const pub: any = sanitizeDigitalForPublicView({ ...product(live()) } as any);
    expect(pub.liveSession.meetingUrl).toBeUndefined();
    expect(pub.liveSession.recordingUrl).toBeUndefined();
    expect(pub.liveSession.capacity).toBe(10);
    expect(JSON.stringify(pub)).not.toContain('zoom.us');
    expect(JSON.stringify(pub)).not.toContain('youtu.be/rec');
  });

  it('buyers get the link only inside the join window, never after the end or when cancelled; recording only after the end', async () => {
    const soon = await makeCourses({ product: product(live({ startsAt: minutes(20) })), orders: paid() }).svc.liveAccess('buyer1', P);
    expect((soon as any).data.meetingUrl).toBe('https://zoom.us/j/1');
    expect((soon as any).data.recordingUrl).toBeNull();
    const early: any = await makeCourses({ product: product(live({ startsAt: minutes(120) })), orders: paid() }).svc.liveAccess('buyer1', P);
    expect(early.data.meetingUrl).toBeNull();
    expect(early.data.joinOpen).toBe(false);
    const over: any = await makeCourses({ product: product(live({ startsAt: minutes(-120) })), orders: paid() }).svc.liveAccess('buyer1', P);
    expect(over.data.meetingUrl).toBeNull();
    expect(over.data.ended).toBe(true);
    expect(over.data.recordingUrl).toBe('https://youtu.be/rec');
    const cancelled: any = await makeCourses({ product: product(live({ status: 'cancelled' })), orders: paid() }).svc.liveAccess('buyer1', P);
    expect(cancelled.data.meetingUrl).toBeNull();
    expect(cancelled.data.recordingUrl).toBeNull();
    expect(cancelled.data.status).toBe('cancelled');
    await expect(makeCourses({ product: product(live()), orders: [] }).svc.liveAccess('buyer1', P)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('e-mails carry the meeting link only once the join window is open', () => {
    const early = liveClassEmail('t', 'b', { name: 'n', startsAt: minutes(55), meetingUrl: 'https://zoom.us/j/1' }, { label: 'x', path: '/p' });
    expect(early.html).not.toContain('zoom.us');
    const open = liveClassEmail('t', 'b', { name: 'n', startsAt: minutes(15), meetingUrl: 'https://zoom.us/j/1' }, { label: 'x', path: '/p' });
    expect(open.html).toContain('zoom.us');
    expect(reminderCopy('buyer', { name: 'n', startsAt: minutes(55) }, 55).body).toContain('My Library');
    expect(joinWindowOpen(minutes(29))).toBe(true);
    expect(joinWindowOpen(minutes(31))).toBe(false);
  });

  it('status and registration rules', () => {
    expect(liveStatusOf(live({ startsAt: minutes(-120) }))).toBe('completed');
    expect(liveStatusOf(live())).toBe('upcoming');
    expect(liveStatusOf(live({ status: 'cancelled' }))).toBe('cancelled');
    expect(registrationOpen(live())).toBe(true);
    expect(registrationOpen(live({ registrationDeadline: minutes(-1) }))).toBe(false);
    expect(registrationOpen(live({ status: 'cancelled' }))).toBe(false);
    expect(registrationOpen(live({ startsAt: minutes(-120) }))).toBe(false);
    expect(seatsLeft(10, 4, 2)).toBe(6);
    expect(seatsLeft(10, 0, 7)).toBe(3);
    expect(seatsLeft(null, 5, 5)).toBeNull();
  });

  it('cancel notifies each paid buyer once, logs for admin, and is idempotent', async () => {
    const first = makeCourses({ product: product(live()), orders: paid(), modified: 1 });
    first.repos.storeModel.findById = jest.fn(async () => ({ _id: 's1', sellerId: 'seller1' }));
    const res: any = await first.svc.cancelLive('s1', 'seller1', P, 'Teacher is ill');
    expect(res.data.status).toBe('cancelled');
    expect(first.notifications.notify).toHaveBeenCalledTimes(1);
    expect(first.notifications.notify.mock.calls[0][0]).toEqual(expect.objectContaining({ recipientId: 'buyer1', type: 'live_class_cancelled' }));
    expect(first.activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'live_class_cancelled' }));

    const again = makeCourses({ product: product(live({ status: 'cancelled' })), orders: paid(), modified: 0 });
    again.repos.storeModel.findById = jest.fn(async () => ({ _id: 's1', sellerId: 'seller1' }));
    const second: any = await again.svc.cancelLive('s1', 'seller1', P);
    expect(second.data.notified).toBe(0);
    expect(again.notifications.notify).not.toHaveBeenCalled();
  });
});

describe('live-session input on create / edit', () => {
  const body = (over: any = {}) => ({ deliveryFormat: 'live_class', liveSession: { startsAt: minutes(600).toISOString(), durationMinutes: 60, meetingUrl: 'https://zoom.us/j/1', capacity: 10, ...over } });
  it('keeps seats already sold and stamps a reschedule; refuses a bad deadline, a bad recording link and a cancelled class', () => {
    const prev = { startsAt: minutes(300), durationMinutes: 60, seatsTaken: 4, status: 'scheduled' };
    const edited: any = cleanDeliveryFormat(body(), { deliveryFormat: 'live_class', liveSession: prev });
    expect(edited.liveSession.seatsTaken).toBe(4);
    expect(edited.liveSession.rescheduledAt).toBeInstanceOf(Date);
    expect(edited.liveSession.status).toBe('scheduled');
    expect(() => cleanDeliveryFormat(body({ capacity: 3 }), { deliveryFormat: 'live_class', liveSession: prev })).toThrow(/already sold/);
    expect(() => cleanDeliveryFormat(body({ registrationDeadline: minutes(700).toISOString() }), null)).toThrow(/before the class starts/);
    expect(() => cleanDeliveryFormat(body({ recordingUrl: 'http://x.example/r' }), null)).toThrow(BadRequestException);
    expect(() => cleanDeliveryFormat(body(), { deliveryFormat: 'live_class', liveSession: { ...prev, status: 'cancelled' } })).toThrow(/cancelled/);
    const ok: any = cleanDeliveryFormat(body({ registrationDeadline: minutes(500).toISOString(), recordingUrl: 'https://youtu.be/r' }), null);
    expect(ok.liveSession.registrationDeadline).toBeInstanceOf(Date);
    expect(ok.liveSession.seatsTaken).toBe(0);
  });
});

describe('seat claims (unit, atomic mock)', () => {
  // A tiny in-memory product collection whose update is synchronous per call, like a single Mongo document update.
  function fakeProducts(doc: any) {
    return {
      find: jest.fn(() => chain([doc])),
      findOneAndUpdate: jest.fn((filter: any, update: any) => {
        const l = doc.liveSession;
        const ok = l.status !== 'cancelled' && (!l.capacity || (l.seatsTaken ?? 0) + update.$inc['liveSession.seatsTaken'] <= l.capacity);
        if (ok) l.seatsTaken = (l.seatsTaken ?? 0) + update.$inc['liveSession.seatsTaken'];
        return chain(ok ? { _id: doc._id } : null);
      }),
      updateOne: jest.fn(async (filter: any, update: any) => {
        if (update.$inc) { const q = -update.$inc['liveSession.seatsTaken']; if ((doc.liveSession.seatsTaken ?? 0) >= q) doc.liveSession.seatsTaken -= q; }
        return {};
      }),
    };
  }
  const orders = { countDocuments: jest.fn(async () => 0) };
  it('never goes over capacity, and rolls back an earlier line when a later one is full', async () => {
    const doc: any = { _id: P, name: 'Class', liveSession: { capacity: 3, seatsTaken: 2, status: 'scheduled' } };
    const products = fakeProducts(doc);
    const claimed = await claimLiveSeats(products as any, orders, [{ productId: P, quantity: 1, type: 'digital' }]);
    expect(claimed).toEqual([{ productId: P, quantity: 1 }]);
    await expect(claimLiveSeats(products as any, orders, [{ productId: P, quantity: 1, type: 'digital' }])).rejects.toThrow(/full/);
    expect(doc.liveSession.seatsTaken).toBe(3);
    await releaseLiveSeats(products as any, [{ productId: P, quantity: 1, type: 'digital' }]);
    expect(doc.liveSession.seatsTaken).toBe(2);
    await releaseLiveSeats(products as any, [{ productId: P, quantity: 5, type: 'digital' }]); // would go below zero: ignored
    expect(doc.liveSession.seatsTaken).toBe(2);
  });
  it('a cancelled class cannot be claimed; physical lines and non-live products are ignored', async () => {
    const doc: any = { _id: P, name: 'Class', liveSession: { capacity: null, seatsTaken: 0, status: 'cancelled' } };
    await expect(claimLiveSeats(fakeProducts(doc) as any, orders, [{ productId: P, quantity: 1, type: 'digital' }])).rejects.toThrow(/cancelled/);
    expect(await claimLiveSeats(fakeProducts(doc) as any, orders, [{ productId: P, quantity: 1, type: 'physical' }])).toEqual([]);
    expect(await claimLiveSeats({ find: () => chain([]) } as any, orders, [{ productId: 'x', quantity: 1, type: 'digital' }])).toEqual([]);
  });
});

describe('order placement with live-class seats', () => {
  function makePayment(opts: { existing?: any[]; claimFails?: boolean; innerFails?: boolean } = {}) {
    const doc: any = { _id: P, name: 'Class', liveSession: { capacity: 1, seatsTaken: opts.claimFails ? 1 : 0, status: 'scheduled' } };
    const placed: any[] = [];
    const productModel: any = {
      find: jest.fn(() => chain([doc])),
      findOneAndUpdate: jest.fn((_f: any, u: any) => {
        const ok = doc.liveSession.seatsTaken + u.$inc['liveSession.seatsTaken'] <= doc.liveSession.capacity;
        if (ok) doc.liveSession.seatsTaken += u.$inc['liveSession.seatsTaken'];
        return chain(ok ? { _id: P } : null);
      }),
      updateOne: jest.fn(async (_f: any, u: any) => { if (u.$inc) doc.liveSession.seatsTaken += u.$inc['liveSession.seatsTaken']; return {}; }),
    };
    const orderModel: any = { find: jest.fn(async () => opts.existing ?? placed), countDocuments: jest.fn(async () => 0) };
    const svc: any = new PaymentService({ repositories: { productModel } } as any, {} as any, { get: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any, { log: jest.fn() } as any, {} as any, {} as any, {} as any);
    svc.createOrderInner = jest.fn(async () => { if (opts.innerFails) throw new Error('db down'); placed.push({ _id: 'o1' }); return placed; });
    return { svc, doc, productModel, orderModel };
  }
  const checkout = { _id: 'c1', items: [{ productId: P, type: 'digital', quantity: 1, name: 'Class' }] };

  it('a replayed placement (duplicate webhook) returns the existing orders and claims no second seat', async () => {
    const t = makePayment({ existing: [{ _id: 'o1' }] });
    const res = await t.svc.createOrder('u1', checkout, t.orderModel, {});
    expect(res).toEqual([{ _id: 'o1' }]);
    expect(t.productModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(t.svc.createOrderInner).not.toHaveBeenCalled();
    expect(t.doc.liveSession.seatsTaken).toBe(0);
  });

  it('claims one seat on a normal placement; a full class fails BEFORE any order exists (caller refunds a captured card)', async () => {
    const ok = makePayment();
    await ok.svc.createOrder('u1', checkout, ok.orderModel, {});
    expect(ok.doc.liveSession.seatsTaken).toBe(1);
    const full = makePayment({ claimFails: true });
    await expect(full.svc.createOrder('u1', checkout, full.orderModel, {})).rejects.toThrow(/full/);
    expect(full.svc.createOrderInner).not.toHaveBeenCalled();
  });

  it('gives the seat back when order creation fails', async () => {
    const t = makePayment({ innerFails: true });
    await expect(t.svc.createOrder('u1', checkout, t.orderModel, {})).rejects.toThrow('db down');
    expect(t.doc.liveSession.seatsTaken).toBe(0);
  });

  it('Cash on Delivery is refused for course and live-class items (they are digital) and no order is placed', async () => {
    const checkoutDoc: any = { _id: 'c1', userId: 'u1', status: 'pending', expiredAt: null, currency: 'USD', totalAmount: 10, orderPlacementStartedAt: null, fxSnapshots: [], items: [{ type: 'digital', storeId: 'A', variantId: 'v1', quantity: 1, name: 'Live class', totalPrice: 10, currency: 'USD' }] };
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
