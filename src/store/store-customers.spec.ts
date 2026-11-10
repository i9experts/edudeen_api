/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { NotFoundException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { StoreCustomersService } from './store-customers.service';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import {
  cleanNoteInput, maskEmail, maskPhone, parsePhoneQuery, phoneMatches, sortCustomerRows,
} from './store-customers.util';

const STORE = '64f0c0ffee0c0ffee0c0ff01';
const BUYER = '64f0c0ffee0c0ffee0c0ff02';
const BUYER2 = '64f0c0ffee0c0ffee0c0ff03';
const OWNER_BUYER = '64f0c0ffee0c0ffee0c0ff04';

const lean = (v: any) => { const p: any = Promise.resolve(v); p.lean = () => Promise.resolve(v); p.select = () => p; p.sort = () => p; p.limit = () => p; p.skip = () => p; return p; };

function make(opts: { notes?: Map<string, any>; ordered?: string[]; follows?: string[]; users?: any[] } = {}) {
  const notes = opts.notes ?? new Map<string, any>();
  const users = opts.users ?? [
    { _id: BUYER, name: 'Sara', email: 'sara.khan5@gmail.com', phone: '0317 2060161', createdAt: new Date('2025-01-01') },
    { _id: BUYER2, name: 'Ali', email: 'ali@x.co', phone: '+923001234567', createdAt: new Date('2025-02-01') },
    { _id: OWNER_BUYER, name: 'Owner', email: 'owner@edudeen.test', phone: '03111111111', createdAt: new Date('2024-01-01') },
  ];
  const repos: any = {
    storeModel: { findOne: jest.fn(() => lean({ _id: STORE, sellerId: 'seller1' })) },
    sellerModel: { findById: jest.fn(() => lean({ email: 'owner@edudeen.test' })) },
    userModel: {
      findOne: jest.fn(() => lean({ _id: OWNER_BUYER })),
      findById: jest.fn((id: string) => lean(users.find((u) => String(u._id) === id) ?? null)),
      find: jest.fn((q: any) => {
        const ids: string[] | undefined = q?._id?.$in;
        let r = users.filter((u) => !ids || ids.includes(String(u._id)));
        if (q?.$or) { const rx: RegExp = q.$or[0].name; r = r.filter((u) => rx.test(u.name) || rx.test(u.email)); }
        if (q?.phone) r = r.filter((u) => u.phone);
        return lean(r);
      }),
    },
    orderModel: {
      distinct: jest.fn(async () => [BUYER, BUYER2, OWNER_BUYER]),
      exists: jest.fn(async (q: any) => ((opts.ordered ?? [BUYER]).includes(q.userId) ? { _id: 'o' } : null)),
      aggregate: jest.fn(async (p: any[]) => {
        const ids: string[] = p[0].$match.userId.$in;
        return ids.filter((id) => !opts.ordered || opts.ordered.includes(id)).map((id, i) => ({ _id: id, orderCount: 3 - i, totalSpent: 0, freeOrderCount: 1, firstOrderAt: new Date('2025-03-01'), lastOrderAt: new Date(`2025-04-0${i + 1}`) }));
      }),
      find: jest.fn(() => lean([{ _id: 'o1', orderNumber: 'ORD-1', isFreeClaim: true, createdAt: new Date(), sellerOrders: [{ storeId: STORE, status: 'delivered', subtotal: 0, items: [{}, {}] }] }])),
    },
    conversationModel: { findOne: jest.fn(() => lean({ _id: 'conv1' })) },
    storeFollowerModel: {
      exists: jest.fn(async (q: any) => ((opts.follows ?? []).includes(q.userId) ? { _id: 'f' } : null)),
      countDocuments: jest.fn(async () => 1),
      find: jest.fn(() => lean([{ userId: BUYER, createdAt: new Date() }])),
    },
  };
  const noteModel: any = {
    findOne: jest.fn((q: any) => lean(notes.get(`${q.storeId}:${q.buyerId}`) ?? null)),
    findOneAndUpdate: jest.fn((q: any, u: any) => { const d = { ...q, ...u.$set }; notes.set(`${q.storeId}:${q.buyerId}`, d); return lean(d); }),
    deleteOne: jest.fn(async (q: any) => { notes.delete(`${q.storeId}:${q.buyerId}`); }),
  };
  const svc = new StoreCustomersService({ repositories: repos } as any, noteModel);
  return { svc, repos, noteModel, notes };
}

describe('seller can never edit a buyer', () => {
  it('no PATCH route / service method for customers exists any more', () => {
    expect((StoreController.prototype as any).updateStoreCustomer).toBeUndefined();
    expect((StoreService.prototype as any).updateStoreCustomer).toBeUndefined();
  });

  it('the customers controller exposes only GET + the note PUT', () => {
    const methods = ['getStoreCustomers', 'getStoreCustomer', 'getStoreFollowers', 'saveCustomerNote'] as const;
    // RequestMethod: GET = 0, PUT = 2 (nest). PATCH (4) must not appear on the customers routes.
    const seen = methods.map((m) => Reflect.getMetadata('method', (StoreController.prototype as any)[m]));
    expect(seen).toEqual([0, 0, 0, 2]);
  });
});

describe('masking', () => {
  it('masks e-mail and phone', () => {
    expect(maskEmail('sara.khan5@gmail.com')).toBe('s***5@gmail.com');
    expect(maskEmail('ab@x.co')).toBe('a***@x.co');
    expect(maskPhone('0317 2060161')).toBe('+92 3** ***0161');
    expect(maskPhone('+923172060161')).toBe('+92 3** ***0161');
    expect(maskPhone('')).toBe('');
  });

  it('customers list, detail and followers contain no full e-mail or phone', async () => {
    const { svc } = make({ follows: [BUYER] });
    const list: any = await svc.getCustomers('seller1', STORE, {});
    const detail: any = await svc.getCustomerDetail('seller1', STORE, BUYER);
    const fol: any = await svc.getFollowers('seller1', STORE, {});
    const all = JSON.stringify([list, detail, fol]);
    expect(all).not.toContain('sara.khan5@gmail.com');
    expect(all).not.toContain('ali@x.co');
    expect(all).not.toContain('2060161');
    expect(all).not.toContain('03001234567');
    expect(all).toContain('s***5@gmail.com');
  });
});

describe('customers list', () => {
  it('excludes the store owner\'s own buyer account', async () => {
    const { svc, repos } = make();
    const list: any = await svc.getCustomers('seller1', STORE, {});
    expect(list.data.customers.map((c: any) => c._id)).not.toContain(OWNER_BUYER);
    const ids = repos.orderModel.aggregate.mock.calls[0][0][0].$match.userId.$in;
    expect(ids).not.toContain(OWNER_BUYER);
  });

  it('sorts by orders asc/desc before paging and KPIs follow the search', async () => {
    const { svc } = make();
    const desc: any = await svc.getCustomers('seller1', STORE, { sort: 'orderCount', order: 'desc' });
    const asc: any = await svc.getCustomers('seller1', STORE, { sort: 'orderCount', order: 'asc' });
    expect(desc.data.customers[0].orderCount).toBeGreaterThan(asc.data.customers[0].orderCount);
    const one: any = await svc.getCustomers('seller1', STORE, { q: 'sara' });
    expect(one.data.pagination.total).toBe(1);
    expect(one.data.summary.totalOrders).toBe(3);
  });

  it('phone search finds the same customer under 0317, 317, +92317, 92317', async () => {
    const { svc } = make();
    for (const q of ['0317', '317', '+92317', '92317', '0317 2060161', '+92 317 2060161']) {
      const r: any = await svc.getCustomers('seller1', STORE, { q });
      expect(r.data.customers.map((c: any) => c._id)).toEqual([BUYER]);
    }
  });

  it('another seller is refused', async () => {
    const { svc } = make();
    await expect(svc.getCustomers('seller2', STORE, {})).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.getCustomerDetail('seller2', STORE, BUYER)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('phone + sort helpers', () => {
  it('phoneMatches ignores formatting', () => {
    const q = parsePhoneQuery('0317')!;
    expect(phoneMatches('+92 317 2060161', q)).toBe(true);
    expect(phoneMatches('03172060161', q)).toBe(true);
    expect(phoneMatches('03001234567', q)).toBe(false);
    expect(parsePhoneQuery('ab12')).toBeNull();
    expect(parsePhoneQuery('12')).toBeNull();
  });

  it('sort is stable with an _id tiebreak and puts missing dates last', () => {
    const rows = [{ _id: 'b', v: 1 }, { _id: 'a', v: 1 }, { _id: 'c', v: null as number | null }];
    const out = sortCustomerRows(rows, 'orderCount', 1, (r) => r.v);
    expect(out.map((r) => r._id)).toEqual(['a', 'b', 'c']);
  });
});

describe('detail panel', () => {
  it('returns figures, latest orders (Free badge data), the existing thread id and the note', async () => {
    const { svc } = make();
    const d: any = (await svc.getCustomerDetail('seller1', STORE, BUYER)).data;
    expect(d.isRepeat).toBe(true);
    expect(d.conversationId).toBe('conv1');
    expect(d.recentOrders[0]).toMatchObject({ orderNumber: 'ORD-1', itemCount: 2, amount: 0, isFree: true });
  });

  it('a non-customer or the owner account is 404', async () => {
    const { svc } = make({ ordered: [] });
    await expect(svc.getCustomerDetail('seller1', STORE, BUYER2)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getCustomerDetail('seller1', STORE, OWNER_BUYER)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('private notes', () => {
  it('persist and come back with the detail; tags trimmed, de-duplicated, max 5', async () => {
    const { svc } = make();
    const saved: any = await svc.saveNote('seller1', STORE, BUYER, { note: '  Prefers class 5  ', tags: [' VIP ', 'vip', 'Teacher'] });
    expect(saved.data).toEqual({ note: 'Prefers class 5', tags: ['VIP', 'Teacher'] });
    const d: any = (await svc.getCustomerDetail('seller1', STORE, BUYER)).data;
    expect(d.note).toEqual({ note: 'Prefers class 5', tags: ['VIP', 'Teacher'] });
  });

  it('limits are enforced', () => {
    expect('error' in cleanNoteInput('x'.repeat(501), [])).toBe(true);
    expect('error' in cleanNoteInput('', ['a', 'b', 'c', 'd', 'e', 'f'])).toBe(true);
    expect('error' in cleanNoteInput('', ['x'.repeat(21)])).toBe(true);
  });

  it('another store\'s seller cannot read or write; a stranger buyer is 404; bad input 400', async () => {
    const { svc, noteModel } = make({ ordered: [] });
    await expect(svc.saveNote('seller2', STORE, BUYER, { note: 'x' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.saveNote('seller1', STORE, BUYER, { note: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    expect(noteModel.findOneAndUpdate).not.toHaveBeenCalled();
    const ok = make({ follows: [BUYER], ordered: [] }); // a follower may get a note
    await expect(ok.svc.saveNote('seller1', STORE, BUYER, { note: 'x'.repeat(501) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(ok.svc.saveNote('seller1', STORE, BUYER, { note: 'fine' })).resolves.toBeTruthy();
  });

  it('empty note + no tags removes the record', async () => {
    const { svc, notes } = make();
    await svc.saveNote('seller1', STORE, BUYER, { note: 'a' });
    expect(notes.size).toBe(1);
    await svc.saveNote('seller1', STORE, BUYER, { note: '', tags: [] });
    expect(notes.size).toBe(0);
  });
});
