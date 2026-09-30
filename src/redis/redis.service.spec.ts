/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
import { EventEmitter } from 'events';
import { RedisService } from './redis.service';

// Minimal in-memory stand-in for the node-redis client: SET NX EX + the
// compare-and-delete release script.
class FakeClient extends EventEmitter {
  store = new Map<string, string>();
  set = jest.fn(async (k: string, v: string, o?: { NX?: boolean }) => {
    if (o?.NX && this.store.has(k)) return null;
    this.store.set(k, v);
    return 'OK';
  });
  eval = jest.fn(async (_script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
    if (this.store.get(keys[0]) === args[0]) { this.store.delete(keys[0]); return 1; }
    return 0;
  });
}

function makeService() {
  const svc: any = new RedisService();
  const fake = new FakeClient();
  // Re-bind the listeners the constructor registered on the real client.
  const real = svc.client as EventEmitter;
  for (const ev of ['error', 'ready', 'end']) for (const l of real.listeners(ev)) fake.on(ev, l as any);
  svc.client = fake;
  return { svc, fake };
}

describe('RedisService', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('recovers after a transient error: "ready" flips the connected flag back on', () => {
    const { svc, fake } = makeService();
    svc._isConnected = true;
    fake.emit('error', new Error('ECONNRESET'));
    expect(svc.isConnected).toBe(false);
    fake.emit('ready');
    expect(svc.isConnected).toBe(true);
  });

  it('skips the job (and does not run it) while disconnected', async () => {
    const { svc } = makeService();
    const fn = jest.fn();
    expect(await svc.withLock('k', 1000, fn)).toBe('lock_not_acquired');
    expect(fn).not.toHaveBeenCalled();
  });

  it('second holder cannot acquire while the first runs, and release frees it', async () => {
    const { svc } = makeService();
    svc._isConnected = true;
    let inner: string | undefined;
    await svc.withLock('k', 1000, async () => { inner = await svc.withLock('k', 1000, async () => undefined); });
    expect(inner).toBe('lock_not_acquired');
    expect(await svc.withLock('k', 1000, async () => undefined)).toBe('ran');
  });

  it("a job that outlived its TTL does not release the NEW holder's lock", async () => {
    const { svc, fake } = makeService();
    svc._isConnected = true;
    await svc.withLock('k', 1000, async () => {
      // TTL expires and another instance acquires the lock while we're still running.
      fake.store.set('k', 'other-instance-token');
    });
    expect(fake.store.get('k')).toBe('other-instance-token');
  });
});
