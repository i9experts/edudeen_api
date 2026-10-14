/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
/* eslint-disable prettier/prettier */
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';

// bcrypt hashing is CPU-bound; on a loaded CI/dev machine the 5s default is too tight (assertions unchanged).
jest.setTimeout(30_000);

describe('UsersService.changePassword', () => {
  const setup = async () => {
    const acc: any = { _id: 'u1', tokenVersion: 2, password: await bcrypt.hash('OldPassword1', 4) };
    acc.save = jest.fn().mockResolvedValue(acc);
    const model: any = { findById: jest.fn().mockResolvedValue(acc) };
    const db: any = { repositories: { userModel: model, sellerModel: model, adminModel: model } };
    const auth: any = { issueSession: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }) };
    return { acc, service: new UsersService(db, auth), auth };
  };

  it('revokes other sessions (tokenVersion bump) and returns a fresh token pair', async () => {
    const { acc, service, auth } = await setup();
    const res: any = await service.changePassword('u1', 'user', { currentPassword: 'OldPassword1', newPassword: 'NewPassword2' });
    expect(acc.tokenVersion).toBe(3);
    expect(await bcrypt.compare('NewPassword2', acc.password)).toBe(true);
    // The fresh session must be minted from the account AFTER the bump.
    expect(auth.issueSession).toHaveBeenCalledWith(expect.objectContaining({ tokenVersion: 3 }));
    expect(res.data.token).toEqual({ accessToken: 'a', refreshToken: 'r' });
  });

  it('does not touch sessions when the current password is wrong', async () => {
    const { acc, service } = await setup();
    await expect(service.changePassword('u1', 'user', { currentPassword: 'nope', newPassword: 'NewPassword2' })).rejects.toThrow(/incorrect/);
    expect(acc.tokenVersion).toBe(2);
    expect(acc.save).not.toHaveBeenCalled();
  });
});

describe('UsersService.changePassword per role', () => {
  const build = async (role: 'user' | 'seller' | 'admin') => {
    const mk = async (hash?: string) => {
      const acc: any = { _id: 'x', tokenVersion: 0, password: hash };
      acc.save = jest.fn().mockResolvedValue(acc);
      return acc;
    };
    const buyer = await mk(await bcrypt.hash('BuyerPass1', 4));
    const seller = await mk(await bcrypt.hash('OldPassword1', 4));
    const admin = await mk(await bcrypt.hash('AdminPass1', 4));
    const mdl = (a: any) => ({ findById: jest.fn().mockResolvedValue(a) });
    const db: any = { repositories: { userModel: mdl(buyer), sellerModel: mdl(seller), adminModel: mdl(admin) } };
    const auth: any = { issueSession: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }) };
    return { buyer, seller, admin, service: new UsersService(db, auth), role };
  };

  it('seller change saves the NEW hash on the seller document only (old password stops matching)', async () => {
    const { buyer, seller, service } = await build('seller');
    await service.changePassword('x', 'seller', { currentPassword: 'OldPassword1', newPassword: 'BrandNew#99' });
    expect(seller.save).toHaveBeenCalledTimes(1);
    expect(buyer.save).not.toHaveBeenCalled();
    expect(await bcrypt.compare('BrandNew#99', seller.password)).toBe(true);
    expect(await bcrypt.compare('OldPassword1', seller.password)).toBe(false);
    expect(seller.tokenVersion).toBe(1);
  });

  it('seller with the wrong current password is rejected and nothing is saved', async () => {
    const { seller, service } = await build('seller');
    await expect(service.changePassword('x', 'seller', { currentPassword: 'BuyerPass1', newPassword: 'BrandNew#99' })).rejects.toThrow(/incorrect/);
    expect(seller.save).not.toHaveBeenCalled();
  });

  it('rejects an unknown role and social-only accounts without a password', async () => {
    const { service } = await build('seller');
    await expect(service.changePassword('x', 'nobody', { currentPassword: 'a', newPassword: 'BrandNew#99' })).rejects.toThrow(/Invalid user type/);
    const acc: any = { _id: 'x', password: undefined, save: jest.fn() };
    const db: any = { repositories: { sellerModel: { findById: jest.fn().mockResolvedValue(acc) } } };
    const s2 = new UsersService(db, { issueSession: jest.fn() } as any);
    await expect(s2.changePassword('x', 'seller', { currentPassword: 'a', newPassword: 'BrandNew#99' })).rejects.toThrow(/social-login/);
  });
});