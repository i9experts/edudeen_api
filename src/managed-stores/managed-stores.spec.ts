/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- mock-heavy */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import mongoose from 'mongoose';
import {
  cleanManagedInput,
  managedCommissionRate,
  mouStatus,
} from './managed-stores.util';
import { ManagedStoresService } from './managed-stores.service';
import {
  actingStaffId,
  actingStaffPlugin,
  runAsActingStaff,
} from '../common/acting-staff.context';
import { createActAsMiddleware } from '../admin-stores/act-as.util';
import { MessageSchema } from '../messaging/schemas/message.schema';

const NOW = new Date('2026-11-28T00:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('mouStatus', () => {
  it('none / not_started / active / expiring_soon / expired; open-ended never expires', () => {
    expect(mouStatus(null, NOW)).toBe('none');
    expect(mouStatus({ commissionRate: 0.3, startDate: day(5) }, NOW)).toBe(
      'not_started',
    );
    expect(
      mouStatus(
        { commissionRate: 0.3, startDate: day(-5), endDate: day(90) },
        NOW,
      ),
    ).toBe('active');
    expect(
      mouStatus(
        { commissionRate: 0.3, startDate: day(-5), endDate: day(30) },
        NOW,
      ),
    ).toBe('expiring_soon');
    expect(
      mouStatus(
        { commissionRate: 0.3, startDate: day(-50), endDate: day(-1) },
        NOW,
      ),
    ).toBe('expired');
    expect(
      mouStatus(
        { commissionRate: 0.3, startDate: day(-500), endDate: null },
        NOW,
      ),
    ).toBe('active');
  });
});

