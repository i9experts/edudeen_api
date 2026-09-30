/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method, @typescript-eslint/require-await -- mock-heavy tests */
import { JwtService } from '@nestjs/jwt';
import { WsAuthService } from './ws-auth.service';
import { MessagingGateway } from '../messaging/messaging.gateway';

process.env.JWT_SECRET = 'ws-test-secret';
const jwt = new JwtService({ secret: 'ws-test-secret' });

const sign = (claims: Record<string, unknown>) => jwt.sign({ sub: 'u1', role: 'user', tokenVersion: 0, typ: 'access', ...claims }, { expiresIn: 60 });
const clientWith = (handshake: Record<string, unknown>): any => ({ handshake: { auth: {}, query: {}, headers: {}, ...handshake } });

function build(account: Record<string, unknown> | null = { tokenVersion: 0, status: 'active', isDelete: false }, redis: { isConnected: boolean; get?: any } = { isConnected: true, get: jest.fn().mockResolvedValue('u1') }) {
  const model: any = { findById: () => ({ select: () => ({ lean: async () => account }) }) };
  const db: any = { repositories: { userModel: model, sellerModel: model, adminModel: model } };
  return new WsAuthService(jwt, db, redis as any);
}

describe('WsAuthService.authenticate', () => {
  it('accepts a valid live access token from handshake.auth', async () => {
    const token = sign({});
    await expect(build().authenticate(clientWith({ auth: { token } }))).resolves.toEqual({ userId: 'u1', role: 'user' });
  });

  it('refuses a REFRESH token and an order-DOWNLOAD token (same secret, must never open a socket)', async () => {
    for (const typ of ['refresh', 'download']) {
      await expect(build().authenticate(clientWith({ auth: { token: sign({ typ }) } }))).resolves.toBeNull();
    }
  });

  it('refuses a token whose tokenVersion is stale (password reset / suspend / logout-all)', async () => {
    await expect(build({ tokenVersion: 3, status: 'active', isDelete: false }).authenticate(clientWith({ auth: { token: sign({ tokenVersion: 2 }) } }))).resolves.toBeNull();
  });

  it('refuses suspended, deleted and missing accounts', async () => {
    const auth = { auth: { token: sign({}) } };
    await expect(build({ tokenVersion: 0, status: 'suspended', isDelete: false }).authenticate(clientWith(auth))).resolves.toBeNull();
    await expect(build({ tokenVersion: 0, status: 'active', isDelete: true }).authenticate(clientWith(auth))).resolves.toBeNull();
    await expect(build(null).authenticate(clientWith(auth))).resolves.toBeNull();
  });

  it('refuses a token whose Redis session was removed (logout)', async () => {
    const svc = build(undefined, { isConnected: true, get: jest.fn().mockResolvedValue(null) });
    await expect(svc.authenticate(clientWith({ auth: { token: sign({}) } }))).resolves.toBeNull();
  });

  it('still authenticates when Redis is down (same fallback as JwtAuthGuard)', async () => {
    const svc = build(undefined, { isConnected: false });
    await expect(svc.authenticate(clientWith({ auth: { token: sign({}) } }))).resolves.toMatchObject({ userId: 'u1' });
  });

  it('refuses an unknown role, a bad signature and garbage', async () => {
    await expect(build().authenticate(clientWith({ auth: { token: sign({ role: 'root' }) } }))).resolves.toBeNull();
    await expect(build().authenticate(clientWith({ auth: { token: new JwtService({ secret: 'other' }).sign({ sub: 'u1', role: 'user' }) } }))).resolves.toBeNull();
    await expect(build().authenticate(clientWith({ auth: { token: 'nope' } }))).resolves.toBeNull();
    await expect(build().authenticate(clientWith({}))).resolves.toBeNull();
  });

  it('a token in the QUERY STRING (ends up in proxy logs) is refused unless WS_ALLOW_QUERY_TOKEN=true', async () => {
    const token = sign({});
    const svc = build();
    jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    delete process.env.WS_ALLOW_QUERY_TOKEN;
    await expect(svc.authenticate(clientWith({ query: { token } }))).resolves.toBeNull();
    process.env.WS_ALLOW_QUERY_TOKEN = 'true';
    await expect(svc.authenticate(clientWith({ query: { token } }))).resolves.toMatchObject({ userId: 'u1' });
    delete process.env.WS_ALLOW_QUERY_TOKEN;
  });

  it('accepts an Authorization: Bearer header', async () => {
    await expect(build().authenticate(clientWith({ headers: { authorization: `Bearer ${sign({})}` } }))).resolves.toMatchObject({ userId: 'u1' });
  });
});

describe('MessagingGateway (scoped presence / typing)', () => {
  const make = (convs: any[] = []) => {
    const emitted: Array<{ room: string; event: string }> = [];
    const server: any = { to: (room: string) => ({ emit: (event: string) => emitted.push({ room, event }) }) };
    const conversationModel: any = { find: () => ({ select: () => ({ lean: async () => convs }) }), findById: () => ({ lean: async () => null }) };
    const wsAuth: any = { authenticate: jest.fn().mockResolvedValue({ userId: 'me', role: 'user' }) };
    const gw: any = new MessagingGateway(wsAuth, { repositories: { conversationModel } } as any);
    gw.server = server;
    return { gw, emitted, wsAuth };
  };
  const socket = (): any => {
    const joined: string[] = [];
    return { data: {}, join: async (r: string) => { joined.push(r); }, joined, emit: jest.fn(), disconnect: jest.fn(), to: () => ({ emit: jest.fn() }) };
  };

  it('disconnects a handshake that fails authentication', async () => {
    const { gw, wsAuth } = make();
    wsAuth.authenticate.mockResolvedValue(null);
    const c = socket();
    await gw.handleConnection(c);
    expect(c.disconnect).toHaveBeenCalled();
    expect(c.joined).toEqual([]);
  });

  it('presence goes only to that user\'s watchers, never a namespace-wide broadcast', async () => {
    const { gw, emitted } = make();
    await gw.handleConnection(socket());
    expect(emitted).toEqual([{ room: 'watch:me', event: 'presence:me' }]);
  });

  it('presence:check is limited to counterparts and capped at 50 ids', async () => {
    const { gw } = make([{ buyerId: 'me', sellerId: 'seller-1' }]);
    const c = socket();
    c.data.userId = 'me';
    await gw.handlePresenceCheck(c, ['seller-1', 'stranger', 5 as any, ...Array.from({ length: 200 }, (_, i) => `x${i}`)]);
    const [, statuses] = c.emit.mock.calls[0];
    expect(statuses.map((s: any) => s.userId)).toEqual(['seller-1']); // "stranger" is not a counterpart
    expect(c.joined).toEqual(['watch:seller-1']);
  });

  it('typing is ignored for a conversation this socket never joined', () => {
    const { gw } = make();
    const to = jest.fn().mockReturnValue({ emit: jest.fn() });
    const c: any = { data: { userId: 'me', joinedConversations: new Set(['c1']) }, to };
    gw.handleTyping(c, { conversationId: 'someone-elses', isTyping: true });
    expect(to).not.toHaveBeenCalled();
    gw.handleTyping(c, { conversationId: 'c1', isTyping: true });
    expect(to).toHaveBeenCalledWith('conversation:c1');
  });
});
