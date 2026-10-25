import { testCompanyId } from '../../test/postgres.setup.js';
import { CompanyService } from './company.service.js';
import type { Actor } from '../common/types/actor.type.js';
import type { DatabaseService } from '../database/database.service.js';
import type { AuditService } from '../audit/audit.service.js';

const actor: Actor = {
  companyId: testCompanyId,
  id: 'admin',
  name: 'Admin',
  email: 'admin@test.local',
  role: 'admin',
  employeeId: null,
};
const service = new CompanyService({} as DatabaseService, {} as AuditService);
afterEach(() => vi.unstubAllGlobals());
it('returns labelled coordinates from the address provider', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [31, 30] },
            properties: { name: 'Office', city: 'Cairo', country: 'Egypt' },
          },
        ],
      }),
    });
  vi.stubGlobal('fetch', fetchMock);
  expect(await service.searchLocations(actor, 'Office Cairo')).toEqual([
    { longitude: 31, latitude: 30, label: 'Office, Cairo, Egypt' },
  ]);
  expect(fetchMock.mock.calls[0][0].searchParams.get('q')).toBe('Office Cairo');
});
it('handles no matches and provider failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ features: [] }) }),
  );
  expect(await service.searchLocations(actor, 'Unknown address')).toEqual([]);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  await expect(service.searchLocations(actor, 'Office Cairo')).rejects.toThrow(
    'Address search is unavailable',
  );
});
it('rejects short queries and non-admin searches before contacting the provider', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(service.searchLocations(actor, 'ab')).rejects.toThrow(
    'Enter an address',
  );
  await expect(
    service.searchLocations({ ...actor, role: 'employee' }, 'Office Cairo'),
  ).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});
