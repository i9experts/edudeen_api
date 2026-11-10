import {
  buildReturnRate, buildReturnsStats, filterRows, isOverdue, normalizeStatus, respondBy, sortReturnsRows,
  type ReturnsListRow,
} from './seller-returns-all.util';

const NOW = new Date('2026-11-10T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function row(p: Partial<ReturnsListRow> & { ageH: number }): ReturnsListRow {
  const status = p.status ?? 'open';
  const requestedAt = hoursAgo(p.ageH);
  const deadline = respondBy(requestedAt, status);
  return {
    source: 'return', requestId: p.requestId ?? 'x', itemIds: [], orderId: 'o', orderNumber: p.orderNumber ?? 'ORD-1', storeId: 's',
    item: p.item ?? 'Book', buyer: p.buyer ?? 'Ali', type: 'Return', reason: 'r', status, requestedAt,
    respondBy: deadline, isOverdue: isOverdue(deadline, NOW), amount: 10, ...p,
  } as ReturnsListRow;
}

describe('seller returns list helpers', () => {
  it('maps pending/requested to open', () => {
    expect(normalizeStatus('requested')).toBe('open');
    expect(normalizeStatus('partial_requested')).toBe('open');
    expect(normalizeStatus('approved')).toBe('approved');
  });

  it('respond-by = requested + 48h only while open; overdue after it', () => {
    expect(respondBy(hoursAgo(10), 'open')!.getTime()).toBe(hoursAgo(10).getTime() + 48 * 3_600_000);
    expect(respondBy(hoursAgo(10), 'approved')).toBeNull();
    expect(row({ ageH: 47 }).isOverdue).toBe(false);
    expect(row({ ageH: 51 }).isOverdue).toBe(true);
  });

  it('sorts open first by soonest deadline, then closed newest first', () => {
    const rows = [
      row({ requestId: 'closed-new', ageH: 1, status: 'approved' }),
      row({ requestId: 'open-fresh', ageH: 2 }),
      row({ requestId: 'open-overdue', ageH: 60 }),
      row({ requestId: 'closed-old', ageH: 100, status: 'rejected' }),
    ];
    expect(sortReturnsRows(rows).map((r) => r.requestId)).toEqual(['open-overdue', 'open-fresh', 'closed-new', 'closed-old']);
  });

  it('merges return + refund rows in one order', () => {
    const merged = sortReturnsRows([
      row({ requestId: 'ref', source: 'refund', type: 'Refund only', ageH: 30 }),
      row({ requestId: 'ret', ageH: 40 }),
    ]);
    expect(merged.map((r) => r.requestId)).toEqual(['ret', 'ref']);
  });

  it('return rate needs 10 orders', () => {
    expect(buildReturnRate(2, 9)).toEqual({ pct: null, returns: 2, orders: 9 });
    expect(buildReturnRate(2, 10).pct).toBe(20);
    expect(buildReturnRate(1, 30).pct).toBe(3.3);
  });

  it('stats count open and overdue', () => {
    const rows = [row({ ageH: 60 }), row({ ageH: 5 }), row({ ageH: 5, status: 'approved' })];
    const s = buildReturnsStats(rows, { returns: 1, orders: 20 }, 99);
    expect(s).toMatchObject({ open: 2, overdue: 1, refunded30d: 99 });
    expect(s.returnRate30d.pct).toBe(5);
  });

  it('filters by status and search', () => {
    const rows = [row({ ageH: 1, orderNumber: 'ORD-7', buyer: 'Sana' }), row({ ageH: 1, status: 'approved', item: 'Quran' })];
    expect(filterRows(rows, 'open', '')).toHaveLength(1);
    expect(filterRows(rows, undefined, 'quran')).toHaveLength(1);
    expect(filterRows(rows, undefined, 'sana')).toHaveLength(1);
  });
});
