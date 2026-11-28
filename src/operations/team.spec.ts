/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await -- mock-heavy */
import { ForbiddenException } from '@nestjs/common';
import {
  actionKind,
  describeStoreWrite,
  inWindow,
  median,
  pairFirstReplies,
  parsePeriod,
  pct,
  shippedOnTime,
  teamBreaches,
  windowStart,
} from './team.util';
import { OperationsController } from './operations.controller';
import { TeamService } from './team.service';

const NOW = new Date('2026-11-28T12:00:00Z');
const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const A = 'a'.repeat(24);
const B = 'b'.repeat(24);

describe('team KPI rules', () => {
  it('pairs only the first store reply after a waiting buyer, measured from the earliest waiting message', () => {
    const replies = pairFirstReplies([
      { conversationId: 'c1', senderRole: 'user', createdAt: at(10) },
      { conversationId: 'c1', senderRole: 'user', createdAt: at(9) }, // same wait
      {
        conversationId: 'c1',
        senderRole: 'seller',
        actingStaffId: A,
        createdAt: at(8),
      }, // 120 min
      {
        conversationId: 'c1',
        senderRole: 'seller',
        actingStaffId: A,
        createdAt: at(7),
      }, // follow-up, not a reply
      { conversationId: 'c1', senderRole: 'user', createdAt: at(6) },
      {
        conversationId: 'c1',
        senderRole: 'seller',
        actingStaffId: null,
        createdAt: at(5),
      }, // seller answered themselves
      { conversationId: 'c1', senderRole: 'user', createdAt: at(4) },
      {
        conversationId: 'c1',
        senderRole: 'seller',
        actingStaffId: B,
        createdAt: at(3.5),
      }, // 30 min, B
    ]);
    expect(replies.map((r) => [r.staffId, r.minutes])).toEqual([
      [A, 120],
      [B, 30],
    ]);
  });

  it('sorts messages per conversation before pairing', () => {
    const replies = pairFirstReplies([
      {
        conversationId: 'c2',
        senderRole: 'seller',
        actingStaffId: A,
        createdAt: at(1),
      },
      { conversationId: 'c2', senderRole: 'user', createdAt: at(2) },
    ]);
    expect(replies).toEqual([
      expect.objectContaining({
        staffId: A,
        minutes: 60,
        conversationId: 'c2',
      }),
    ]);
  });

  it('on-time shipping uses the dispatch deadline (legacy 48 h without a snapshot)', () => {
    const paid = new Date('2026-11-23T10:00:00Z'); // Monday
    expect(shippedOnTime(paid, 2, new Date('2026-11-25T09:00:00Z'))).toBe(true);
    expect(shippedOnTime(paid, 2, new Date('2026-11-25T11:00:00Z'))).toBe(
      false,
    );
    expect(shippedOnTime(paid, null, new Date('2026-11-25T09:59:00Z'))).toBe(
      true,
    );
    expect(shippedOnTime(paid, 2, null)).toBeNull();
  });

  it('windows, periods, medians and percentages', () => {
    const since = windowStart(7, NOW);
    expect(inWindow(at(24), since, NOW)).toBe(true);
    expect(inWindow(at(24 * 8), since, NOW)).toBe(false);
    expect(inWindow(new Date(NOW.getTime() + 1000), since, NOW)).toBe(false);
    expect(inWindow(null, since, NOW)).toBe(false);
    expect(parsePeriod('90')).toBe(90);
    expect(parsePeriod('45')).toBe(30);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBeNull();
    expect(pct(9, 10)).toBe(90);
    expect(pct(0, 0)).toBeNull();
  });

  it('classifies package steps and flags breaches', () => {
    expect(actionKind('status:processing')).toBe('confirmed');
    expect(actionKind('status:shipped')).toBe('shipped');
    expect(actionKind('courier_booked')).toBe('courier_booked');
    expect(actionKind('cancelled')).toBe('cancelled');
    expect(actionKind('status:on_hold')).toBe('other');
    expect(
      teamBreaches({
        medianReplyMinutes: 30,
        onTimeDispatchPct: 95,
        openOverdue: 0,
        openWaitingOver24h: 0,
        openStuck: 0,
      }),
    ).toEqual([]);
    expect(
      teamBreaches({
        medianReplyMinutes: 25 * 60,
        onTimeDispatchPct: 80,
        openOverdue: 2,
        openWaitingOver24h: 1,
        openStuck: 0,
      }),
    ).toHaveLength(4);
    expect(
      describeStoreWrite('POST', '/api/messaging/conversations/x/messages'),
    ).toMatch(/buyer chat/);
    expect(describeStoreWrite('PATCH', '/api/products/123')).toBe(
      'Edited a product',
    );
  });
});

