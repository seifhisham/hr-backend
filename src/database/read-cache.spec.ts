import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AuditService } from '../audit/audit.service.js';
import { CompanyService } from '../company/company.service.js';
import type { Actor } from '../common/types/actor.type.js';
import { DepartmentsService } from '../departments/departments.service.js';
import { SchedulesService } from '../schedules/schedules.service.js';
import { DatabaseService } from './database.service.js';

const admin: Actor = {
  id: 'admin',
  name: 'Admin',
  email: 'admin@test.local',
  role: 'admin',
  employeeId: null,
};
let store: DatabaseService;

beforeEach(() => {
  vi.stubEnv('HR_DATABASE_PATH', ':memory:');
  vi.stubEnv('HR_READ_CACHE', 'true');
  store = new DatabaseService();
  store.db
    .prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(admin.id, admin.email, admin.name, admin.role, null, 1, 'test-only');
});

afterEach(() => {
  store.onModuleDestroy();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('reuses reads without sharing mutable objects and expires after one minute', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const load = vi.fn(() => ({ days: [1] }));
  store.cachedRead('test', load).days.push(2);
  const hit = store.cachedRead('test', load);
  expect(hit.days).toEqual([1]);
  hit.days.push(3);
  expect(store.cachedRead('test', load).days).toEqual([1]);
  expect(load).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(60_000);
  store.cachedRead('test', load);
  expect(load).toHaveBeenCalledTimes(2);
});

it('bounds the cache and does not cache failed loads', () => {
  const load = vi.fn(() => 1);
  for (let i = 0; i < 257; i++) store.cachedRead(String(i), load);
  store.cachedRead('0', load);
  expect(load).toHaveBeenCalledTimes(258);
  expect(() =>
    store.cachedRead('error', () => {
      throw new Error('failed');
    }),
  ).toThrow('failed');
  expect(store.cachedRead('error', () => 2)).toBe(2);
});

it('sees transaction writes and never caches rolled-back values', () => {
  store.db.prepare('INSERT INTO departments VALUES (?)').run('Before');
  const load = () => store.db.prepare('SELECT name FROM departments').all();
  expect(store.cachedRead('departments', load)).toEqual([{ name: 'Before' }]);
  expect(() =>
    store.transaction(() => {
      store.db.prepare('UPDATE departments SET name = ?').run('Uncommitted');
      expect(store.cachedRead('departments', load)).toEqual([
        { name: 'Uncommitted' },
      ]);
      expect(store.cachedRead('new-key', load)).toEqual([
        { name: 'Uncommitted' },
      ]);
      throw new Error('rollback');
    }),
  ).toThrow('rollback');
  expect(store.cachedRead('departments', load)).toEqual([{ name: 'Before' }]);
  expect(store.cachedRead('new-key', load)).toEqual([{ name: 'Before' }]);
  store.transaction(() =>
    store.db.prepare('UPDATE departments SET name = ?').run('Committed'),
  );
  expect(store.cachedRead('departments', load)).toEqual([
    { name: 'Committed' },
  ]);
});

it('detects writes outside the transaction helper and checks permissions on cache hits', () => {
  const departments = new DepartmentsService(store, new AuditService(store));
  expect(departments.list(admin)).toEqual([]);
  store.db.prepare('INSERT INTO departments VALUES (?)').run('New department');
  expect(departments.list(admin)).toEqual([{ name: 'New department' }]);
  expect(() => departments.list({ ...admin, role: 'employee' })).toThrow();
  departments.create(admin, { name: 'Sales' });
  expect(departments.list(admin)).toHaveLength(2);
});

it('refreshes company settings and date-specific schedules immediately after updates', () => {
  store.db
    .prepare('INSERT INTO settings VALUES (?, ?)')
    .run('company', JSON.stringify({ name: 'Before', timezone: 'UTC' }));
  const audit = new AuditService(store);
  const company = new CompanyService(store, audit);
  const schedules = new SchedulesService(store, audit, company);
  expect(company.settings().name).toBe('Before');
  company.updateSettings(admin, { name: 'After', timezone: 'Africa/Cairo' });
  expect(company.settings()).toEqual({
    name: 'After',
    timezone: 'Africa/Cairo',
    latitude: 30.023092,
    longitude: 31.528179,
    radiusMeters: 50,
    trackingRadiusMeters: 150,
    trackingGraceMinutes: 5,
  });
  company.updateSettings(admin, { name: 'After', timezone: 'Africa/Cairo', latitude: 31, longitude: 30, radiusMeters: 200 });
  expect(company.settings()).toMatchObject({ latitude: 31, longitude: 30, radiusMeters: 200 });
  const input = {
    name: 'Early',
    start: '09:00',
    end: '17:00',
    days: [0, 1],
    graceMinutes: 15,
  };
  const schedule = schedules.saveSchedule(admin, input);
  expect(schedules.schedule(schedule.id, '2000-01-01').name).toBe('Early');
  const today = schedules.today();
  expect(schedules.schedule(schedule.id, today).name).toBe('Early');
  schedules.saveSchedule(
    admin,
    { ...input, name: 'Late', start: '10:00' },
    schedule.id,
  );
  expect(schedules.schedules()[0].name).toBe('Late');
  expect(schedules.schedule(schedule.id, today).name).toBe('Late');
  expect(schedules.schedule(schedule.id, '2000-01-01').name).toBe('Early');
});

it('detects committed updates from a second SQLite connection', () => {
  store.onModuleDestroy();
  const directory = mkdtempSync(join(tmpdir(), 'hr-cache-'));
  const path = join(directory, 'test.sqlite');
  vi.stubEnv('HR_DATABASE_PATH', path);
  store = new DatabaseService();
  const other = new DatabaseSync(path);
  try {
    const load = () => store.db.prepare('SELECT name FROM departments').all();
    expect(store.cachedRead('departments', load)).toEqual([]);
    other.prepare('INSERT INTO departments VALUES (?)').run('External');
    expect(store.cachedRead('departments', load)).toEqual([
      { name: 'External' },
    ]);
  } finally {
    other.close();
    store.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
    vi.stubEnv('HR_DATABASE_PATH', ':memory:');
    store = new DatabaseService();
  }
});

it('supports disabling the cache', () => {
  store.onModuleDestroy();
  vi.stubEnv('HR_READ_CACHE', 'false');
  store = new DatabaseService();
  const load = vi.fn(() => 1);
  store.cachedRead('test', load);
  store.cachedRead('test', load);
  expect(load).toHaveBeenCalledTimes(2);
});
