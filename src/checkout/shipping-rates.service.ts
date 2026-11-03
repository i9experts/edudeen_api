import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ShippingRateTable, ShippingRateTableDocument } from './shipping.schema';
import { CourierSettings, DEFAULT_COURIER_SETTINGS, sanitizeCourierSettings } from './courier-settings.util';
import { DEFAULT_RATE_TABLE, RateTable, sanitizeRateTable } from './shipping-rate.util';

/** Reads/saves the admin's delivery rate table (one document). Cached for 30 s; every save clears it. */
@Injectable()
export class ShippingRatesService {
  private cache: { at: number; table: RateTable } | null = null;

  constructor(@InjectModel(ShippingRateTable.name) private readonly model: Model<ShippingRateTableDocument>) {}

  async get(): Promise<RateTable> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.table;
    const doc: any = await this.model.findOne({ key: 'default' }).lean();
    let table = DEFAULT_RATE_TABLE;
    if (doc?.table) {
      try { table = sanitizeRateTable(doc.table); } catch { table = DEFAULT_RATE_TABLE; }
    }
    this.cache = { at: Date.now(), table };
    return table;
  }

  async save(input: any): Promise<RateTable> {
    let table: RateTable;
    try { table = sanitizeRateTable(input); } catch (e: any) { throw new BadRequestException(e?.message ?? 'Invalid rate table'); }
    await this.model.updateOne({ key: 'default' }, { $set: { table } }, { upsert: true });
    this.cache = null;
    return table;
  }

  private courierCache: { at: number; settings: CourierSettings } | null = null;

  async getCourierSettings(): Promise<CourierSettings> {
    if (this.courierCache && Date.now() - this.courierCache.at < 30_000) return this.courierCache.settings;
    const doc: any = await this.model.findOne({ key: 'default' }).select('couriers').lean();
    let settings = DEFAULT_COURIER_SETTINGS;
    if (doc?.couriers) {
      try { settings = sanitizeCourierSettings(doc.couriers); } catch { settings = DEFAULT_COURIER_SETTINGS; }
    }
    this.courierCache = { at: Date.now(), settings };
    return settings;
  }

  async saveCourierSettings(input: any): Promise<CourierSettings> {
    let settings: CourierSettings;
    try { settings = sanitizeCourierSettings(input); } catch (e: any) { throw new BadRequestException(e?.message ?? 'Invalid courier settings'); }
    await this.model.updateOne({ key: 'default' }, { $set: { couriers: settings } }, { upsert: true });
    this.courierCache = null;
    return settings;
  }
}
