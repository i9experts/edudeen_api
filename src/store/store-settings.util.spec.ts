/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
/** App backend gap #3: update-store rejects empty productTypes, a non-boolean codEnabled and a loose shipFrom. */
import { BadRequestException } from '@nestjs/common';
import { StoreService } from './store.service';
import { cleanCodEnabled, cleanShipFrom, cleanStoreProductTypes } from './store-settings.util';

const OID = '64f0c0ffee0c0ffee0c0ff01';
const ALLOWED = ['physical_products', 'digital_downloads'];

describe('store settings rules', () => {
  it('productTypes: a non-empty list of allowed types', () => {
    expect(() => cleanStoreProductTypes([], ALLOWED)).toThrow('Choose at least one product type for your store');
    expect(() => cleanStoreProductTypes('digital_downloads', ALLOWED)).toThrow('productTypes must be a list');
    expect(() => cleanStoreProductTypes(['pos'], ALLOWED)).toThrow(/Invalid productType: pos/);
    expect(cleanStoreProductTypes(['digital_downloads', 'digital_downloads'], ALLOWED)).toEqual(['digital_downloads']);
  });

  it('codEnabled: only true or false', () => {
    for (const bad of ['x', 'true', 1, 0, null, {}]) expect(() => cleanCodEnabled(bad)).toThrow('codEnabled must be true or false');
    expect(cleanCodEnabled(true)).toBe(true);
    expect(cleanCodEnabled(false)).toBe(false);
  });

  it('shipFrom: known province (canonical spelling), a province needs a city, null / empty clears', () => {
    expect(cleanShipFrom(null)).toBeNull();
    expect(cleanShipFrom({ city: '  ' })).toBeNull();
    expect(cleanShipFrom({ city: '', province: '' })).toBeNull();
    expect(cleanShipFrom({ city: ' Lahore ' })).toEqual({ city: 'Lahore', province: null });
    expect(cleanShipFrom({ city: 'Lahore', province: 'punjab' })).toEqual({ city: 'Lahore', province: 'Punjab' });
    expect(() => cleanShipFrom({ city: 'Lahore', province: 5 })).toThrow(/shipFrom.province must be one of: Sindh, Punjab/);
    expect(() => cleanShipFrom({ city: 'Lahore', province: 'Texas' })).toThrow(/shipFrom.province must be one of/);
    expect(() => cleanShipFrom({ province: 'Sindh' })).toThrow('Choose the city you ship from for this province');
    expect(() => cleanShipFrom({ city: 'x'.repeat(61) })).toThrow(/at most 60/);
    expect(() => cleanShipFrom([])).toThrow('shipFrom must be an object');
    expect(() => cleanShipFrom('Lahore')).toThrow('shipFrom must be an object');
  });
});

describe('updateStore applies the rules', () => {
  function make() {
    const store = { _id: OID, sellerId: 'seller1', name: 'Math Hub', status: 'active', save: jest.fn() };
    const repos: any = {
      storeModel: {
        findOne: jest.fn(() => { const r: any = Promise.resolve(store); r.lean = () => Promise.resolve(store); return r; }),
        findByIdAndUpdate: jest.fn().mockResolvedValue({}),
        exists: jest.fn().mockResolvedValue(true),
      },
      productModel: { exists: jest.fn().mockResolvedValue(null), countDocuments: jest.fn().mockResolvedValue(0) },
    };
    const svc: any = Object.create(StoreService.prototype);
    svc.databaseService = { repositories: repos };
    svc.activityLogService = { log: jest.fn() };
    svc.entitlementsService = { assertFeatureAllowed: jest.fn(), getLimits: jest.fn().mockResolvedValue({}) };
    svc.notificationsService = { notify: jest.fn() };
    return { svc, repos };
  }

  it('refuses each bad value with a 400 and saves nothing', async () => {
    const { svc, repos } = make();
    for (const body of [{ productTypes: [] }, { codEnabled: 'x' }, { shipFrom: { city: 'Lahore', province: 5 } }, { shipFrom: { province: 'Sindh' } }]) {
      await expect(svc.updateStore('seller1', OID, body)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(repos.storeModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('saves valid values', async () => {
    const { svc, repos } = make();
    await svc.updateStore('seller1', OID, { productTypes: ['digital_downloads'], codEnabled: false, shipFrom: { city: 'Karachi', province: 'sindh' } });
    const saved = JSON.stringify(repos.storeModel.findByIdAndUpdate.mock.calls[0]);
    expect(saved).toContain('"productTypes":["digital_downloads"]');
    expect(saved).toContain('"codEnabled":false');
    expect(saved).toContain('"shipFrom":{"city":"Karachi","province":"Sindh"}');
  });
});
