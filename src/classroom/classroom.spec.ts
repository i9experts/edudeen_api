/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SavedListsService } from './saved-lists.service';
import { ProductQuestionsService } from './product-questions.service';
import { QuoteRequestsService, cleanQuoteInput } from './quote-requests.service';
import { bundleSavings, cleanBundleInput } from './bundle.util';
import { cleanCollectionInput } from './curated-collections.service';
import { cleanCourseInput, scoreQuiz } from './course.util';
import { cleanDeliveryFormat } from '../products/product-input.util';
import { sanitizeDigitalForPublicView } from '../products/product-public-view.util';

const P1 = '64b0000000000000000000a1';
const L1 = '64b0000000000000000000b1';
const Q1 = '64b0000000000000000000c1';
const chain = (v: any) => ({ select: () => chain(v), lean: () => Promise.resolve(v), sort: () => chain(v), limit: () => chain(v), catch: () => Promise.resolve(v), then: (r: any) => Promise.resolve(v).then(r) });

describe('Teacher lists', () => {
  const listDoc = (over: any = {}) => {
    const doc: any = { _id: L1, userId: 'u1', name: 'Term 1', items: [], save: jest.fn(), deleteOne: jest.fn(), markModified: jest.fn(), ...over };
    return doc;
  };
  const make = (doc: any, product: any = { _id: P1 }) => {
    const listModel: any = { findById: jest.fn(() => Promise.resolve(doc)), findOne: jest.fn(() => chain(doc)) };
    const repos: any = { productModel: { exists: jest.fn(() => Promise.resolve(product)) }, userModel: { findById: () => chain({ name: 'Ayesha Khan' }) } };
    const products: any = { getShapedProductsByIds: jest.fn(() => Promise.resolve([{ _id: P1, name: 'Algebra', digital: { files: [{ key: 'secret' }] } }])) };
    return new SavedListsService(listModel, { repositories: repos } as any, products);
  };

  it('adds a product once and refuses another user', async () => {
    const doc = listDoc();
    const svc = make(doc);
    await svc.addItem('u1', L1, { productId: P1, note: 'week 2' });
    expect(doc.items).toEqual([expect.objectContaining({ productId: P1, note: 'week 2' })]);
    const again: any = await svc.addItem('u1', L1, { productId: P1 });
    expect(again.data.added).toBe(false);
    await expect(svc.addItem('u2', L1, { productId: P1 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a product that is not live', async () => {
    await expect(make(listDoc(), null).addItem('u1', L1, { productId: P1 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hides a private list from everyone but its owner, and strips file keys from public view', async () => {
    const doc = listDoc({ isPublic: false, slug: 'term-1-abcd', items: [{ productId: P1, note: 'n' }] });
    await expect(make(doc).getBySlug('term-1-abcd', 'u2')).rejects.toBeInstanceOf(NotFoundException);
    await expect(make(doc).getBySlug('term-1-abcd', null)).rejects.toBeInstanceOf(NotFoundException);
    const own: any = await make(doc).getBySlug('term-1-abcd', 'u1');
    expect(own.data.isOwner).toBe(true);
    expect(own.data.ownerName).toBe('Ayesha');
    expect(own.data.items[0].note).toBe('n');
    expect(JSON.stringify(own.data.items[0].product)).not.toContain('secret');
  });
});

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

describe('School quote requests', () => {
  const valid = { institutionName: 'City School', contactName: 'Sana', contactPhone: '0300 1234567', quantity: 40, institutionType: 'madrasa' };

  it('validates the request form', () => {
    expect(cleanQuoteInput(valid)).toEqual(expect.objectContaining({ institutionName: 'City School', quantity: 40, institutionType: 'madrasa' }));
    expect(cleanQuoteInput({ ...valid, institutionType: 'hacker' }).institutionType).toBe('school');
    expect(() => cleanQuoteInput({ ...valid, quantity: 1 })).toThrow(BadRequestException);
    expect(() => cleanQuoteInput({ ...valid, quantity: 2.5 })).toThrow(BadRequestException);
    expect(() => cleanQuoteInput({ ...valid, contactPhone: 'abc' })).toThrow(BadRequestException);
    expect(() => cleanQuoteInput({ ...valid, institutionName: ' ' })).toThrow(BadRequestException);
  });

  const quoteDoc = (over: any = {}) => ({ _id: Q1, buyerId: 'u1', sellerId: 'seller1', storeId: 's1', quantity: 40, productName: 'Algebra', institutionName: 'City School', status: 'pending', offer: null, save: jest.fn(), toObject() { return this; }, ...over });
  const make = (q: any) => {
    const quoteModel: any = { findOne: jest.fn(() => Promise.resolve(q)), findById: jest.fn(() => Promise.resolve(q)) };
    const repos: any = { storeModel: { findById: jest.fn(() => Promise.resolve({ _id: 's1', sellerId: 'seller1', baseCurrency: 'PKR', isDelete: false })) } };
    const notify = jest.fn();
    return { svc: new QuoteRequestsService(quoteModel, { repositories: repos } as any, { notify } as any), notify };
  };

  it('prices the whole order from the unit price and notifies the buyer', async () => {
    const q = quoteDoc();
    const { svc, notify } = make(q);
    await svc.sendOffer('s1', 'seller1', Q1, { unitPrice: 350 });
    expect(q.status).toBe('quoted');
    expect(q.offer).toEqual(expect.objectContaining({ unitPrice: 350, totalPrice: 14000, currency: 'PKR' }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'u1', type: 'quote_sent' }));
  });

  it('will not let another seller price it', async () => {
    await expect(make(quoteDoc()).svc.sendOffer('s1', 'seller2', Q1, { unitPrice: 350 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets the buyer accept only a live quote', async () => {
    await expect(make(quoteDoc()).svc.respondAsBuyer('u1', Q1, 'accept')).rejects.toBeInstanceOf(BadRequestException);
    const expired = quoteDoc({ status: 'quoted', offer: { unitPrice: 1, totalPrice: 40, currency: 'PKR', validUntil: new Date(Date.now() - 1000) } });
    await expect(make(expired).svc.respondAsBuyer('u1', Q1, 'accept')).rejects.toBeInstanceOf(BadRequestException);
    const live = quoteDoc({ status: 'quoted', offer: { unitPrice: 1, totalPrice: 40, currency: 'PKR', validUntil: null } });
    const { svc, notify } = make(live);
    await svc.respondAsBuyer('u1', Q1, 'accept');
    expect(live.status).toBe('accepted');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'seller1', type: 'quote_accepted' }));
    await expect(make(quoteDoc()).svc.respondAsBuyer('u9', Q1, 'cancel')).rejects.toBeInstanceOf(NotFoundException);
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

describe('Live classes', () => {
  const soon = new Date(Date.now() + 3 * 864e5).toISOString();
  const live = { startsAt: soon, durationMinutes: 60, meetingUrl: 'https://zoom.us/j/123', platform: 'zoom', capacity: 30 };

  it('needs a future time, sensible length and an https link', () => {
    expect(cleanDeliveryFormat({ deliveryFormat: 'live_class', liveSession: live }, null).liveSession).toEqual(expect.objectContaining({ durationMinutes: 60, capacity: 30, platform: 'zoom' }));
    expect(() => cleanDeliveryFormat({ deliveryFormat: 'live_class' }, null)).toThrow(BadRequestException);
    expect(() => cleanDeliveryFormat({ deliveryFormat: 'live_class', liveSession: { ...live, startsAt: '2020-01-01' } }, null)).toThrow(BadRequestException);
    expect(() => cleanDeliveryFormat({ deliveryFormat: 'live_class', liveSession: { ...live, meetingUrl: 'http://zoom.us/j/1' } }, null)).toThrow(BadRequestException);
    expect(() => cleanDeliveryFormat({ deliveryFormat: 'live_class', liveSession: { ...live, durationMinutes: 5 } }, null)).toThrow(BadRequestException);
  });

  it('lets an already-past start time stay when editing other fields', () => {
    const past = new Date('2026-01-01T10:00:00Z');
    const out = cleanDeliveryFormat({ liveSession: { ...live, startsAt: past.toISOString() } }, { deliveryFormat: 'live_class', liveSession: { startsAt: past } });
    expect(out.liveSession.startsAt.getTime()).toBe(past.getTime());
  });

  it('clears the session when switching back to downloads', () => {
    expect(cleanDeliveryFormat({ deliveryFormat: 'download' }, { deliveryFormat: 'live_class', liveSession: live })).toEqual({ deliveryFormat: 'download', liveSession: null });
  });

  it('never shows the meeting link publicly', () => {
    const shown: any = sanitizeDigitalForPublicView({ name: 'Class', liveSession: { ...live } } as any);
    expect(shown.liveSession.meetingUrl).toBeUndefined();
    expect(shown.liveSession.durationMinutes).toBe(60);
  });
});