/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- mock-heavy tests */
/** App backend gap #12: the documented `state` values of GET /api/platform-config/maintenance (client contract). */
import { AdminConfigService } from './admin-config.service';
import { MAINTENANCE_STATES, maintenanceState, normalizeMaintenance } from './maintenance.util';

function svcWith(maintenance: any) {
  const svc: any = Object.create(AdminConfigService.prototype);
  svc.getMaintenance = jest.fn().mockResolvedValue(normalizeMaintenance(maintenance));
  return svc as AdminConfigService;
}
const HOUR = 3600_000;

describe('maintenance state contract', () => {
  it('has exactly off / scheduled / active (no "on")', () => {
    expect([...MAINTENANCE_STATES]).toEqual(['off', 'scheduled', 'active']);
  });

  it('maps settings to a state', () => {
    const now = new Date('2026-11-23T10:00:00Z');
    expect(maintenanceState(normalizeMaintenance({ enabled: false }), now)).toBe('off');
    expect(maintenanceState(normalizeMaintenance({ enabled: true, startsAt: new Date(now.getTime() + HOUR) }), now)).toBe('scheduled');
    expect(maintenanceState(normalizeMaintenance({ enabled: true, startsAt: new Date(now.getTime() - HOUR) }), now)).toBe('active');
    expect(maintenanceState(normalizeMaintenance({ enabled: true }), now)).toBe('active');
    // endsAt is only an estimate: a past endsAt does not switch maintenance off.
    expect(maintenanceState(normalizeMaintenance({ enabled: true, endsAt: new Date(now.getTime() - HOUR) }), now)).toBe('active');
  });

  it("'off' answers { state: 'off' } and nothing else", async () => {
    const res: any = await svcWith({ enabled: false, title: 'x' }).getPublicMaintenance();
    expect(res).toEqual({ success: true, data: { state: 'off' } });
  });

  it("'scheduled' and 'active' carry the same documented fields", async () => {
    const keys = ['state', 'scopes', 'type', 'title', 'message', 'scopeMessages', 'startsAt', 'endsAt', 'statusNote', 'updatedAt'].sort();
    const sched: any = await svcWith({ enabled: true, scopes: ['checkout'], title: 'Upgrade', startsAt: new Date(Date.now() + HOUR) }).getPublicMaintenance();
    const active: any = await svcWith({ enabled: true, scopes: ['feature:search'], title: 'Search down' }).getPublicMaintenance();
    expect(sched.data.state).toBe('scheduled');
    expect(active.data.state).toBe('active');
    expect(Object.keys(sched.data).sort()).toEqual(keys);
    expect(Object.keys(active.data).sort()).toEqual(keys);
    expect(active.data.scopes).toEqual(['feature:search']);
  });
});
