/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { EntitlementsService } from './entitlements.service';
import { PlatformAddonsService } from './platform-addons.service';
import { PurchaseAddonDto } from './dto/purchase-addon.dto';

describe('EntitlementsService — fail closed on incomplete plans', () => {
  const make = (limits: Record<string, unknown> | undefined, count = 5) => {
    const plan = limits === undefined ? null : { limits };
    const subModel: any = {
      findOne: () => ({ lean: async () => ({ platformPlanId: 'p1' }) }),
    };
    const planModel: any = {
      findById: () => ({ lean: async () => plan }),
      findOne: () => ({ lean: async () => null }),
    };
    const db: any = {
      repositories: {
        sellerPlatformSubscriptionModel: subModel,
        platformPlanModel: planModel,
        storeBannerModel: { countDocuments: async () => count },
        promotionRequestModel: { countDocuments: async () => count },
        productModel: { countDocuments: async () => count },
      },
    };
    return new EntitlementsService(db);
  };

  it('a plan that omits maxActiveStoreBanners is NOT unlimited — it takes the restrictive fallback', async () => {
    const svc = make({ maxProducts: 100, transactionFeeRate: 0.03 }); // banner/promotion limits absent
    const limits = await svc.getLimits('s1');
    expect(limits.maxActiveStoreBanners).toBe(4);
    expect(limits.maxActivePromotions).toBe(1);
    await expect(svc.assertCanCreateStoreBanner('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    ); // 5 existing >= 4
  });

  it('explicit plan values (including -1 = unlimited) still win over the fallback', async () => {
    const svc = make({
      maxProducts: -1,
      maxActiveStoreBanners: -1,
      maxActivePromotions: 9,
    });
    const limits = await svc.getLimits('s1');
    expect(limits.maxProducts).toBe(-1);
    expect(limits.maxActiveStoreBanners).toBe(-1);
    await expect(svc.assertCanCreateStoreBanner('s1')).resolves.toBeUndefined();
  });

  it('a store with no usable plan gets the restrictive fallback, never unlimited', async () => {
    const limits = await make(undefined).getLimits('s1');
    expect(limits.maxProducts).toBe(10);
    expect(limits.customDomainAllowed).toBe(false);
  });
});

describe('add-on purchases', () => {
  it('quantity must be a whole number from 1 to 100 (1.5 used to grant 750 credits for $15)', async () => {
    const check = async (quantity: unknown) =>
      validate(
        plainToInstance(PurchaseAddonDto, {
          addonType: 'extra_ai_credits',
          quantity,
        }),
      );
    expect((await check(1.5)).length).toBeGreaterThan(0);
    expect((await check(0)).length).toBeGreaterThan(0);
    expect((await check(101)).length).toBeGreaterThan(0);
    expect(await check(2)).toHaveLength(0);
  });

  const build = (grantImpl: () => Promise<void>) => {
    const addonModel: any = {
      create: jest.fn().mockResolvedValue({ _id: 'a1' }),
    };
    const repos: any = {
      sellerPlatformSubscriptionModel: {
        findOne: jest.fn().mockResolvedValue({ stripeCustomerId: 'cus_1' }),
      },
      platformAddonPurchaseModel: addonModel,
    };
    const gateway: any = {
      chargeSubscription: jest
        .fn()
        .mockResolvedValue({ success: true, providerChargeId: 'pi_9' }),
    };
    const ai: any = { grant: jest.fn().mockImplementation(grantImpl) };
    const activity: any = { log: jest.fn().mockResolvedValue(undefined) };
    const svc: any = new PlatformAddonsService(
      { repositories: repos } as any,
      gateway,
      activity,
      ai,
    );
    jest.spyOn(svc, 'verifyStoreOwnership').mockResolvedValue({});
    jest.spyOn(svc.logger, 'error').mockImplementation(() => undefined);
    return { svc, gateway, ai, activity };
  };

  it('passes the client Idempotency-Key into the Stripe charge so a double-click cannot charge twice', async () => {
    const { svc, gateway } = build(async () => undefined);
    await svc.purchaseAddon(
      'sel1',
      'st1',
      { addonType: 'extra_ai_credits', quantity: 1 },
      'k-123',
    );
    expect(gateway.chargeSubscription.mock.calls[0][2]).toMatchObject({
      idempotencyKey: 'addon_st1_extra_ai_credits_k-123',
    });
  });

  it('marks the credits as PURCHASED so the monthly reset keeps them', async () => {
    const { svc, ai } = build(async () => undefined);
    await svc.purchaseAddon('sel1', 'st1', {
      addonType: 'extra_ai_credits',
      quantity: 2,
    });
    expect(ai.grant).toHaveBeenCalledWith(
      'st1',
      'sel1',
      1000,
      expect.any(String),
      'purchase',
    );
  });

  it('a wallet-grant failure after the charge raises a security alert instead of failing silently', async () => {
    const { svc, activity } = build(async () => {
      throw new Error('mongo down');
    });
    const res: any = await svc.purchaseAddon('sel1', 'st1', {
      addonType: 'extra_ai_credits',
      quantity: 1,
    });
    expect(res.success).toBe(true);
    expect(activity.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'addon_credits_grant_failed',
        isSecurityAlert: true,
      }),
    );
  });
});
