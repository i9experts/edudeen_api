/* eslint-disable prettier/prettier */
import { StoreCustomersService } from './store-customers.service';

describe('Customers CSV export', () => {
  const make = (customers: any[]) => {
    const svc: any = new StoreCustomersService({} as any, {} as any);
    const spy = jest.spyOn(svc, 'getCustomers').mockResolvedValue({ success: true, data: { customers } });
    return { svc, spy };
  };

  it('asks for the whole list (all = true), keeps the masked contacts and writes one row each', async () => {
    const { svc, spy } = make([
      { name: 'Ayesha Khan', email: 'a***@mail.com', phone: '+92 3** *** *67', orderCount: 3, totalSpent: 4500, freeOrderCount: 1, lastOrderAt: '2026-11-02T10:00:00Z', createdAt: '2026-01-05T10:00:00Z' },
    ]);
    const csv: string = await svc.exportCustomersCsv('seller1', 'store1', { q: 'ay' });
    expect(spy).toHaveBeenCalledWith('seller1', 'store1', { q: 'ay' }, true);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Email (masked)');
    expect(lines[1]).toContain('a***@mail.com');
    expect(lines[1]).toContain('2026-11-02');
  });

  it('neutralises spreadsheet formulas in a customer name', async () => {
    const { svc } = make([{ name: '=HYPERLINK("http://x")', email: '', phone: '', orderCount: 0, totalSpent: 0, freeOrderCount: 0 }]);
    const csv: string = await svc.exportCustomersCsv('s', 't', {});
    expect(csv.split(/\r?\n/)[1].startsWith('"=')).toBe(false);
  });

  it('an empty list is just the header row', async () => {
    const { svc } = make([]);
    expect((await svc.exportCustomersCsv('s', 't', {})).trim().split(/\r?\n/)).toHaveLength(1);
  });
});
