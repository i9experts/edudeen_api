/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProductQuestionsService } from './product-questions.service';
import { bundleSavings, cleanBundleInput } from './bundle.util';
import { cleanCollectionInput } from './curated-collections.service';
import { cleanCourseInput, scoreQuiz } from './course.util';
import { cleanDeliveryFormat } from '../products/product-input.util';

const P1 = '64b0000000000000000000a1';
const Q1 = '64b0000000000000000000c1';
const chain = (v: any) => ({ select: () => chain(v), lean: () => Promise.resolve(v), sort: () => chain(v), limit: () => chain(v), catch: () => Promise.resolve(v), then: (r: any) => Promise.resolve(v).then(r) });

describe('Product Q&A', () => {
  const product = { _id: P1, name: 'Algebra', slug: 'algebra', storeId: 's1', sellerId: 'seller1', status: 'active' };
  const make = (q: any = null, todayCount = 0) => {
    const questionModel: any = {
      countDocuments: jest.fn(() => Promise.resolve(todayCount)),
      create: jest.fn((d: any) => Promise.resolve({ _id: Q1, ...d })),
      findById: jest.fn(() => Promise.resolve(q)),
      find: jest.fn(() => chain([])),
    };
    const repos: any = { productModel: { findOne: jest.fn(() => chain(product)) }, userModel: { findById: () => chain({ name: 'Bilal' }) } };
    const notify = jest.fn();
    return { svc: new ProductQuestionsService(questionModel, { repositories: repos } as any, { notify } as any), questionModel, notify };
  };

  it('saves a question and notifies the seller', async () => {
    const { svc, questionModel, notify } = make();
    await svc.ask('u1', 'algebra', { question: 'Is this for the Punjab board?' });
    expect(questionModel.create).toHaveBeenCalledWith(expect.objectContaining({ productId: P1, storeId: 's1', askerId: 'u1', askerName: 'Bilal' }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'seller1', type: 'product_question' }));
  });

  it('blocks too-short questions, the seller asking themselves, and daily spam', async () => {
    await expect(make().svc.ask('u1', 'algebra', { question: 'hi' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make().svc.ask('seller1', 'algebra', { question: 'Is this any good at all?' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make(null, 20).svc.ask('u1', 'algebra', { question: 'Is this any good at all?' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('only shows answered questions publicly, plus the viewer\'s own', async () => {
    const { svc, questionModel } = make();
    await svc.listForProduct('algebra', null);
    expect(questionModel.find.mock.calls[0][0].$or).toEqual([{ answeredAt: { $ne: null }, hidden: false }]);
    await svc.listForProduct('algebra', 'u1');
    expect(questionModel.find.mock.calls[1][0].$or).toHaveLength(2);
  });

  it('keeps answered questions from being deleted by the asker', async () => {
    const { svc } = make({ askerId: 'u1', answeredAt: new Date(), deleteOne: jest.fn() });
    await expect(svc.deleteOwn('u1', Q1)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Bundles', () => {
  const A = '64b0000000000000000000d1';
  const B = '64b0000000000000000000d2';
  const bundle = { productIds: [A, B], discountPercent: 20 };

  it('saves only when every item is in the cart', () => {
    expect(bundleSavings(bundle, [{ productId: A, quantity: 1, totalPrice: 600 }])).toBe(0);
    expect(bundleSavings(bundle, [{ productId: A, quantity: 1, totalPrice: 600 }, { productId: B, quantity: 1, totalPrice: 400 }])).toBe(200);
  });

  it('discounts complete sets only', () => {
    // 3 × A + 1 × B is one set: 20% of (200 + 400)
    expect(bundleSavings(bundle, [{ productId: A, quantity: 3, totalPrice: 600 }, { productId: B, quantity: 1, totalPrice: 400 }])).toBe(120);
    expect(bundleSavings(bundle, [{ productId: A, quantity: 2, totalPrice: 400 }, { productId: B, quantity: 2, totalPrice: 800 }])).toBe(240);
  });

  it('validates the bundle form', () => {
    expect(cleanBundleInput({ name: 'Grade 5 pack', productIds: [A, B, A], discountPercent: 15.4 })).toEqual(expect.objectContaining({ productIds: [A, B], discountPercent: 15 }));
    expect(() => cleanBundleInput({ name: 'x', productIds: [A], discountPercent: 15 })).toThrow(BadRequestException);
    expect(() => cleanBundleInput({ name: 'x', productIds: [A, B], discountPercent: 90 })).toThrow(BadRequestException);
    expect(() => cleanBundleInput({ name: '', productIds: [A, B], discountPercent: 10 })).toThrow(BadRequestException);
    expect(cleanBundleInput({ isActive: false }, true)).toEqual({ isActive: false });
  });
});

describe('Curated collections', () => {
  it('builds a slug from the title and cleans the rule', () => {
    const out = cleanCollectionInput({ title: 'Exam ki Tayyari 2027!', rule: { curriculum: 'punjab', tags: [' Past Papers ', ''], categoryId: 'nope' } });
    expect(out.slug).toBe('exam-ki-tayyari-2027');
    expect(out.rule).toEqual({ educationLevel: null, curriculum: 'punjab', categoryId: null, tags: ['past papers'] });
  });

  it('rejects an unknown board and a backwards season', () => {
    expect(() => cleanCollectionInput({ title: 'X', rule: { curriculum: 'mars' } })).toThrow(BadRequestException);
    expect(() => cleanCollectionInput({ title: 'X', startsAt: '2027-03-01', endsAt: '2027-02-01' })).toThrow(BadRequestException);
  });

  it('only touches sent fields on update', () => {
    expect(cleanCollectionInput({ status: 'active' }, true)).toEqual({ status: 'active' });
  });
});

describe('Course builder input', () => {
  const quizLesson = { title: 'Check', type: 'quiz', quiz: { passPercent: 50, questions: [{ question: '2+2?', options: ['3', '4'], answerIndex: 1 }, { question: '3+3?', options: ['6', '7'], answerIndex: 0 }] } };

  it('keeps valid lesson ids, makes new ones, and collects files to check', () => {
    const out = cleanCourseInput({ sections: [{ _id: 'aaaaaaaaaaaa', title: 'Week 1', lessons: [
      { _id: 'bbbbbbbbbbbb', title: 'Intro', type: 'video', file: { url: 'private/x/v1', name: 'intro.mp4' }, isPreview: true },
      { _id: 'bad', title: 'Notes', type: 'text', text: 'Read this' },
      quizLesson,
    ] }] });
    expect(out.sections[0]._id).toBe('aaaaaaaaaaaa');
    expect(out.sections[0].lessons[0]._id).toBe('bbbbbbbbbbbb');
    expect(out.sections[0].lessons[1]._id).toMatch(/^[a-f0-9]{12}$/);
    expect(out.fileRefs).toEqual([{ url: 'private/x/v1', name: 'intro.mp4' }]);
    expect(out.sections[0].lessons[2].isPreview).toBe(false);
  });

  it('rejects lessons that are missing their content', () => {
    expect(() => cleanCourseInput({ sections: [{ title: 'A', lessons: [{ title: 'V', type: 'video' }] }] })).toThrow(BadRequestException);
    expect(() => cleanCourseInput({ sections: [{ title: 'A', lessons: [{ title: 'T', type: 'text', text: '' }] }] })).toThrow(BadRequestException);
    expect(() => cleanCourseInput({ sections: [{ title: 'A', lessons: [{ title: 'Q', type: 'quiz', quiz: { questions: [{ question: 'x', options: ['a', 'b'], answerIndex: 5 }] } }] }] })).toThrow(BadRequestException);
    expect(() => cleanCourseInput({ sections: 'nope' })).toThrow(BadRequestException);
  });

  it('scores quizzes against the pass mark', () => {
    const quiz = cleanCourseInput({ sections: [{ title: 'A', lessons: [quizLesson] }] }).sections[0].lessons[0].quiz!;
    expect(scoreQuiz(quiz, [1, 0])).toEqual({ correct: 2, total: 2, percent: 100, passed: true });
    expect(scoreQuiz(quiz, [0, 0])).toEqual(expect.objectContaining({ percent: 50, passed: true }));
    expect(scoreQuiz(quiz, [0, 1])).toEqual(expect.objectContaining({ percent: 0, passed: false }));
  });
});

describe('Delivery format', () => {
  it('accepts download and course; live classes are retired (clear 400)', () => {
    expect(cleanDeliveryFormat({ deliveryFormat: 'course' }, null)).toEqual({ deliveryFormat: 'course' });
    expect(cleanDeliveryFormat({ deliveryFormat: 'download' }, null)).toEqual({ deliveryFormat: 'download' });
    expect(() => cleanDeliveryFormat({ deliveryFormat: 'live_class' }, null)).toThrow(/no longer available/);
    expect(() => cleanDeliveryFormat({ deliveryFormat: 'nope' }, null)).toThrow(BadRequestException);
  });
});