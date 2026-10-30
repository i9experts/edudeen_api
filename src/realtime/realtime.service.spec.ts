import { RealtimeService } from './realtime.service';

const OID = 'a'.repeat(24);
const OID2 = 'b'.repeat(24);

function make() {
  const sent: Array<{ room: string; topics: string[] }> = [];
  const svc = new RealtimeService();
  (svc as any).server = {
    emit: (_e: string, p: any) => sent.push({ room: '*', topics: p.topics }),
    to: (room: string) => ({ emit: (_e: string, p: any) => sent.push({ room, topics: p.topics }) }),
  };
  return { svc, sent, flush: () => (svc as any).flush() };
}

describe('RealtimeService', () => {
  it('derives topics from the path (incl. admin/seller prefixes and aliases)', () => {
    const { svc } = make();
    expect(svc.topicsForPath('/api/payment/checkout')).toEqual(expect.arrayContaining(['payment', 'orders', 'finance']));
    expect(svc.topicsForPath(`/api/admin/banners/${OID}`)).toEqual(expect.arrayContaining(['banners', 'config']));
    expect(svc.topicsForPath('/API/Admin//Marketplace/')).toEqual(expect.arrayContaining(['marketplace', 'catalog']));
    expect(svc.topicsForPath('/api/auth/login')).toEqual([]);
    expect(svc.topicsForPath('/health')).toEqual([]);
  });

  it('sends public topics to everyone and private topics only to the involved rooms', () => {
    const { svc, sent, flush } = make();
    svc.publishFromRequest({ originalUrl: `/api/orders/${OID}/ship?storeId=${OID2}`, query: { storeId: OID2 }, body: {}, user: { userId: 'u1' } });
    svc.publishFromRequest({ originalUrl: '/api/banners/admin', query: {}, body: {}, user: { userId: 'u1' } });
    flush();
    // private: admin + actor + the store (path id and query id both name rooms)
    const rooms = sent.filter((s) => s.topics.includes('orders')).map((s) => s.room).sort();
    expect(rooms).toEqual(['admin', `store:${OID2}`, `store:${OID}`, 'user:u1'].sort());
    // never broadcast an order topic to everyone
    expect(sent.some((s) => s.room === '*' && s.topics.includes('orders'))).toBe(false);
    // public: everyone
    expect(sent.some((s) => s.room === '*' && s.topics.includes('config'))).toBe(true);
  });

  it('emitTo reaches only the named users and stores (and admin unless disabled)', () => {
    const { svc, sent, flush } = make();
    svc.emitTo({ users: ['u9'], stores: [OID], admin: false }, ['orders']);
    flush();
    expect(sent.map((s) => s.room).sort()).toEqual([`store:${OID}`, 'user:u9'].sort());
  });
});
