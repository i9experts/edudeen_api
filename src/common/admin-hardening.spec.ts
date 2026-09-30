/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
/**
 * Phase 6 (admin modules). Unit tests always run; the "real MongoDB" block runs only when TEST_MONGO_URI is set:
 *   TEST_MONGO_URI='mongodb://127.0.0.1:27018/edudeen_adm_it?replicaSet=rs0' npx jest admin-hardening
 */
import 'reflect-metadata';
import mongoose from 'mongoose';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ParseObjectIdPipe } from './parse-object-id.pipe';
import { suspendSellerCascade } from './seller-suspension.util';
import { toCsv } from '../analytics/utils/csv.util';
import { AdminUsersService } from '../admin-users/admin-users.service';
import { AdminModerationService } from '../admin-moderation/admin-moderation.service';
import { AdminMarketingService } from '../admin-marketing/admin-marketing.service';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { AdminAnnouncementsService } from '../admin-announcements/admin-announcements.service';
import { AdminUsersQueryDto } from '../admin-users/dto/admin-users-query.dto';
import { CreatePlatformCouponDto } from '../admin-marketing/dto/create-platform-coupon.dto';
import { SellerSchema } from '../seller/seller.schema';
import { StoreSchema } from '../store/schemas/store.schema';
import { ReportSchema } from '../messaging/schemas/report.schema';
import { RatingSchema } from '../rating/schema/rating.schema';
import { UserSchema } from '../users/schemas/user.schema';

const activity: any = { log: jest.fn().mockResolvedValue(undefined) };
const OID = () => new mongoose.Types.ObjectId().toString();

describe('ParseObjectIdPipe', () => {
  const pipe = new ParseObjectIdPipe();
  it('accepts a 24-hex id and rejects everything else with 400', () => {
    expect(pipe.transform(OID())).toHaveLength(24);
    for (const bad of [
      'abc',
      '',
      undefined,
      { $ne: 1 },
      '12345678901234567890123z',
      '../x',
    ]) {
      expect(() => pipe.transform(bad)).toThrow(BadRequestException);
    }
  });
});

