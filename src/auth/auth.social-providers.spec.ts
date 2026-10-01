/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
/* eslint-disable prettier/prettier */
jest.mock('apple-signin-auth', () => ({ verifyIdToken: jest.fn() }));

import { JwtService } from '@nestjs/jwt';
import * as appleSignin from 'apple-signin-auth';
import { AuthService } from './auth.service';

process.env.JWT_SECRET = 'test-secret';

function makeService() {
  const created: any[] = [];
  const model: any = jest.fn().mockImplementation((doc: any) => {
    const acc = { ...doc, _id: 'new-acc', tokenVersion: 0, status: 'active', isDelete: false, save: jest.fn() };
    created.push(acc);
    return acc;
  });
  model.findOne = jest.fn().mockResolvedValue(null);
  model.findById = jest.fn();
  const db: any = { repositories: { userModel: model, sellerModel: model, adminModel: model } };
  const service = new AuthService(db, { sendOtp: jest.fn() } as any, { set: jest.fn(), get: jest.fn(), del: jest.fn() } as any, { log: jest.fn() } as any, new JwtService({ secret: 'test-secret' }));
  return { service, created };
}

const json = (body: any) => Promise.resolve({ json: () => Promise.resolve(body) } as any);

describe('Facebook sign-in', () => {
  const realFetch = global.fetch;
  beforeEach(() => { process.env.FACEBOOK_APP_ID = 'our-app'; process.env.FACEBOOK_APP_SECRET = 'shh'; });
  afterEach(() => { global.fetch = realFetch; delete process.env.FACEBOOK_APP_ID; delete process.env.FACEBOOK_APP_SECRET; });

  it("creates the account from Facebook's confirmed email when the token is ours", async () => {
    global.fetch = jest.fn((url: string) => url.includes('debug_token')
      ? json({ data: { is_valid: true, app_id: 'our-app', user_id: 'fb-1' } })
      : json({ id: 'fb-1', email: 'Parent@Mail.com' })) as any;
    const { service, created } = makeService();
    const res: any = await service.socialLogin({ authProvider: 'facebook', socialId: 'fb-1', token: 'fbtok', name: 'Sara' } as any);
    expect(res.data.user.email).toBe('parent@mail.com');
    expect(created[0]).toEqual(expect.objectContaining({ authProvider: 'facebook', providerId: 'fb-1', isVerified: true }));
  });

  it('rejects a token issued to a different Facebook app', async () => {
    global.fetch = jest.fn((url: string) => url.includes('debug_token')
      ? json({ data: { is_valid: true, app_id: 'someone-elses-app', user_id: 'fb-1' } })
      : json({ id: 'fb-1', email: 'parent@mail.com' })) as any;
    const { service } = makeService();
    await expect(service.socialLogin({ authProvider: 'facebook', socialId: 'fb-1', token: 'fbtok' } as any)).rejects.toThrow(/Invalid Facebook token/);
  });
});

describe('Apple sign-in', () => {
  afterEach(() => { delete process.env.APPLE_CLIENT_IDS; delete process.env.APPLE_CLIENT_ID; });

  it('accepts the web Services ID or the iOS bundle id as the audience', async () => {
    process.env.APPLE_CLIENT_IDS = 'com.edudeen.web, com.edudeen.app';
    (appleSignin.verifyIdToken as jest.Mock).mockResolvedValue({ sub: 'ap-1', email: 'kid@icloud.com', email_verified: 'true' });
    const { service } = makeService();
    const res: any = await service.socialLogin({ authProvider: 'apple', socialId: 'ap-1', token: 'idtok' } as any);
    expect(appleSignin.verifyIdToken).toHaveBeenCalledWith('idtok', { audience: ['com.edudeen.web', 'com.edudeen.app'] });
    expect(res.data.user.email).toBe('kid@icloud.com');
  });

  it('refuses when Apple sign-in has no client id configured', async () => {
    const { service } = makeService();
    await expect(service.socialLogin({ authProvider: 'apple', socialId: 'ap-1', token: 'idtok' } as any)).rejects.toThrow(/not configured/);
  });
});