describe('cleanManagedInput', () => {
  const self = { managementType: 'self', mou: null };
  it('switching to managed needs a full MOU: commission 20–65%, a start date, end after start', () => {
    expect(() =>
      cleanManagedInput({ managementType: 'managed' }, self),
    ).toThrow('Enter the MOU commission');
    expect(() =>
      cleanManagedInput(
        {
          managementType: 'managed',
          commissionRate: 0.19,
          startDate: '2026-12-01',
        },
        self,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      cleanManagedInput(
        {
          managementType: 'managed',
          commissionRate: 0.66,
          startDate: '2026-12-01',
        },
        self,
      ),
    ).toThrow('between 20% and 65%');
    expect(() =>
      cleanManagedInput(
        { managementType: 'managed', commissionRate: 0.3 },
        self,
      ),
    ).toThrow('start date');
    expect(() =>
      cleanManagedInput(
        {
          managementType: 'managed',
          commissionRate: 0.3,
          startDate: '2026-12-01',
          endDate: '2026-11-01',
        },
        self,
      ),
    ).toThrow('after its start');
    const ok = cleanManagedInput(
      {
        managementType: 'managed',
        commissionRate: 0.65,
        startDate: '2026-12-01',
        endDate: null,
        notes: '  signed in Karachi ',
      },
      self,
    );
    expect(ok.managementType).toBe('managed');
    expect(ok.mou).toEqual({
      commissionRate: 0.65,
      startDate: new Date('2026-12-01'),
      endDate: null,
      notes: 'signed in Karachi',
    });
  });
  it('an edit on a managed store keeps the stored fields it does not send', () => {
    const cur = {
      managementType: 'managed',
      mou: {
        commissionRate: 0.3,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2027-01-01'),
        notes: 'x',
      },
    };
    expect(cleanManagedInput({ commissionRate: 0.4 }, cur).mou).toEqual({
      commissionRate: 0.4,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2027-01-01'),
      notes: 'x',
    });
    expect(cleanManagedInput({ fulfillmentMode: 'platform' }, cur)).toEqual({
      fulfillmentMode: 'platform',
    });
  });
  it('MOU fields on a self-managed store are refused; bad enums are refused', () => {
    expect(() => cleanManagedInput({ commissionRate: 0.3 }, self)).toThrow(
      'only apply to managed',
    );
    expect(() =>
      cleanManagedInput({ managementType: 'partner' }, self),
    ).toThrow(BadRequestException);
    expect(() => cleanManagedInput({ fulfillmentMode: 'drone' }, self)).toThrow(
      BadRequestException,
    );
  });
});

describe('managedCommissionRate', () => {
  it('only a managed store with a rate has one (kept after the MOU end date)', () => {
    expect(
      managedCommissionRate({
        managementType: 'managed',
        mou: { commissionRate: 0.25 },
      }),
    ).toBe(0.25);
    expect(
      managedCommissionRate({
        managementType: 'self',
        mou: { commissionRate: 0.25 },
      }),
    ).toBeNull();
    expect(
      managedCommissionRate({ managementType: 'managed', mou: null }),
    ).toBeNull();
    expect(managedCommissionRate(null)).toBeNull();
  });
});

describe('ManagedStoresService.assertMayOperate', () => {
  const mk = (admin: any, assigned: boolean) => {
    const chain = (v: any) => ({ select: () => ({ lean: async () => v }) });
    const db: any = {
      repositories: { adminModel: { findById: () => chain(admin) } },
    };
    const assignmentModel: any = {
      exists: jest.fn().mockResolvedValue(assigned ? { _id: 'x' } : null),
    };
    return {
      svc: new ManagedStoresService(
        db,
        assignmentModel,
        {} as any,
        {} as any,
        {} as any,
      ),
      assignmentModel,
    };
  };
  it('the owner may operate any store without an assignment', async () => {
    const t = mk({ isStaff: false }, false);
    await expect(
      t.svc.assertMayOperate('owner', 'st1'),
    ).resolves.toBeUndefined();
    expect(t.assignmentModel.exists).not.toHaveBeenCalled();
  });
  it('a team member only their assigned stores', async () => {
    await expect(
      mk({ isStaff: true }, true).svc.assertMayOperate('a1', 'st1'),
    ).resolves.toBeUndefined();
    await expect(
      mk({ isStaff: true }, false).svc.assertMayOperate('a1', 'st1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      mk(null, true).svc.assertMayOperate('ghost', 'st1'),
    ).resolves.toBeUndefined(); // exists() still decides
  });
});

describe('attribution of manage-as-seller writes', () => {
  it('the act-as middleware runs an audited write with the team member in context (and reads without)', async () => {
    const mw = createActAsMiddleware({
      verify: () => ({
        sub: 'seller1',
        actAs: 'admin',
        actAsAdminId: 'staff7',
        storeId: 'st1',
        typ: 'access',
      }),
      log: async () => true,
    });
    const seen: (string | null)[] = [];
    const run = (method: string) =>
      new Promise<void>((resolve) => {
        void mw(
          {
            headers: { authorization: 'Bearer t' },
            path: '/api/messaging/conversations/c1/messages',
            method,
            query: {},
            body: {},
          },
          {},
          () => {
            seen.push(actingStaffId());
            resolve();
          },
        );
      });
    await run('POST');
    await run('GET');
    expect(seen).toEqual(['staff7', null]);
  });

  it('a message sent in that context records actingStaffId; outside it nothing is stamped', async () => {
    const m = new mongoose.Mongoose();
    const Message = m.model('MessageAttributionTest', MessageSchema);
    const hooks = (MessageSchema as any).s.hooks;
    const inSession = new Message({
      conversationId: 'c1',
      senderId: 'seller1',
      senderRole: 'seller',
      type: 'text',
      text: 'hi',
    });
    await runAsActingStaff({ staffId: 'staff7', storeId: 'st1' }, () =>
      hooks.execPre('save', inSession, [{}]),
    );
    expect(inSession.get('actingStaffId')).toBe('staff7');
    const normal = new Message({
      conversationId: 'c1',
      senderId: 'seller1',
      senderRole: 'seller',
      type: 'text',
      text: 'hi',
    });
    await hooks.execPre('save', normal, [{}]);
    expect(normal.get('actingStaffId')).toBeNull();
  });

  it('product-style updates get lastEditedBy stamped in context', async () => {
    const schema = new mongoose.Schema({
      name: String,
      lastEditedByStaffId: String,
      lastEditedByStaffAt: Date,
    });
    actingStaffPlugin(schema, {
      editedField: 'lastEditedByStaffId',
      editedAtField: 'lastEditedByStaffAt',
    });
    // Hooks run on a bare query (no model compiled, so only this plugin's hook is registered).
    const q: any = new mongoose.Query();
    q.setUpdate({ $set: { name: 'x' } });
    await runAsActingStaff({ staffId: 'staff9', storeId: 'st1' }, () =>
      (schema as any).s.hooks.execPre('updateOne', q, []),
    );
    expect(q.getUpdate().$set).toEqual(
      expect.objectContaining({
        name: 'x',
        lastEditedByStaffId: 'staff9',
        lastEditedByStaffAt: expect.any(Date),
      }),
    );
  });
});
