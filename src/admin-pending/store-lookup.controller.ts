/* eslint-disable prettier/prettier */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { DatabaseService } from '../database/databaseservice';
import { queryString } from '../products/product-public-view.util';
import { lookupStores, type LookupStore } from './store-lookup.util';

const CACHE_MS = 60_000;

/** Admin picker: finds ANY store (every status) from a few letters, tolerating wrong spelling. Names/slugs only. */
@ApiTags('Admin store lookup')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/store-lookup')
export class StoreLookupController {
  private cache: { at: number; rows: LookupStore[] } | null = null;

  constructor(private readonly db: DatabaseService) {}

  private async all(): Promise<LookupStore[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.rows;
    const docs: any[] = await this.db.repositories.storeModel
      .find({ isDelete: { $ne: true } }, { name: 1, slug: 1, status: 1, sellerId: 1 })
      .limit(10000)
      .lean();
    const sellerIds = Array.from(new Set(docs.map(d => String(d.sellerId ?? '')).filter(Boolean)));
    const sellers: any[] = sellerIds.length
      ? await this.db.repositories.sellerModel.find({ _id: { $in: sellerIds } }, { name: 1, email: 1 }).lean()
      : [];
    const bySeller = new Map(sellers.map(s => [String(s._id), s]));
    const rows = docs.map(d => {
      const o = bySeller.get(String(d.sellerId ?? ''));
      return {
        id: String(d._id), name: String(d.name ?? ''), slug: String(d.slug ?? ''), status: d.status,
        email: o?.email ? String(o.email) : undefined, ownerName: o?.name ? String(o.name) : undefined,
      };
    });
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  @Get()
  async search(@Query() query: any) {
    const q = queryString(query.q, 100) ?? '';
    const stores = lookupStores(await this.all(), q, 10);
    return { success: true, data: { stores } };
  }
}
