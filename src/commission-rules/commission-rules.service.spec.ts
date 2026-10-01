/* eslint-disable prettier/prettier */
import { NotFoundException } from '@nestjs/common';
import { CommissionRulesService } from './commission-rules.service';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { EntitlementsService } from '../platform-plans/entitlements.service';

const STORE_ID = 'store-1';
const ADMIN_ID = 'admin-1';

describe('CommissionRulesService', () => {
  let service: CommissionRulesService;
  let ruleModel: any;
  let storeModel: any;
  let db: DatabaseService;
  let activityLogService: ActivityLogService;
  let entitlementsService: EntitlementsService;

  /** `findOne` in the real service is always chained with `.lean()` — this helper keeps every
   * test's mock resolving through that same chain instead of a bare resolved promise. */
  const leanFindOne = (value: any) => jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) });

  beforeEach(() => {
    ruleModel = {
      findOne: leanFindOne(null),
      find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) }) }),
      countDocuments: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(async (doc: any) => ({ ...doc, save: jest.fn() })),
    };
    storeModel = {
      findById: jest.fn().mockResolvedValue({ _id: STORE_ID, isDelete: false }),
      find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
    };

    db = { repositories: { commissionRuleModel: ruleModel, storeModel } } as any;
    activityLogService = { log: jest.fn() } as any;
    entitlementsService = {
      getActivePlanForStore: jest.fn().mockResolvedValue(null),
      getTransactionFeeRate: jest.fn().mockResolvedValue(0.08),
    } as any;

    service = new CommissionRulesService(db, activityLogService, entitlementsService);
  });

  describe('resolveRate precedence', () => {
    it('uses the seller-specific override when one is active, regardless of plan or global default', async () => {
      ruleModel.findOne.mockImplementation((filter: any) => ({
        lean: jest.fn().mockResolvedValue(
          filter.scope === 'seller' ? { rate: 0.02, storeId: STORE_ID } : { rate: 0.05 }, // global default — should be ignored
        ),
      }));
      entitlementsService.getActivePlanForStore = jest.fn().mockResolvedValue({ plan: { limits: { transactionFeeRate: 0.03 } } });

      const result = await service.resolveRate(STORE_ID);
      expect(result).toEqual({ rate: 0.02, source: 'seller_override' });
    });

    // Monthly-plan model: Edudeen takes no per-sale cut, so a plan tier rate
    // or a global default left in the DB must never be charged.
    it('charges 0% when there is no seller override, ignoring plan tier and global default rates', async () => {
      ruleModel.findOne.mockImplementation((filter: any) => ({
        lean: jest.fn().mockResolvedValue(filter.scope === 'global' ? { rate: 0.05 } : null),
      }));
      entitlementsService.getActivePlanForStore = jest.fn().mockResolvedValue({ plan: { limits: { transactionFeeRate: 0.03 } } });

      const result = await service.resolveRate(STORE_ID);
      expect(result).toEqual({ rate: 0, source: 'hardcoded_fallback' });
    });

    it('charges 0% when nothing is configured at all', async () => {
      ruleModel.findOne = leanFindOne(null);
      entitlementsService.getActivePlanForStore = jest.fn().mockResolvedValue(null);

      const result = await service.resolveRate(STORE_ID);
      expect(result).toEqual({ rate: 0, source: 'hardcoded_fallback' });
    });
  });

  describe('setSellerOverride', () => {
    it('supersedes (never mutates) a previous active override', async () => {
      const previous = { rate: 0.03, isActive: true, save: jest.fn() };
      ruleModel.findOne.mockResolvedValueOnce(previous);

      await service.setSellerOverride(STORE_ID, 0.02, 'negotiated rate', ADMIN_ID);

      expect(previous.isActive).toBe(false);
      expect(previous.save).toHaveBeenCalled();
      expect(ruleModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'seller', storeId: STORE_ID, rate: 0.02, isActive: true, createdByAdminId: ADMIN_ID }),
      );
    });

    it('rejects a rate for a store that does not exist', async () => {
      storeModel.findById.mockResolvedValueOnce(null);
      await expect(service.setSellerOverride(STORE_ID, 0.02, undefined, ADMIN_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('removeSellerOverride', () => {
    it('throws when there is no active override to remove', async () => {
      ruleModel.findOne.mockResolvedValueOnce(null);
      await expect(service.removeSellerOverride(STORE_ID, ADMIN_ID)).rejects.toThrow(NotFoundException);
    });

    it('deactivates the active override', async () => {
      const active = { isActive: true, save: jest.fn() };
      ruleModel.findOne.mockResolvedValueOnce(active);

      await service.removeSellerOverride(STORE_ID, ADMIN_ID);

      expect(active.isActive).toBe(false);
      expect(active.save).toHaveBeenCalled();
    });
  });
});