describe('team access control', () => {
  const owner = { user: { userId: A } }; // no staff rights attached = owner
  const viewer = {
    user: { userId: B },
    staffPermissions: new Set(['operations.view']),
  };
  const operator = {
    user: { userId: B },
    staffPermissions: new Set(['stores.operate']),
  };
  const other = {
    user: { userId: B },
    staffPermissions: new Set(['orders.view']),
  };
  const make = () => {
    const ops = { myQueue: jest.fn(async (id: string) => ({ for: id })) };
    const team = {
      team: jest.fn(async () => ({ items: [] })),
      member: jest.fn(async (id: string) => ({ id })),
      ownKpis: jest.fn(async () => ({})),
    };
    return {
      ctrl: new OperationsController(ops as any, team as any),
      ops,
      team,
    };
  };

  it('team list needs every-store access', async () => {
    const { ctrl } = make();
    await expect(ctrl.teamList(owner, {})).resolves.toEqual({
      success: true,
      data: { items: [] },
    });
    await expect(ctrl.teamList(viewer, {})).resolves.toBeTruthy();
    await expect(ctrl.teamList(operator, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(ctrl.teamList(other, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a team member sees only their own detail', async () => {
    const { ctrl } = make();
    await expect(ctrl.teamMember(operator, B, {})).resolves.toEqual({
      success: true,
      data: { id: B },
    });
    await expect(ctrl.teamMember(operator, A, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(ctrl.teamMember(viewer, A, {})).resolves.toBeTruthy();
  });

  it('the work queue is always the caller’s own', async () => {
    const { ctrl, ops } = make();
    await ctrl.myQueue(operator);
    expect(ops.myQueue).toHaveBeenCalledWith(B);
    await expect(ctrl.myQueue(other)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('TeamService.compute', () => {
  it('builds per-member KPIs from products, replies, package steps and assigned-store workload', async () => {
    const S1 = '1'.repeat(24);
    const conv = 'c'.repeat(24);
    const paid = new Date(NOW.getTime() - 3 * 86_400_000);
    const repos: any = {
      productModel: {
        aggregate: jest.fn(async (pipe: any[]) =>
          pipe[0].$match.createdByStaffId
            ? [{ _id: { a: A, s: S1 }, n: 3 }]
            : [{ _id: { a: A, s: S1 }, n: 2 }],
        ),
      },
      messageModel: {
        aggregate: jest.fn(async (pipe: any[]) =>
          pipe[0].$match.actingStaffId
            ? [{ _id: { a: A, c: conv }, n: 2 }]
            : [
                { conversationId: conv, senderRole: 'user', createdAt: at(5) },
                {
                  conversationId: conv,
                  senderRole: 'seller',
                  actingStaffId: A,
                  createdAt: at(4),
                },
                {
                  conversationId: conv,
                  senderRole: 'seller',
                  actingStaffId: A,
                  createdAt: at(3),
                },
              ],
        ),
      },
      conversationModel: {
        find: () => ({
          select: () => ({ lean: async () => [{ _id: conv, storeId: S1 }] }),
        }),
      },
      orderModel: {
        aggregate: () => ({
          allowDiskUse: async () => [
            {
              orderId: 'o1',
              storeId: S1,
              staffId: A,
              action: 'status:processing',
              at: at(30),
              baseAt: paid,
            },
            {
              orderId: 'o1',
              storeId: S1,
              staffId: A,
              action: 'status:shipped',
              at: at(20),
              shippedAt: at(20),
              dispatchDays: 2,
              baseAt: paid,
            },
            {
              orderId: 'o2',
              storeId: S1,
              staffId: A,
              action: 'status:shipped',
              at: at(2),
              shippedAt: at(2),
              dispatchDays: 7,
              baseAt: paid,
            },
          ],
        }),
      },
      adminModel: {
        find: () => ({
          select: () => ({
            lean: async () => [{ _id: A, name: 'Ayesha', email: 'a@x.com' }],
          }),
        }),
      },
      activityLogModel: {
        aggregate: jest.fn(async () => [{ _id: A, at: at(1) }]),
      },
    };
    const assignmentModel: any = {
      find: () => ({
        select: () => ({
          lean: async () => [
            { storeId: S1, adminId: A, role: 'account_manager' },
          ],
        }),
      }),
    };
    const auditModel: any = { aggregate: jest.fn(async () => []) };
    const ops: any = {
      cachedRows: jest.fn(async () => [
        {
          id: S1,
          name: 'Darul',
          managementType: 'managed',
          health: { level: 'action', reasons: [] },
          orders: { toShip: 4, overdue: 1 },
          response: { unanswered: 2, unansweredOver24h: 1 },
          shipments: { stuck: 0 },
          listings: { issues: 3 },
        },
      ]),
    };
    const svc = new TeamService(
      { repositories: repos } as any,
      {} as any,
      ops,
      assignmentModel,
      auditModel,
    );

    const { rows } = await svc.compute(30, NOW);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.name).toBe('Ayesha');
    expect(r.stores).toEqual({ assigned: 1, managed: 1 });
    expect(r.products).toEqual({ created: 3, edited: 2 });
    expect(r.replies).toEqual({
      sent: 2,
      answered: 1,
      medianMinutes: 60,
      within24hPct: 100,
    });
    expect(r.orders).toMatchObject({
      actioned: 2,
      confirmed: 1,
      shipped: 2,
      onTimeSample: 2,
      onTimePct: 50,
    });
    expect(r.workload).toEqual({
      toShip: 4,
      overdue: 1,
      waiting: 2,
      waitingOver24h: 1,
      stuck: 0,
      listingIssues: 3,
    });
    expect(r.lastActiveAt).toBe(at(1).toISOString());
    expect(r.breaches.length).toBeGreaterThan(0);
  });
});
