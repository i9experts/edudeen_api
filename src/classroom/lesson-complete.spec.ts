/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { CoursesService } from './courses.service';

// "Mark complete" on a voice / video lesson is decided by the SERVER: the credited play time must reach 90% of the lesson
// length. Seeking to the end, or a client that says "finished", is not enough.
const P = '64b0000000000000000000a1';
const LESSON_SECONDS = 600; // durationMinutes 10
const chain = (v: any) => ({ select: () => chain(v), lean: () => Promise.resolve(v), sort: () => chain(v), limit: () => chain(v), then: (r: any) => Promise.resolve(v).then(r) });

function make(opts: { played?: any; completed?: string[] } = {}) {
  const product = { _id: P, name: 'Course', slug: 'course', sellerId: 'seller1', storeId: 's1', status: 'active', deliveryFormat: 'course' };
  const course = {
    productId: P, certificateEnabled: false, accessDays: null,
    sections: [{ _id: 's1', title: 'Intro', lessons: [
      { _id: 'la', title: 'Voice', type: 'audio', file: { url: 'private/v.wav', name: 'v.wav', mimeType: 'audio/wav' }, videoUrl: null, durationMinutes: 10 },
      { _id: 'lv', title: 'Video', type: 'video', file: { url: 'private/v.mp4', name: 'v.mp4', mimeType: 'video/mp4' }, videoUrl: null, durationMinutes: 10 },
      { _id: 'lt', title: 'Text', type: 'text', text: 'Read this', durationMinutes: 2 },
    ] }],
  };
  const date = new Date();
  const orders = [{ userId: 'buyer1', paidAt: date, createdAt: date }];
  const repos: any = {
    productModel: { findOne: jest.fn(() => chain(product)) },
    courseModel: { findOne: jest.fn(() => chain(course)) },
    orderModel: { find: jest.fn(() => chain(orders)), findOne: jest.fn(() => chain(orders[0])) },
  };
  const progress = opts.played !== undefined || opts.completed ? { completedLessonIds: opts.completed ?? [], lessonPlayed: opts.played ?? {} } : null;
  const progressModel: any = {
    findOne: jest.fn(() => chain(progress)),
    findOneAndUpdate: jest.fn(() => chain({ _id: 'pg1', completedLessonIds: ['la'] })),
    updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
  };
  const svc = new CoursesService(progressModel, { repositories: repos } as any, {} as any, {} as any);
  return { svc, progressModel };
}
const played = (seconds: number, durationSeconds: number | null = LESSON_SECONDS) => ({ seconds, durationSeconds, lastAt: new Date() });

describe('lesson completion needs real play time (server-side)', () => {
  it.each(['la', 'lv'])('%s: seeking straight to the end (no credited time) is refused and nothing is saved', async (lessonId) => {
    const { svc, progressModel } = make(); // the player never reported any playing
    await expect(svc.markComplete('buyer1', P, lessonId)).rejects.toBeInstanceOf(BadRequestException);
    expect(progressModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each(['la', 'lv'])('%s: only half played is refused', async (lessonId) => {
    const { svc, progressModel } = make({ played: { [lessonId]: played(300) } });
    await expect(svc.markComplete('buyer1', P, lessonId)).rejects.toThrow(/90%/);
    expect(progressModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('one second below 90% is refused, exactly 90% is accepted', async () => {
    const below = make({ played: { la: played(539) } });
    await expect(below.svc.markComplete('buyer1', P, 'la')).rejects.toBeInstanceOf(BadRequestException);
    const exact = make({ played: { la: played(540) } });
    const res = await exact.svc.markComplete('buyer1', P, 'la');
    expect(res.success).toBe(true);
    expect(exact.progressModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('the client cannot lower the length: a tiny reported duration is ignored, the declared length decides', async () => {
    // The player claims the file is 20 s long and 20 s were "played"; the lesson is declared 10 minutes.
    const { svc } = make({ played: { la: played(20, 20) } });
    await expect(svc.markComplete('buyer1', P, 'la')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a lesson already completed earlier stays completable (old progress keeps working)', async () => {
    const { svc } = make({ completed: ['la'], played: {} });
    await expect(svc.markComplete('buyer1', P, 'la')).resolves.toMatchObject({ success: true });
  });

  it('the course seller is not held to the rule (can preview their own lesson)', async () => {
    const { svc } = make();
    await expect(svc.markComplete('seller1', P, 'la')).resolves.toMatchObject({ success: true });
  });

  it('a text lesson keeps its old rule (no play-time check)', async () => {
    const { svc } = make();
    await expect(svc.markComplete('buyer1', P, 'lt')).resolves.toMatchObject({ success: true });
  });

  it('credit is capped by real elapsed time: one report of 600 s gives at most 15 s, so a script cannot fast-forward', async () => {
    const { svc, progressModel } = make();
    const res = await svc.recordPlayed('buyer1', P, 'la', { seconds: 600, durationSeconds: LESSON_SECONDS });
    expect(res.data.seconds).toBeLessThanOrEqual(15);
    expect(res.data.enough).toBe(false);
    const written = (progressModel.updateOne.mock.calls[0] as any[])[1].$set['lessonPlayed.la'];
    expect(written.seconds).toBeLessThanOrEqual(15);
  });

  it('quick follow-up reports cannot add more than the time that really passed', async () => {
    const { svc } = make({ played: { la: played(100) } }); // lastAt = just now
    const res = await svc.recordPlayed('buyer1', P, 'la', { seconds: 30, durationSeconds: LESSON_SECONDS });
    expect(res.data.seconds).toBeLessThan(105); // 100 + at most the 2 s slack, not +30
  });
});
