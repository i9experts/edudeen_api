/* eslint-disable prettier/prettier */
import { ActivityLogService } from './activity-log.service';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogGateway } from './activity-log.gateway';

describe('ActivityLogService — admin (platform-wide) surface', () => {
  let service: ActivityLogService;
  let activityLogModel: any;

  beforeEach(() => {
    activityLogModel = {
      countDocuments: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) }) }),
    };
    const db = { repositories: { activityLogModel } } as unknown as DatabaseService;
    const gateway = {} as unknown as ActivityLogGateway;
    service = new ActivityLogService(db, gateway);
  });

  describe('adminFindAll', () => {
    it('queries across every store when no storeId filter is given', async () => {
      await service.adminFindAll({});
      expect(activityLogModel.countDocuments).toHaveBeenCalledWith({});
    });

    it('scopes down to one store only when storeId is explicitly passed', async () => {
      await service.adminFindAll({ storeId: 'store-1' });
      expect(activityLogModel.countDocuments).toHaveBeenCalledWith(expect.objectContaining({ storeId: 'store-1' }));
    });

    it('filters by category, actorRole, and security-alert flag together', async () => {
      await service.adminFindAll({ category: 'finance', actorRole: 'admin', isSecurityAlert: 'true' });
      expect(activityLogModel.countDocuments).toHaveBeenCalledWith({
        // Platform-wide security alerts never include plain successful logins.
        category: 'finance', actorRole: 'admin', isSecurityAlert: true, action: { $ne: 'login_success' },
      });
    });

    it('applies a sensible default page size without requiring one', async () => {
      const result = await service.adminFindAll({});
      expect(result.data.pagination.limit).toBe(50);
    });
  });

  describe('adminExportCsv', () => {
    it('produces a CSV with a header row and one row per log entry', async () => {
      activityLogModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue([
              { createdAt: new Date('2026-01-01'), storeId: 'store-1', category: 'finance', action: 'payout_approved', actorName: 'Admin One', actorRole: 'admin', description: 'ok', isSecurityAlert: false, ip: '1.2.3.4' },
            ]),
          }),
        }),
      });

      const csv = await service.adminExportCsv({});
      const lines = csv.split('\n');
      expect(lines[0]).toContain('Security Alert');
      expect(lines[1]).toContain('payout_approved');
    });
  });
});
