/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CoursesService } from './courses.service';
import { cleanCertificateConfig, cleanCertificateDetails } from './course.util';

const P = '64b0000000000000000000a1';
const chain = (v: any) => ({ select: () => chain(v), lean: () => Promise.resolve(v), sort: () => chain(v), limit: () => chain(v), then: (r: any) => Promise.resolve(v).then(r) });
const DETAILS = { fullName: 'Ali Khan', guardianName: 'Khan Sahib', institute: 'City School', city: 'Lahore', country: 'Pakistan' };

function make(opts: { progress?: any; paid?: boolean; certificateEnabled?: boolean; config?: any } = {}) {
  const product = { _id: P, name: 'Algebra', slug: 'algebra', sellerId: 'seller1', storeId: 's1', status: 'active', deliveryFormat: 'course' };
  const course = {
    productId: P, certificateEnabled: opts.certificateEnabled ?? true, accessDays: null, instructor: { name: 'Ms Ayesha', bio: '' },
    certificateConfig: opts.config ?? null,
    sections: [{ _id: 's1', title: 'Intro', lessons: [{ _id: 'l1', title: 'Welcome', type: 'text', text: 'hi' }, { _id: 'l2', title: 'More', type: 'text', text: 'ok' }] }],
  };
  const date = new Date();
  const orders = opts.paid === false ? [] : [{ userId: 'buyer1', paidAt: date, createdAt: date }];
  const repos: any = {
    productModel: { findOne: jest.fn(() => chain(product)), findById: jest.fn(() => chain(product)) },
    courseModel: { findOne: jest.fn(() => chain(course)) },
    orderModel: { find: jest.fn(() => chain(orders)), findOne: jest.fn(() => chain(orders[0] ?? null)) },
    storeModel: { findById: jest.fn(() => chain({ name: 'Maths Store', slug: 'maths' })) },
    userModel: { findById: jest.fn(() => chain({ name: 'Account Name', email: 'secret@x.com' })) },
  };
  const progress: any = opts.progress ?? null;
  const progressModel: any = {
    findOne: jest.fn(() => chain(progress)),
    updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
    findOneAndUpdate: jest.fn(() => chain(progress ? { ...progress } : { _id: 'p1', completedLessonIds: [] })),
  };
  const svc = new CoursesService(progressModel, { repositories: repos } as any, {} as any, {} as any);
  return { svc, progressModel };
}

describe('certificate config validation', () => {
  it('accepts clean text and Cloudinary https images, null clears', () => {
    const c = cleanCertificateConfig({ watermarkText: ' EDUDEEN ', stampImageUrl: 'https://res.cloudinary.com/x/stamp.png', signatureName: 'Ms Ayesha' });
    expect(c.watermarkText).toBe('EDUDEEN');
    expect(c.stampImageUrl).toBe('https://res.cloudinary.com/x/stamp.png');
    expect(c.watermarkImageUrl).toBeNull();
    expect(cleanCertificateConfig(null)).toEqual({ watermarkText: null, watermarkImageUrl: null, stampImageUrl: null, signatureName: null, signatureTitle: null, issuerName: null });
  });
  it('rejects long text, markup, http and foreign image hosts', () => {
    expect(() => cleanCertificateConfig({ watermarkText: 'x'.repeat(41) })).toThrow(BadRequestException);
    expect(() => cleanCertificateConfig({ issuerName: '<b>x</b>' })).toThrow(BadRequestException);
    expect(() => cleanCertificateConfig({ stampImageUrl: 'http://res.cloudinary.com/a.png' })).toThrow(BadRequestException);
    expect(() => cleanCertificateConfig({ watermarkImageUrl: 'https://evil.example/a.png' })).toThrow(BadRequestException);
    expect(() => cleanCertificateConfig('nope')).toThrow(BadRequestException);
  });
});

describe('certificate details validation', () => {
  it('requires a 2-80 character name and trims', () => {
    expect(cleanCertificateDetails({ fullName: '  Ali Khan ' }).fullName).toBe('Ali Khan');
    expect(() => cleanCertificateDetails({ fullName: 'A' })).toThrow(BadRequestException);
    expect(() => cleanCertificateDetails({})).toThrow(BadRequestException);
    expect(() => cleanCertificateDetails({ fullName: 'Ali', institute: '<script>' })).toThrow(BadRequestException);
    expect(() => cleanCertificateDetails({ fullName: 'Ali', city: 'x'.repeat(61) })).toThrow(BadRequestException);
  });
});

