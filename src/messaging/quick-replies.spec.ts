import 'reflect-metadata';
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { QuickRepliesService } from './quick-replies.service';
import { CreateQuickReplyDto } from './dto/quick-reply.dto';
import { applyQuickReplyVars, DEFAULT_QUICK_REPLIES } from './quick-replies.util';

const OID = (n: number) => `64f0c0ffee0c0ffee0c0ff${String(n).padStart(2, '0')}`;
const SELLER = OID(2), STORE = OID(4);

function build(over: { owner?: string; count?: number; seeded?: boolean; existing?: boolean; keepIds?: string[] } = {}) {
  const created = { _id: OID(50), toObject() { return this; } };
  const chain = (v: any) => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => v }), lean: async () => v }) , select: () => ({ lean: async () => v }), lean: async () => v }) });
  const model: any = {
    countDocuments: jest.fn().mockResolvedValue(over.count ?? 0),
    findOne: jest.fn(() => chain(null)),
    find: jest.fn(() => chain((over.keepIds ?? [OID(50)]).map(_id => ({ _id })))),
    create: jest.fn().mockResolvedValue(created),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    exists: jest.fn().mockResolvedValue(over.existing ? { _id: 'x' } : null),
    insertMany: jest.fn().mockResolvedValue([]),
  };
  const stores: any = {
    findOne: jest.fn(() => ({ select: () => ({ lean: async () => ((over.owner ?? SELLER) === SELLER ? { _id: STORE } : null) }) })),
    findOneAndUpdate: jest.fn().mockResolvedValue(over.seeded ? null : { _id: STORE }),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const svc = new QuickRepliesService({ repositories: { storeModel: stores } } as any, model);
  return { svc, model, stores };
}

describe('quick replies', () => {
  it('51st reply = 400 "Maximum 50 quick replies"', async () => {
    const { svc, model } = build({ count: 50 });
    await expect(svc.create(SELLER, { storeId: STORE, title: 't', body: 'b', category: 'general' })).rejects.toThrow('Maximum 50 quick replies');
    expect(model.create).not.toHaveBeenCalled();
  });

  it('race: a create that is not among the oldest 50 is handed back', async () => {
    const { svc, model } = build({ count: 49, keepIds: [OID(60)] });
    await expect(svc.create(SELLER, { storeId: STORE, title: 't', body: 'b', category: 'general' })).rejects.toBeInstanceOf(BadRequestException);
    expect(model.deleteOne).toHaveBeenCalledWith({ _id: OID(50) });
  });

  it('another seller gets 403 on every route and nothing is touched', async () => {
    const { svc, model } = build({ owner: OID(9) });
    await expect(svc.list(OID(9), STORE)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.create(OID(9), { storeId: STORE, title: 't', body: 'b', category: 'general' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.update(OID(9), OID(5), { storeId: STORE, title: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.remove(OID(9), OID(5), STORE)).rejects.toBeInstanceOf(ForbiddenException);
    expect(model.create).not.toHaveBeenCalled();
    expect(model.deleteOne).not.toHaveBeenCalled();
  });

  it('defaults are seeded once: first list inserts 3, a flagged store inserts nothing', async () => {
    const a = build();
    await a.svc.list(SELLER, STORE);
    expect(a.model.insertMany).toHaveBeenCalledTimes(1);
    expect(a.model.insertMany.mock.calls[0][0]).toHaveLength(3);
    const b = build({ seeded: true });
    await b.svc.list(SELLER, STORE);
    expect(b.model.insertMany).not.toHaveBeenCalled();
  });

  it('refund default makes no promise and points to the Returns policy', () => {
    const r = DEFAULT_QUICK_REPLIES.find(d => d.category === 'refund_policy')!;
    expect(r.body).toMatch(/only if they have not been downloaded/);
    expect(r.body).toMatch(/Returns policy/);
    expect(r.body).not.toMatch(/guarantee|always|full refund/i);
  });

  it('variables: known replaced, unknown and empty kept as typed', () => {
    expect(applyQuickReplyVars('Hi {buyer_name} from {store_name} {order_id}', { buyer_name: 'Ayesha', store_name: 'Noor' })).toBe('Hi Ayesha from Noor {order_id}');
    expect(applyQuickReplyVars('Hi {buyer_name}', {})).toBe('Hi {buyer_name}');
  });

  it('dto trims, limits and needs an allowed category', async () => {
    const errs = async (b: object) => (await validate(plainToInstance(CreateQuickReplyDto, b))).map(e => e.property);
    expect(await errs({ storeId: STORE, title: '   ', body: 'x', category: 'general' })).toContain('title');
    expect(await errs({ storeId: STORE, title: 'a'.repeat(61), body: 'x', category: 'general' })).toContain('title');
    expect(await errs({ storeId: STORE, title: 'a', body: 'x'.repeat(1001), category: 'general' })).toContain('body');
    expect(await errs({ storeId: STORE, title: 'a', body: 'x', category: 'nope' })).toContain('category');
    expect(await errs({ storeId: STORE, title: ' a ', body: ' x ', category: 'general' })).toEqual([]);
  });
});
