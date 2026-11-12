import { BadRequestException } from '@nestjs/common';
import { cleanHolidayInput, holidayActive, holidayBlocks, holidayText, parsePktDay, publicHoliday } from './store-holiday.util';
import { endExpiredHolidays } from './store-holiday.job';
import { StoreService } from './store.service';
import { CartService } from '../cart/cart.service';

describe('store holiday - validation and gate rule', () => {
  const now = new Date('2026-11-12T07:00:00Z'); // 12:00 PKT, 12 Nov

  it('parses a Pakistan day to 00:00 PKT and rejects fake dates', () => {
    expect(parsePktDay('2026-11-20')!.toISOString()).toBe('2026-11-19T19:00:00.000Z');
    expect(parsePktDay('2026-02-30')).toBeNull();
    expect(parsePktDay('20-11-2026')).toBeNull();
  });

  it('requires a future return day, a boolean and a short message', () => {
    expect(() => cleanHolidayInput({ enabled: true, returnDate: '2026-11-12' }, now)).toThrow(BadRequestException); // today started already
    expect(() => cleanHolidayInput({ enabled: true, returnDate: 'soon' }, now)).toThrow(BadRequestException);
    expect(() => cleanHolidayInput({ enabled: 'yes' }, now)).toThrow(BadRequestException);
    expect(() => cleanHolidayInput({ enabled: true, message: 'x'.repeat(201) }, now)).toThrow(BadRequestException);
    expect(() => cleanHolidayInput(null, now)).toThrow(BadRequestException);
    const ok = cleanHolidayInput({ enabled: true, returnDate: '2026-11-13', message: '  Back   soon ' }, now);
    expect(ok).toMatchObject({ enabled: true, message: 'Back soon', digitalStillSells: true });
    expect(ok.returnDate!.toISOString()).toBe('2026-11-12T19:00:00.000Z');
  });

  it('switching off drops the return day but keeps the choices', () => {
    const off = cleanHolidayInput({ enabled: false, returnDate: '2026-11-20', digitalStillSells: false, message: 'Eid' }, now);
    expect(off).toMatchObject({ enabled: false, returnDate: null, message: 'Eid', digitalStillSells: false });
  });

  it('physical is always blocked; digital follows the toggle; an expired holiday blocks nothing', () => {
    const h = { enabled: true, returnDate: new Date('2026-11-20T00:00:00Z'), message: null, digitalStillSells: true };
    expect(holidayBlocks(h, 'physical', now)).toBe(true);
    expect(holidayBlocks(h, 'digital', now)).toBe(false);
    expect(holidayBlocks({ ...h, digitalStillSells: false }, 'digital', now)).toBe(true);
    expect(holidayBlocks(h, 'physical', new Date('2026-11-21T00:00:00Z'))).toBe(false);
    expect(holidayBlocks(null, 'physical', now)).toBe(false);
    expect(holidayActive({ enabled: true, returnDate: null }, now)).toBe(true);
  });

  it('public view has only the 4 fields and is null when not in force', () => {
    const store = { holiday: { enabled: true, returnDate: new Date('2026-11-19T19:00:00Z'), message: 'Eid', digitalStillSells: true, secret: 'x' }, sellerId: 's' };
    expect(Object.keys(publicHoliday(store, now)!).sort()).toEqual(['digitalStillSells', 'enabled', 'message', 'returnDate']);
    expect(publicHoliday({ holiday: { enabled: false } }, now)).toBeNull();
    expect(publicHoliday({}, now)).toBeNull();
    expect(holidayText(store.holiday)).toBe('Store away until 20 Nov 2026');
  });
});

