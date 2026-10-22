/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { AdminConfigService } from './admin-config.service';

function make(config: any) {
  const model: any = {
    findOne: jest.fn(() => ({ lean: async () => config })),
    findOneAndUpdate: jest.fn().mockResolvedValue(config),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const log = jest.fn();
  const svc = new AdminConfigService({ repositories: { platformConfigModel: model } } as any, { log } as any);
  return { svc, model, log };
}
const meta = { adminId: 'a1' };

describe('AdminConfigService platform fees', () => {
  it('rejects a percentage above 100', async () => {
    const { svc, model } = make({});
    await expect(svc.updatePlatformFees({ digital: { mode: 'percentage', value: 120 } } as any, meta)).rejects.toThrow(BadRequestException);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a negative fixed fee and an empty body', async () => {
    const { svc } = make({});
    await expect(svc.updatePlatformFees({ physical: { mode: 'fixed', value: -1 } } as any, meta)).rejects.toThrow(BadRequestException);
    await expect(svc.updatePlatformFees({} as any, meta)).rejects.toThrow(BadRequestException);
  });

  it('saves per-type rules and writes an audit entry', async () => {
    const { svc, model, log } = make({ platformFees: {} });
    await svc.updatePlatformFees({ digital: { mode: 'percentage', value: 10 }, physical: { mode: 'fixed', value: 0.5 } } as any, meta);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith({}, { $set: { 'platformFees.digital': { mode: 'percentage', value: 10 }, 'platformFees.physical': { mode: 'fixed', value: 0.5 } } }, expect.anything());
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_fees_updated' }));
  });

  it('getPlatformFees is null when unset or invalid, and keeps only valid rules', async () => {
    expect(await make({ platformFees: null }).svc.getPlatformFees()).toBeNull();
    expect(await make({ platformFees: { digital: { mode: 'bogus', value: 5 } } }).svc.getPlatformFees()).toBeNull();
    expect(await make({ platformFees: { digital: { mode: 'percentage', value: 7 }, physical: { mode: 'x', value: 1 } } }).svc.getPlatformFees()).toEqual({ digital: { mode: 'percentage', value: 7 } });
  });
});

describe('AdminConfigService platform transfer details', () => {
  it('is available when account details are filled and not explicitly disabled', async () => {
    expect(await make({ manualPaymentConfig: { enabled: true, accountNumber: '123' } }).svc.isManualTransferAvailable()).toBe(true);
    expect(await make({ manualPaymentConfig: { jazzcashNumber: '0300' } }).svc.isManualTransferAvailable()).toBe(true);
  });
  it('is unavailable with no details or when switched off', async () => {
    expect(await make({ manualPaymentConfig: { enabled: true } }).svc.isManualTransferAvailable()).toBe(false);
    expect(await make({ manualPaymentConfig: { enabled: false, accountNumber: '123' } }).svc.isManualTransferAvailable()).toBe(false);
  });
});
