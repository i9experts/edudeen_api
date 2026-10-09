/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { cleanLearningPathInput, LearningPathsService } from './learning-paths.service';

const P1 = '64b0000000000000000000a1';
const P2 = '64b0000000000000000000a2';

describe('cleanLearningPathInput', () => {
  const ok = { title: 'Class 3 - first term', educationLevel: 'primary_school', steps: [{ title: 'Maths', note: 'Start here', productIds: [P1, P1, 'nope', P2] }] };

  it('cleans a valid path: slug from title, dedupes and drops bad ids', () => {
    const out = cleanLearningPathInput(ok);
    expect(out.slug).toBe('class-3-first-term');
    expect(out.educationLevel).toBe('primary_school');
    expect(out.steps).toEqual([{ title: 'Maths', note: 'Start here', productIds: [P1, P2] }]);
  });
  it('requires a title and a title per step, and refuses an unknown grade', () => {
    expect(() => cleanLearningPathInput({ ...ok, title: '  ' })).toThrow(BadRequestException);
    expect(() => cleanLearningPathInput({ ...ok, steps: [{ title: '', productIds: [] }] })).toThrow(/needs a title/);
    expect(() => cleanLearningPathInput({ ...ok, educationLevel: 'wizard_school' })).toThrow(/Unknown grade/);
  });
  it('limits steps and picks', () => {
    expect(() => cleanLearningPathInput({ ...ok, steps: Array.from({ length: 13 }, () => ({ title: 'x', productIds: [] })) })).toThrow(/up to 12 steps/);
    const many = Array.from({ length: 13 }, (_, i) => `64b00000000000000000${String(1000 + i)}`);
    expect(() => cleanLearningPathInput({ ...ok, steps: [{ title: 'x', productIds: many }] })).toThrow(/up to 12 picks/);
  });
  it('will not make an empty path live', () => {
    expect(() => cleanLearningPathInput({ ...ok, status: 'active', steps: [{ title: 'Maths', productIds: [] }] })).toThrow(/at least one product/);
    expect(cleanLearningPathInput({ ...ok, status: 'active' }).status).toBe('active');
  });
  it('PATCH only touches the fields it is given', () => {
    expect(cleanLearningPathInput({ subtitle: 'New' }, true)).toEqual({ subtitle: 'New' });
    expect(cleanLearningPathInput({ educationLevel: '' }, true)).toEqual({ educationLevel: null });
  });
});

describe('LearningPathsService', () => {
  const doc = { _id: 'p1', title: 'Class 3', slug: 'class-3', status: 'active', educationLevel: 'primary_school', ageLabel: '', subtitle: 'Term 1', description: '', image: null, steps: [
    { _id: 's1', title: 'Maths', note: '', productIds: [P1] }, { _id: 's2', title: 'Urdu', note: '', productIds: [P2] },
  ] };
  const chain = (v: any) => ({ sort: () => chain(v), limit: () => chain(v), select: () => chain(v), lean: () => Promise.resolve(v), then: (r: any) => Promise.resolve(v).then(r) });
  const make = (found: any, live: string[] = [P1, P2]) => {
    const model: any = { findOne: jest.fn(() => chain(found)), find: jest.fn(() => chain(found ? [found] : [])) };
    const products: any = { getShapedProductsByIds: jest.fn(async (ids: string[]) => ids.filter((i) => live.includes(i)).map((_id) => ({ _id, name: `P${_id}`, digital: { files: [{ key: 'secret' }] } }))) };
    const lists: any = { create: jest.fn(async () => ({ data: { _id: 'L1', slug: 'reading-list-class-3-ab12' } })), addItem: jest.fn(async () => ({ data: { added: true } })) };
    return { svc: new LearningPathsService(model, products, {} as any, lists), lists, products };
  };

  it('returns live steps with their picks in order, with file keys stripped; empty/unavailable picks drop out', async () => {
    const { svc } = make(doc, [P2]);
    const r: any = await svc.bySlug('class-3', null);
    expect(r.data.steps.map((s: any) => s.title)).toEqual(['Maths', 'Urdu']);
    expect(r.data.steps[0].products).toEqual([]); // P1 is no longer live
    expect(r.data.steps[1].products).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('secret');
  });
  it('404s for a missing or draft path', async () => {
    await expect(make(null).svc.bySlug('nope', null)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('lists nothing when no path exists (empty state)', async () => {
    const r: any = await make(null).svc.list();
    expect(r.data).toEqual([]);
  });
  it('saves the whole path as a private reading list owned by the buyer', async () => {
    const { svc, lists } = make(doc);
    const r: any = await svc.saveToList('u1', 'class-3');
    expect(lists.create).toHaveBeenCalledWith('u1', expect.objectContaining({ name: 'Reading list: Class 3', isPublic: false }));
    expect(lists.addItem).toHaveBeenCalledTimes(2);
    expect(r.data).toMatchObject({ listId: 'L1', added: 2 });
  });
  it('refuses to save a path with nothing live in it', async () => {
    await expect(make(doc, []).svc.saveToList('u1', 'class-3')).rejects.toBeInstanceOf(BadRequestException);
  });
});