describe('store holiday - cart gate', () => {
  const build = (holiday: any, type: string) => {
    const repos: any = {
      productModel: { findById: () => ({ lean: async () => ({ _id: 'p1', name: 'Atlas', storeId: 's1', status: 'active', isDelete: false, type }) }) },
      storeModel: { findOne: () => ({ select: () => ({ lean: async () => ({ _id: 's1', holiday }) }) }) },
      productVariantModel: { findById: () => ({ lean: async () => ({ _id: 'v1', productId: 'p1', status: 'active', isDelete: false, price: 100 }) }) },
      cartModel: { findOne: async () => null, create: async (d: any) => d },
    };
    return new CartService({ repositories: repos } as any);
  };
  const on = { enabled: true, returnDate: new Date(Date.now() + 86_400_000), message: null, digitalStillSells: true };

  it('refuses a physical line with a clear message', async () => {
    await expect(build(on, 'physical').addToCart('u1', undefined, { productId: 'p1', productVariantId: 'v1', quantity: 1 } as any))
      .rejects.toThrow(/Store away until/);
  });
  it('lets digital through while digitalStillSells, refuses it when paused', async () => {
    await expect(build(on, 'digital').addToCart('u1', undefined, { productId: 'p1', productVariantId: 'v1', quantity: 1 } as any)).resolves.toBeDefined();
    await expect(build({ ...on, digitalStillSells: false }, 'digital').addToCart('u1', undefined, { productId: 'p1', productVariantId: 'v1', quantity: 1 } as any))
      .rejects.toThrow(/cannot be ordered/);
  });
});

describe('store holiday - auto off job (fake timers)', () => {
  afterEach(() => jest.useRealTimers());

  it('switches off only after the return day starts, audits, notifies and refreshes pages', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-19T18:59:00Z')); // 23:59 PKT on 19 Nov
    const returnDate = new Date('2026-11-19T19:00:00Z'); // 20 Nov 00:00 PKT
    const state = { _id: 's1', sellerId: 'sel1', name: 'Noor', holiday: { enabled: true, returnDate } as any };
    const storeModel: any = {
      find: (filter: any) => ({
        select: () => ({ limit: () => ({ lean: async () => (state.holiday.enabled && state.holiday.returnDate && state.holiday.returnDate <= filter['holiday.returnDate'].$lte ? [state] : []) }) }),
      }),
      updateOne: async (_f: any, upd: any) => { state.holiday = { ...state.holiday, ...{ enabled: upd.$set['holiday.enabled'], returnDate: upd.$set['holiday.returnDate'] } }; return { modifiedCount: 1 }; },
    };
    const log = jest.fn().mockResolvedValue(true);
    const notify = jest.fn().mockResolvedValue(undefined);
    const emit = jest.fn();
    const deps = { storeModel, activityLog: { log }, notifier: { notify }, realtime: { emit } };

    expect(await endExpiredHolidays(deps, new Date())).toBe(0); // one minute early
    expect(state.holiday.enabled).toBe(true);

    jest.advanceTimersByTime(60_000); // 00:00 PKT
    expect(await endExpiredHolidays(deps, new Date())).toBe(1);
    expect(state.holiday).toMatchObject({ enabled: false, returnDate: null });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'holiday_disabled', storeId: 's1' }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'sel1', type: 'store_holiday_ended' }));
    expect(emit).toHaveBeenCalledWith('store', 'storefront');

    expect(await endExpiredHolidays(deps, new Date())).toBe(0); // idempotent
  });
});

describe('store holiday - seller route (setHoliday)', () => {
  const make = (store: any) => {
    const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const log = jest.fn().mockResolvedValue(true);
    const emit = jest.fn();
    const storeModel: any = { findOne: () => ({ select: () => ({ lean: async () => store }) }), updateOne };
    const svc = new (StoreService as any)(
      { repositories: { storeModel } }, { log }, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, { emit },
    ) as StoreService;
    return { svc, updateOne, log, emit };
  };
  const tomorrow = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

  it('owner only; logs on and off', async () => {
    const t = make({ _id: 's1', sellerId: 'sel1', status: 'active', holiday: null });
    await expect(t.svc.setHoliday('other', 's1', { enabled: true })).rejects.toThrow();
    await t.svc.setHoliday('sel1', 's1', { enabled: true, returnDate: tomorrow(), message: 'Eid' });
    expect(t.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'holiday_enabled', actorId: 'sel1' }));
    expect(t.emit).toHaveBeenCalledWith('store', 'storefront');

    const off = make({ _id: 's1', sellerId: 'sel1', status: 'active', holiday: { enabled: true, returnDate: new Date(Date.now() + 86_400_000), message: null, digitalStillSells: true } });
    await off.svc.setHoliday('sel1', 's1', { enabled: false });
    expect(off.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'holiday_disabled' }));
  });
});
