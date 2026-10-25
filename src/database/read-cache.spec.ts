import { testCompanyId } from '../../test/postgres.setup.js';
import { AuditService } from '../audit/audit.service.js';
import { CompanyService } from '../company/company.service.js';
import type { Actor } from '../common/types/actor.type.js';
import { DepartmentsService } from '../departments/departments.service.js';
import { SchedulesService } from '../schedules/schedules.service.js';
import { DatabaseService } from './database.service.js';
const admin: Actor = {
  companyId: testCompanyId,
  id: 'admin',
  name: 'Admin',
  email: 'admin@test.local',
  role: 'admin',
  employeeId: null,
};
let store: DatabaseService;
beforeEach(async () => {
  vi.stubEnv('HR_DATABASE_PATH', ':memory:');
  vi.stubEnv('HR_READ_CACHE', 'true');
  store = new DatabaseService();
  await store.db
    .prepare(
      'INSERT INTO users (id,email,name,role,employee_id,active,password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(admin.id, admin.email, admin.name, admin.role, null, 1, 'test-only');
});
afterEach(async () => {
  await store.onModuleDestroy();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('reuses reads without sharing mutable objects and expires after one minute', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const load = vi.fn(() => ({ days: [1] }));
  (await store.cachedRead('test', load)).days.push(2);
  const hit = await store.cachedRead('test', load);
  expect(hit.days).toEqual([1]);
  hit.days.push(3);
  expect((await store.cachedRead('test', load)).days).toEqual([1]);
  expect(load).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(60000);
  await store.cachedRead('test', load);
  expect(load).toHaveBeenCalledTimes(2);
});
it('bounds the cache and does not cache failed loads', async () => {
  const load = vi.fn(() => 1);
  for (let i = 0; i < 257; i++) await store.cachedRead(String(i), load);
  await store.cachedRead('0', load);
  expect(load).toHaveBeenCalledTimes(258);
  await expect(
    (async () =>
      await store.cachedRead('error', () => {
        throw new Error('failed');
      }))(),
  ).rejects.toThrow('failed');
  expect(await store.cachedRead('error', () => 2)).toBe(2);
});
it('sees transaction writes and never caches rolled-back values', async () => {
  await store.db
    .prepare('INSERT INTO departments (name) VALUES (?)')
    .run('Before');
  const load = async () =>
    await store.db.prepare('SELECT name FROM departments').all();
  expect(await store.cachedRead('departments', load)).toEqual([
    { name: 'Before' },
  ]);
  await expect(
    (async () =>
      await store.transaction(async () => {
        await store.db
          .prepare('UPDATE departments SET name = ?')
          .run('Uncommitted');
        expect(await store.cachedRead('departments', load)).toEqual([
          { name: 'Uncommitted' },
        ]);
        expect(await store.cachedRead('new-key', load)).toEqual([
          { name: 'Uncommitted' },
        ]);
        throw new Error('rollback');
      }))(),
  ).rejects.toThrow('rollback');
  expect(await store.cachedRead('departments', load)).toEqual([
    { name: 'Before' },
  ]);
  expect(await store.cachedRead('new-key', load)).toEqual([{ name: 'Before' }]);
  await store.transaction(
    async () =>
      await store.db
        .prepare('UPDATE departments SET name = ?')
        .run('Committed'),
  );
  expect(await store.cachedRead('departments', load)).toEqual([
    { name: 'Committed' },
  ]);
});
it('detects writes outside the transaction helper and checks permissions on cache hits', async () => {
  const departments = new DepartmentsService(store, new AuditService(store));
  expect(await departments.list(admin)).toEqual([]);
  await store.db
    .prepare('INSERT INTO departments (name) VALUES (?)')
    .run('New department');
  expect(await departments.list(admin)).toEqual([{ name: 'New department' }]);
  await expect(
    (async () => await departments.list({ ...admin, role: 'employee' }))(),
  ).rejects.toThrow();
  await departments.create(admin, { name: 'Sales' });
  expect(await departments.list(admin)).toHaveLength(2);
});
it('refreshes company settings and date-specific schedules immediately after updates', async () => {
  await store.db
    .prepare('INSERT INTO settings (key,value) VALUES (?, ?)')
    .run('company', JSON.stringify({ name: 'Before', timezone: 'UTC' }));
  const audit = new AuditService(store);
  const company = new CompanyService(store, audit);
  const schedules = new SchedulesService(store, audit, company);
  expect((await company.settings()).name).toBe('Before');
  await company.updateSettings(admin, {
    name: 'After',
    timezone: 'Africa/Cairo',
  });
  expect(await company.settings()).toEqual({
    name: 'After',
    timezone: 'Africa/Cairo',
    latitude: 30.023092,
    longitude: 31.528179,
    radiusMeters: 50,
    trackingRadiusMeters: 150,
    trackingGraceMinutes: 5,
  });
  await company.updateSettings(admin, {
    name: 'After',
    timezone: 'Africa/Cairo',
    latitude: 31,
    longitude: 30,
    radiusMeters: 200,
  });
  expect(await company.settings()).toMatchObject({
    latitude: 31,
    longitude: 30,
    radiusMeters: 200,
  });
  const input = {
    name: 'Early',
    start: '09:00',
    end: '17:00',
    days: [0, 1],
    graceMinutes: 15,
  };
  const schedule = await schedules.saveSchedule(admin, input);
  expect((await schedules.schedule(schedule.id, '2000-01-01')).name).toBe(
    'Early',
  );
  const today = await schedules.today();
  expect((await schedules.schedule(schedule.id, today)).name).toBe('Early');
  await schedules.saveSchedule(
    admin,
    { ...input, name: 'Late', start: '10:00' },
    schedule.id,
  );
  expect((await schedules.schedules())[0].name).toBe('Late');
  expect((await schedules.schedule(schedule.id, today)).name).toBe('Late');
  expect((await schedules.schedule(schedule.id, '2000-01-01')).name).toBe(
    'Early',
  );
});
it('detects committed updates from a second PostgreSQL connection', async () => {
  await store.onModuleDestroy();
  store = new DatabaseService();
  const other = new DatabaseService();
  try {
    const load = async () =>
      await store.db.prepare('SELECT name FROM departments').all();
    expect(await store.cachedRead('departments', load)).toEqual([]);
    await other
      .prepare('INSERT INTO departments(name) VALUES (?)')
      .run('External');
    expect(await store.cachedRead('departments', load)).toEqual([
      { name: 'External' },
    ]);
  } finally {
    await other.onModuleDestroy();
    await store.onModuleDestroy();
    vi.stubEnv('HR_DATABASE_PATH', ':memory:');
    store = new DatabaseService();
  }
});
it('supports disabling the cache', async () => {
  await store.onModuleDestroy();
  vi.stubEnv('HR_READ_CACHE', 'false');
  store = new DatabaseService();
  const load = vi.fn(() => 1);
  await store.cachedRead('test', load);
  await store.cachedRead('test', load);
  expect(load).toHaveBeenCalledTimes(2);
});
