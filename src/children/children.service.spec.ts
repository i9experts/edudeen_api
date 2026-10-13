/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ChildrenService, MAX_CHILDREN, cleanChildInput } from './children.service';

const OID = (n: number) => `64b0000000000000000000${String(n).padStart(2, '0')}`;

function fakeModel() {
  const docs: any[] = [];
  const chain = (arr: any[]) => ({ sort: () => chain(arr), lean: () => Promise.resolve(arr) });
  return {
    docs,
    find: jest.fn((q: any) => chain(docs.filter((d) => d.userId === q.userId))),
    countDocuments: jest.fn(async (q: any) => docs.filter((d) => d.userId === q.userId).length),
    create: jest.fn(async (d: any) => { const row = { _id: OID(docs.length + 1), ...d, toObject() { return { ...this }; } }; docs.push(row); return row; }),
    findOneAndUpdate: jest.fn((q: any, u: any) => ({ lean: async () => { const d = docs.find((x) => x._id === q._id && x.userId === q.userId); if (d) Object.assign(d, u.$set); return d ?? null; } })),
    deleteOne: jest.fn(async (q: any) => { const i = docs.findIndex((x) => x._id === q._id && x.userId === q.userId); if (i >= 0) docs.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; }),
  };
}

describe('cleanChildInput', () => {
  it('accepts a valid child and trims', () => {
    expect(cleanChildInput({ name: ' Ali ', educationLevel: 'primary_school', gradeLabel: 'Class 3', age: 8, subjects: ['Maths', ' Maths ', 'Urdu'] }))
      .toEqual({ name: 'Ali', educationLevel: 'primary_school', gradeLabel: 'Class 3', age: 8, subjects: ['Maths', 'Urdu'] });
  });
  it('rejects bad name, level, age, subjects', () => {
    expect(() => cleanChildInput({ name: '', educationLevel: 'college' })).toThrow(BadRequestException);
    expect(() => cleanChildInput({ name: 'A', educationLevel: 'grade-3' })).toThrow(BadRequestException);
    expect(() => cleanChildInput({ name: 'A', educationLevel: 'college', age: 1 })).toThrow(BadRequestException);
    expect(() => cleanChildInput({ name: 'A', educationLevel: 'college', age: 8.5 })).toThrow(BadRequestException);
    expect(() => cleanChildInput({ name: 'A', educationLevel: 'college', subjects: 'x' })).toThrow(BadRequestException);
  });
  it('partial only returns provided keys', () => {
    expect(cleanChildInput({ age: null }, true)).toEqual({ age: null });
  });
});

describe('ChildrenService', () => {
  it('creates, lists only own children, enforces the cap', async () => {
    const m = fakeModel();
    const svc = new ChildrenService(m as any);
    for (let i = 0; i < MAX_CHILDREN; i++) await svc.create('u1', { name: `K${i}`, educationLevel: 'preschool' });
    await expect(svc.create('u1', { name: 'extra', educationLevel: 'preschool' })).rejects.toThrow(BadRequestException);
    await svc.create('u2', { name: 'Other', educationLevel: 'college' });
    expect((await svc.list('u1')).data).toHaveLength(MAX_CHILDREN);
    expect((await svc.list('u2')).data).toHaveLength(1);
  });

  it('cannot update or delete another buyer\'s child', async () => {
    const m = fakeModel();
    const svc = new ChildrenService(m as any);
    const created: any = (await svc.create('u1', { name: 'Ali', educationLevel: 'preschool' })).data;
    await expect(svc.update('u2', created._id, { name: 'Hack' })).rejects.toThrow(NotFoundException);
    await expect(svc.remove('u2', created._id)).rejects.toThrow(NotFoundException);
    await expect(svc.update('u1', 'not-an-id', { name: 'x' })).rejects.toThrow(NotFoundException);
    const upd: any = await svc.update('u1', created._id, { name: 'Ahmed' });
    expect(upd.data.name).toBe('Ahmed');
    expect((await svc.remove('u1', created._id)).data.deleted).toBe(true);
  });
});
