import { BadRequestException } from '@nestjs/common';
import { ExchangeRateService } from './exchange-rate.service';

function make(opts: { held?: any; newer?: boolean; claim?: any } = {}) {
  const held = opts.held === undefined ? { _id: 'h1', currency: 'PKR', ratePerUSD: 300, effectiveFrom: new Date('2026-01-01') } : opts.held;
  const model: any = {
    findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(held) }),
    exists: jest.fn().mockResolvedValue(opts.newer ? { _id: 'n' } : null),
    findOneAndUpdate: jest.fn().mockResolvedValue(opts.claim === undefined ? held : opts.claim),
    create: jest.fn().mockImplementation(async (d: any) => ({ _id: 'new1', ...d })),
    find: jest.fn(),
  };
  const log = jest.fn().mockResolvedValue(true);
  const svc = new ExchangeRateService(
    { repositories: { exchangeRateModel: model } } as any,
    { getFxConfig: jest.fn().mockResolvedValue({ sanityBandMinPKR: 150, sanityBandMaxPKR: 450 }) } as any,
    { log } as any,
  );
  return { svc, model, log };
}

describe('held FX rates', () => {
  it('confirm applies the held rate as a NEW current row and logs who did it', async () => {
    const { svc, model, log } = make();
    const out = await svc.confirmHeldRate('h1', { adminId: 'a1' });
    expect(out.applied).toBe(true);
    expect(model.create).toHaveBeenCalledWith(expect.objectContaining({ currency: 'PKR', ratePerUSD: 300, source: 'admin', createdBy: 'a1', isRejected: false }));
    expect(model.findOneAndUpdate).toHaveBeenCalledWith({ _id: 'h1', heldResolution: null }, { $set: expect.objectContaining({ heldResolution: 'confirmed', heldResolvedBy: 'a1' }) });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'fx_held_rate_confirmed', actorId: 'a1' }));
  });

  it('refuses a rate that was already decided or does not exist', async () => {
    const { svc, model } = make({ held: null });
    await expect(svc.confirmHeldRate('h1')).rejects.toBeInstanceOf(BadRequestException);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('refuses to roll back a newer rate: a rate was applied after this one was held', async () => {
    const { svc, model } = make({ newer: true });
    await expect(svc.confirmHeldRate('h1')).rejects.toThrow(/newer rate/);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('refuses a held rate that is outside the sane band now', async () => {
    const { svc } = make({ held: { _id: 'h1', currency: 'PKR', ratePerUSD: 900, effectiveFrom: new Date() } });
    await expect(svc.confirmHeldRate('h1')).rejects.toThrow(/sane band/);
  });

  it('two admins cannot both apply it: the loser of the atomic claim changes nothing', async () => {
    const { svc, model } = make({ claim: null });
    await expect(svc.confirmHeldRate('h1')).rejects.toThrow(/someone else/);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('dismiss marks it dismissed, applies nothing, and logs the reason', async () => {
    const { svc, model, log } = make();
    const out = await svc.dismissHeldRate('h1', 'looks wrong', { adminId: 'a1' });
    expect(out.dismissed).toBe(true);
    expect(model.create).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'fx_held_rate_dismissed', description: expect.stringContaining('looks wrong') }));
  });

  it('dismiss of an already decided rate is a 400', async () => {
    const { svc } = make({ claim: null });
    await expect(svc.dismissHeldRate('h1', undefined)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('stale-rate alert dedupe', () => {
  it('alerts once per currency per 10 minutes', () => {
    const { svc } = make();
    const t0 = 1_000_000;
    expect(svc.shouldAlertStale('PKR', t0)).toBe(true);
    expect(svc.shouldAlertStale('PKR', t0 + 60_000)).toBe(false);
    expect(svc.shouldAlertStale('PKR', t0 + 9 * 60_000)).toBe(false);
    expect(svc.shouldAlertStale('PKR', t0 + 10 * 60_000 + 1)).toBe(true);
  });

  it('currencies are deduped independently', () => {
    const { svc } = make();
    expect(svc.shouldAlertStale('PKR', 5)).toBe(true);
    expect(svc.shouldAlertStale('EUR', 6)).toBe(true);
    expect(svc.shouldAlertStale('EUR', 7)).toBe(false);
  });
});
