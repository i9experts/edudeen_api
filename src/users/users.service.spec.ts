/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- mock-heavy tests */
/* eslint-disable prettier/prettier */
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';

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
