/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminConfigService } from './admin-config.service';
import { UpdateCodConfigDto } from './dto/update-cod-config.dto';

function make(config: any) {
  const model: any = {
    findOne: jest.fn(() => ({ lean: async () => config })),
    // Reads go through findOneAndUpdate({}, {}) (upsert); a real write returns the updated document.
    findOneAndUpdate: jest.fn(async (_f: any, u: any) => (u?.$set ? { ...config, cod: { maxPerPackagePKR: 20000, feePerPackagePKR: 100 } } : config)),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const log = jest.fn();
  const svc = new AdminConfigService({ repositories: { platformConfigModel: model } } as any, { log } as any);
  return { svc, model, log };
}
const meta = { adminId: 'a1' };

describe('Cash on Delivery settings', () => {
  it('defaults: no limit, no fee (nothing changes until an admin sets it)', async () => {
    expect(await make({}).svc.getCodConfig()).toEqual({ maxPerPackagePKR: null, feePerPackagePKR: 0 });
    expect(await make({ cod: null }).svc.getCodConfig()).toEqual({ maxPerPackagePKR: null, feePerPackagePKR: 0 });
    expect(await make({ cod: { maxPerPackagePKR: -5, feePerPackagePKR: 'x' } }).svc.getCodConfig()).toEqual({ maxPerPackagePKR: null, feePerPackagePKR: 0 });
  });

  it('reads stored values', async () => {
    expect(await make({ cod: { maxPerPackagePKR: 20000, feePerPackagePKR: 100 } }).svc.getCodConfig()).toEqual({ maxPerPackagePKR: 20000, feePerPackagePKR: 100 });
  });

  it('saves with dotted $set (null clears the limit) and writes an audit entry with before/after', async () => {
    const { svc, model, log } = make({ cod: { maxPerPackagePKR: 5000, feePerPackagePKR: 0 } });
    const res: any = await svc.updateCodConfig({ maxPerPackagePKR: null, feePerPackagePKR: 100 }, meta);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith({}, { $set: { 'cod.maxPerPackagePKR': null, 'cod.feePerPackagePKR': 100 } }, expect.anything());
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'cod_config_updated',
      metadata: { before: { maxPerPackagePKR: 5000, feePerPackagePKR: 0 }, after: { maxPerPackagePKR: 20000, feePerPackagePKR: 100 } },
    }));
    expect(res.success).toBe(true);
  });

  it('rejects an empty body', async () => {
    const { svc, model } = make({});
    await expect(svc.updateCodConfig({} as any, meta)).rejects.toThrow(BadRequestException);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('DTO: accepts numbers and null limit; rejects negatives, zero limit and non-numbers', async () => {
    const check = async (o: any) => (await validate(plainToInstance(UpdateCodConfigDto, o))).length;
    expect(await check({ maxPerPackagePKR: 20000, feePerPackagePKR: 150 })).toBe(0);
    expect(await check({ maxPerPackagePKR: null })).toBe(0);
    expect(await check({ feePerPackagePKR: 0 })).toBe(0);
    expect(await check({ feePerPackagePKR: -1 })).toBeGreaterThan(0);
    expect(await check({ maxPerPackagePKR: 0 })).toBeGreaterThan(0);
    expect(await check({ maxPerPackagePKR: 'abc' })).toBeGreaterThan(0);
  });
});
