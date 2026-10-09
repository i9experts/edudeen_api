import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AddressService } from './address.service';

// Regression: address failures used to be returned as `{ message }` with HTTP 201, so a seller
// session (no buyer record) saw a "successful" save that never happened.
describe('AddressService error handling', () => {
  const make = (userFound: boolean) => new AddressService({
    repositories: {
      userModel: { findById: jest.fn().mockResolvedValue(userFound ? { _id: 'u1' } : null) },
      addressModel: { updateMany: jest.fn(), create: jest.fn().mockResolvedValue({ _id: 'a1' }) },
    },
  } as any);

  it('throws 404 (not a 201 body) when the session has no buyer account', async () => {
    await expect(make(false).addAddress('s1', { addressLine1: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('turns unexpected failures into a 400, never a success-shaped response', async () => {
    const svc = new AddressService({
      repositories: { userModel: { findById: jest.fn().mockRejectedValue(new Error('db down')) } },
    } as any);
    await expect(svc.addAddress('u1', {})).rejects.toBeInstanceOf(BadRequestException);
  });
});