describe('certificate issuing', () => {
  it('only an enrolled learner can save details', async () => {
    const { svc, progressModel } = make({ paid: false });
    await expect(svc.saveCertificateDetails('buyer1', P, DETAILS)).rejects.toBeInstanceOf(ForbiddenException);
    expect(progressModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('is locked once a certificate exists (409)', async () => {
    const { svc, progressModel } = make();
    progressModel.findOneAndUpdate.mockImplementation(() => chain(null)); // filter certificateCode:null matched nothing
    await expect(svc.saveCertificateDetails('buyer1', P, DETAILS)).rejects.toBeInstanceOf(ConflictException);
  });

  it('finishing the last lesson without details completes but does NOT issue', async () => {
    const { svc, progressModel } = make();
    progressModel.findOneAndUpdate.mockImplementation(() => chain({ _id: 'p1', completedLessonIds: ['l1', 'l2'], completedAt: null, certificateDetails: null, certificateCode: null }));
    const res: any = await svc.markComplete('buyer1', P, 'l2');
    expect(res.data.certificateDetailsRequired).toBe(true);
    expect(res.data.certificateCode).toBeNull();
    const set = progressModel.updateOne.mock.calls[0][1].$set;
    expect(set.completedAt).toBeInstanceOf(Date);
    expect(set.certificateCode).toBeUndefined();
  });

  it('finishing the last lesson WITH details issues using the typed name', async () => {
    const { svc, progressModel } = make();
    progressModel.findOneAndUpdate.mockImplementation(() => chain({ _id: 'p1', completedLessonIds: ['l1', 'l2'], completedAt: null, certificateDetails: DETAILS, certificateCode: null }));
    const res: any = await svc.markComplete('buyer1', P, 'l2');
    expect(res.data.certificateCode).toMatch(/^EDU-[0-9A-F]{8}$/);
    expect(res.data.certificateDetailsRequired).toBe(false);
    expect(progressModel.updateOne.mock.calls[0][1].$set.learnerName).toBe('Ali Khan');
  });

  it('saving details after the course is already finished issues the certificate then', async () => {
    const { svc, progressModel } = make();
    progressModel.findOneAndUpdate.mockImplementation(() => chain({ _id: 'p1', completedLessonIds: ['l1', 'l2'], completedAt: new Date(), certificateCode: null }));
    const res: any = await svc.saveCertificateDetails('buyer1', P, DETAILS);
    expect(res.data.certificateCode).toMatch(/^EDU-/);
    const [filter, upd] = progressModel.updateOne.mock.calls[0];
    expect(filter.certificateCode).toBeNull(); // atomic: never issues twice
    expect(upd.$set.learnerName).toBe('Ali Khan');
  });

  it('saving details mid-course just stores them', async () => {
    const { svc, progressModel } = make();
    progressModel.findOneAndUpdate.mockImplementation(() => chain({ _id: 'p1', completedLessonIds: ['l1'], completedAt: null, certificateCode: null }));
    const res: any = await svc.saveCertificateDetails('buyer1', P, DETAILS);
    expect(res.data.certificateCode).toBeNull();
    expect(progressModel.updateOne).not.toHaveBeenCalled();
  });

  it('is refused for a course without certificates', async () => {
    const { svc } = make({ certificateEnabled: false });
    await expect(svc.saveCertificateDetails('buyer1', P, DETAILS)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('learn view says when the form is still needed', async () => {
    const a = make({ progress: { completedLessonIds: [], certificateDetails: null, certificateCode: null } });
    expect(((await a.svc.getLearnView('buyer1', P)) as any).data.certificateDetailsRequired).toBe(true);
    const b = make({ progress: { completedLessonIds: [], certificateDetails: DETAILS, certificateCode: null } });
    const view: any = (await b.svc.getLearnView('buyer1', P)).data;
    expect(view.certificateDetailsRequired).toBe(false);
    expect(view.certificateDetails.fullName).toBe('Ali Khan');
  });
});

describe('public certificate', () => {
  const issued = { userId: 'buyer1', productId: P, certificateCode: 'EDU-AAAA1111', learnerName: 'Ali Khan', completedAt: new Date('2026-10-01'), certificateDetails: DETAILS };

  it('shows only the typed details + seller config, no e-mail or ids', async () => {
    const { svc } = make({ progress: issued, config: { watermarkText: 'MATHS', stampImageUrl: 'https://res.cloudinary.com/x/s.png', signatureName: 'Ms Ayesha' } });
    const d: any = (await svc.verifyCertificate('edu-aaaa1111')).data;
    expect(d).toMatchObject({ code: 'EDU-AAAA1111', learnerName: 'Ali Khan', guardianName: 'Khan Sahib', institute: 'City School', city: 'Lahore', country: 'Pakistan', courseTitle: 'Algebra', storeName: 'Maths Store', instructorName: 'Ms Ayesha' });
    expect(d.config).toEqual({ watermarkText: 'MATHS', watermarkImageUrl: null, stampImageUrl: 'https://res.cloudinary.com/x/s.png', signatureName: 'Ms Ayesha', signatureTitle: null, issuerName: null });
    const json = JSON.stringify(d);
    expect(json).not.toContain('secret@x.com');
    expect(json).not.toContain('buyer1');
  });

  it('an old certificate (no details, no config) still verifies', async () => {
    const { svc } = make({ progress: { userId: 'buyer1', productId: P, certificateCode: 'EDU-OLD00001', learnerName: 'Old Name', completedAt: new Date() } });
    const d: any = (await svc.verifyCertificate('EDU-OLD00001')).data;
    expect(d.learnerName).toBe('Old Name');
    expect(d.guardianName).toBeNull();
    expect(d.config).toEqual({ watermarkText: null, watermarkImageUrl: null, stampImageUrl: null, signatureName: null, signatureTitle: null, issuerName: null });
  });
});