describe('analytics CSV export', () => {
  it('defuses spreadsheet formulas in user-controlled names', () => {
    const csv = toCsv(
      ['Store', 'Revenue'],
      [
        ['=HYPERLINK("http://evil","x")', 10],
        ['+SUM(A1)', 5],
        ['Normal', 1],
      ],
    );
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")",10`);
    expect(csv).toContain(`"'+SUM(A1)",5`);
    expect(csv).toContain('"Normal",1');
  });
});

describe('admin DTO bounds', () => {
  it('list queries cap limit at 100, cap search length and restrict status', async () => {
    const bad = plainToInstance(AdminUsersQueryDto, {
      limit: '100000',
      search: 'x'.repeat(500),
      status: '$ne',
    });
    const errs = await validate(bad);
    expect(errs.map((e) => e.property).sort()).toEqual([
      'limit',
      'search',
      'status',
    ]);
    expect(
      await validate(
        plainToInstance(AdminUsersQueryDto, { limit: '100', search: 'ok' }),
      ),
    ).toHaveLength(0);
  });
  it('platform coupon code must be a plain 3-32 char token', async () => {
    const mk = (code: string) =>
      plainToInstance(CreatePlatformCouponDto, {
        code,
        discountType: 'fixed',
        discountValue: 5,
      });
    expect(await validate(mk('WELCOME10'))).toHaveLength(0);
    for (const c of ['a', 'has space', '<script>', 'X'.repeat(40)])
      expect((await validate(mk(c))).length).toBeGreaterThan(0);
  });
});

describe('AdminUsersService.getById', () => {
  it('never selects credential / OTP / push-token fields', async () => {
    const select = jest.fn().mockResolvedValue({ _id: 'u1', name: 'A' });
    const findOne = jest.fn().mockReturnValue({ select });
    const svc = new AdminUsersService(
      { repositories: { userModel: { findOne } } } as any,
      activity,
    );
    await svc.getById('buyer', OID());
    const projection: string = select.mock.calls[0][0];
    for (const f of ['password', 'otp', 'fcmToken', 'tokenVersion'])
      expect(projection).toContain(`-${f}`);
  });
  it('search text is matched literally (regex metacharacters escaped)', async () => {
    const aggregate = jest.fn().mockResolvedValue([]);
    const svc: any = new AdminUsersService(
      {
        repositories: {
          userModel: {
            aggregate,
            countDocuments: jest.fn().mockResolvedValue(0),
          },
          storeModel: { find: jest.fn().mockResolvedValue([]) },
        },
      } as any,
      activity,
    );
    await svc.list({ role: 'buyer', search: '(a+)+$', page: 1, limit: 5 });
    const match = aggregate.mock.calls[0][0][0].$match;
    expect(match.$or[0].name.$regex).toBe('\\(a\\+\\)\\+\\$');
  });
});

describe('AdminModerationService — report claiming', () => {
  const build = (findOneAndUpdate: any, exists: any) => {
    const reportModel: any = {
      findOneAndUpdate,
      exists,
      updateOne: jest.fn().mockResolvedValue({}),
    };
    const ratingModel: any = { updateOne: jest.fn().mockResolvedValue({}) };
    const productModel: any = { updateOne: jest.fn().mockResolvedValue({}) };
    return {
      svc: new AdminModerationService(
        { repositories: { reportModel, ratingModel, productModel } } as any,
        activity,
      ),
      reportModel,
      ratingModel,
      productModel,
    };
  };
  const meta = { adminId: 'a1' };

  it('an already-resolved report cannot be approved or removed again (409) and nothing is touched', async () => {
    const { svc, productModel, ratingModel } = build(
      jest.fn().mockResolvedValue(null),
      jest.fn().mockResolvedValue({ _id: 'x' }),
    );
    await expect(svc.remove(OID(), meta)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(svc.approve(OID(), meta)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(productModel.updateOne).not.toHaveBeenCalled();
    expect(ratingModel.updateOne).not.toHaveBeenCalled();
  });

  it('removing a review report actually hides the review', async () => {
    const id = OID();
    const { svc, ratingModel } = build(
      jest.fn().mockResolvedValue({
        targetType: 'review',
        targetId: id,
        status: 'pending',
      }),
      jest.fn(),
    );
    await svc.remove(OID(), meta);
    expect(ratingModel.updateOne).toHaveBeenCalledWith(
      { _id: id },
      { $set: { isDelete: true } },
    );
  });

  it('if the action fails the report is put back instead of staying "removed"', async () => {
    const { svc, reportModel, productModel } = build(
      jest.fn().mockResolvedValue({
        targetType: 'listing',
        targetId: OID(),
        status: 'reviewed',
        resolution: null,
      }),
      jest.fn(),
    );
    productModel.updateOne.mockRejectedValue(new Error('db down'));
    await expect(svc.remove(OID(), meta)).rejects.toThrow('db down');
    expect(reportModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved', resolution: 'removed' }),
      {
        $set: expect.objectContaining({ status: 'reviewed', resolvedAt: null }),
      },
    );
  });
});

describe('AdminMarketingService', () => {
  const svcWith = (couponModel: any = {}, campaignModel: any = {}) =>
    new AdminMarketingService(
      { repositories: { couponModel, campaignModel } } as any,
      activity,
    );

  it('rejects a 0-value or already-expired platform coupon', async () => {
    const svc = svcWith();
    await expect(
      svc.createPlatformCoupon(
        { code: 'ABC', discountType: 'fixed', discountValue: 0 } as any,
        { adminId: 'a' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.createPlatformCoupon(
        {
          code: 'ABC',
          discountType: 'fixed',
          discountValue: 5,
          expiresAt: '2020-01-01T00:00:00Z',
        } as any,
        { adminId: 'a' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a re-used code (unique index also covers soft-deleted rows) is a 409, not a 500', async () => {
    const couponModel = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockRejectedValue({ code: 11000 }),
    };
    await expect(
      svcWith(couponModel).createPlatformCoupon(
        { code: 'abc', discountType: 'percentage', discountValue: 10 } as any,
        { adminId: 'a' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('ended campaigns do not hold a rotation slot', async () => {
    const findOne = jest.fn().mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(null) }),
    });
    await (svcWith({}, { findOne }) as any).assertOrderAvailable(0);
    expect(findOne.mock.calls[0][0]).toMatchObject({
      order: 0,
      status: { $ne: 'ended' },
    });
  });

  it('an ended campaign cannot be re-activated without extending endDate', async () => {
    const campaignModel = {
      findOne: jest.fn().mockResolvedValue({
        name: 'c',
        endDate: new Date('2020-01-01'),
        status: 'ended',
        order: 0,
      }),
      findByIdAndUpdate: jest.fn(),
    };
    await expect(
      svcWith({}, campaignModel).setCampaignStatus(
        OID(),
        { status: 'active' } as any,
        { adminId: 'a' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(campaignModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('listCampaigns rejects an operator-object status', async () => {
    const svc = svcWith({}, { find: jest.fn(), updateMany: jest.fn() }) as any;
    svc.expireCampaigns = jest.fn().mockResolvedValue({ expired: 0 });
    await expect(svc.listCampaigns({ $ne: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('AdminConfigService cross-field validation', () => {
  const build = (fxConfig: any) => {
    const svc: any = new AdminConfigService(
      {
        repositories: {
          platformConfigModel: {
            findOneAndUpdate: jest.fn().mockResolvedValue({ fxConfig }),
          },
        },
      } as any,
      activity,
    );
    return svc;
  };
  it('manual-payment rate must sit inside the FX sanity band', async () => {
    const svc = build({ sanityBandMinPKR: 150, sanityBandMaxPKR: 450 });
    await expect(
      svc.updateManualPaymentConfig({ usdToPkrRate: 27.8 }, { adminId: 'a' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.updateManualPaymentConfig({ usdToPkrRate: 27800 }, { adminId: 'a' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.updateManualPaymentConfig({ usdToPkrRate: 280 }, { adminId: 'a' }),
    ).resolves.toMatchObject({ success: true });
  });
  it('a partial FX update cannot leave min >= max', async () => {
    const svc = build({ sanityBandMinPKR: 150, sanityBandMaxPKR: 450 });
    await expect(
      svc.updateFxConfig({ sanityBandMinPKR: 500 }, { adminId: 'a' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('festival override must end after it starts', async () => {
    const svc = build({});
    await expect(
      svc.updatePromotionPricing(
        {
          homepageHero: {
            festivalOverrides: [
              {
                name: 'F',
                startAt: '2026-02-02',
                endAt: '2026-02-01',
                rate: 5,
              },
            ],
          },
        },
        { adminId: 'a' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AdminAnnouncementsService public read', () => {
  it('does not expose createdBy', async () => {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const svc = new AdminAnnouncementsService(
      {
        repositories: {
          announcementModel: { find: jest.fn().mockReturnValue(chain) },
        },
      } as any,
      activity,
    );
    await svc.getActiveForAudience('buyers');
    expect(chain.select.mock.calls[0][0]).not.toContain('createdBy');
  });
});

const URI = process.env.TEST_MONGO_URI ?? process.env.TEST_MONGO_REPLSET_URI;
if (URI && !/(_it|test)/i.test(new URL(URI).pathname))
  throw new Error(
    'Refusing to run: the test database name must contain "_it" or "test"',
  );
(URI ? describe : describe.skip)(
  'seller suspension & report actions — real MongoDB',
  () => {
    let conn: mongoose.Connection,
      Seller: mongoose.Model<any>,
      Store: mongoose.Model<any>,
      Report: mongoose.Model<any>,
      Rating: mongoose.Model<any>,
      User: mongoose.Model<any>;
    let users: AdminUsersService, moderation: AdminModerationService, db: any;
    beforeAll(async () => {
      conn = await mongoose.createConnection(URI!).asPromise();
      Seller = conn.model('Seller', SellerSchema);
      Store = conn.model('Store', StoreSchema);
      Report = conn.model('Report', ReportSchema);
      Rating = conn.model('Rating', RatingSchema);
      User = conn.model('User', UserSchema);
      db = {
        repositories: {
          sellerModel: Seller,
          storeModel: Store,
          reportModel: Report,
          ratingModel: Rating,
          userModel: User,
        },
      };
      users = new AdminUsersService(db, activity);
      moderation = new AdminModerationService(db, activity);
    });
    beforeEach(() =>
      Promise.all(
        [Seller, Store, Report, Rating, User].map((m) => m.deleteMany({})),
      ),
    );
    afterAll(async () => {
      await conn.dropDatabase();
      await conn.close();
    });

    const seed = async () => {
      const seller = await Seller.create({
        name: 'S',
        email: 's@x.io',
        role: 'seller',
        status: 'active',
        isDelete: false,
      });
      const s1 = await Store.create({
        sellerId: String(seller._id),
        name: 'one',
        slug: 'one-' + OID(),
        status: 'active',
        isDelete: false,
      });
      const s2 = await Store.create({
        sellerId: String(seller._id),
        name: 'two',
        slug: 'two-' + OID(),
        status: 'active',
        isDelete: false,
      });
      return { seller, s1, s2, id: String(seller._id) };
    };
    const meta = { adminId: 'admin1' };

    it('suspending twice keeps the restore list, so unsuspend brings every store back', async () => {
      const { id, s1, s2 } = await seed();
      await users.suspend('seller', id, meta);
      await users.suspend('seller', id, meta); // used to overwrite cascadeSuspendedStoreIds with []
      const mid = await Seller.findById(id).lean();
      expect(mid!.cascadeSuspendedStoreIds.sort()).toEqual(
        [String(s1._id), String(s2._id)].sort(),
      );
      expect(mid!.tokenVersion).toBe(1); // session revoked once, not bumped on the repeat
      await users.unsuspend('seller', id, meta);
      expect(
        (await Store.find({ sellerId: id }).lean()).map((s) => s.status),
      ).toEqual(['active', 'active']);
      expect((await Seller.findById(id).lean())!.status).toBe('active');
    });

    it('a report "remove" on an already-suspended seller does not lose the restore list', async () => {
      const { id, s1, s2 } = await seed();
      await users.suspend('seller', id, meta);
      const rpt = await Report.create({
        reporterId: OID(),
        reporterRole: 'user',
        targetType: 'seller',
        targetId: id,
        reason: 'fraud',
      });
      await moderation.remove(String(rpt._id), meta);
      expect(
        (await Seller.findById(id).lean())!.cascadeSuspendedStoreIds.sort(),
      ).toEqual([String(s1._id), String(s2._id)].sort());
      await users.unsuspend('seller', id, meta);
      expect(
        (await Store.find({ sellerId: id }).lean()).every(
          (s) => s.status === 'active',
        ),
      ).toBe(true);
    });

    it('unsuspend only works on a suspended account (409), for buyers and sellers', async () => {
      const { id } = await seed();
      await expect(users.unsuspend('seller', id, meta)).rejects.toBeInstanceOf(
        ConflictException,
      );
      const buyer = await User.create({
        name: 'B',
        email: 'b@x.io',
        role: 'user',
        status: 'active',
        isDelete: false,
      });
      await expect(
        users.unsuspend('buyer', String(buyer._id), meta),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('two admins actioning the same report: exactly one wins', async () => {
      const { id } = await seed();
      const rpt = await Report.create({
        reporterId: OID(),
        reporterRole: 'user',
        targetType: 'seller',
        targetId: id,
        reason: 'fraud',
      });
      const results = await Promise.allSettled([
        moderation.remove(String(rpt._id), meta),
        moderation.approve(String(rpt._id), meta),
        moderation.remove(String(rpt._id), meta),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    });

    it('suspendSellerCascade reports not-found for a missing seller', async () => {
      expect(await suspendSellerCascade(db, OID())).toEqual({
        found: false,
        suspendedStores: 0,
      });
    });

    it('removing a review report hides the review', async () => {
      const rating = await Rating.create({
        userId: OID(),
        productId: OID(),
        rating: 1,
        isDelete: false,
      });
      const rpt = await Report.create({
        reporterId: OID(),
        reporterRole: 'user',
        targetType: 'review',
        targetId: String(rating._id),
        reason: 'other',
      });
      await moderation.remove(String(rpt._id), meta);
      expect((await Rating.findById(rating._id).lean())!.isDelete).toBe(true);
    });
  },
);
