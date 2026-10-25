import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegacySqliteStore as DatabaseService } from './legacy-sqlite.js';
import { DATABASE_SCHEMA } from './database.schema.js';

it('backfills the legacy department catalog without changing employee records', () => {
  vi.stubEnv('HR_DATABASE_PATH', ':memory:');
  const store = new DatabaseService();
  try {
    const data = JSON.stringify({
      department: 'Engineering',
      nationalId: '001234',
    });
    store.db
      .prepare('INSERT INTO employees VALUES(?,?,?,?)')
      .run('legacy-department', '001234', 'department@test.local', data);
    store.db.exec(DATABASE_SCHEMA);
    expect(store.db.prepare('SELECT name FROM departments').all()).toEqual([
      { name: 'Engineering' },
    ]);
    store.db.prepare('DELETE FROM departments WHERE name=?').run('Engineering');
    store.db.exec(DATABASE_SCHEMA);
    expect(store.db.prepare('SELECT name FROM departments').all()).toEqual([
      { name: 'Engineering' },
    ]);
    expect(
      store.db
        .prepare('SELECT data FROM employees WHERE id=?')
        .get('legacy-department')!.data,
    ).toBe(data);
  } finally {
    store.onModuleDestroy();
    vi.unstubAllEnvs();
  }
});

it('backfills legacy schedule history once and preserves versions and assignments across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hr-schedule-history-'));
  vi.stubEnv('HR_DATABASE_PATH', join(directory, 'test.sqlite'));
  let store: DatabaseService | undefined;
  try {
    store = new DatabaseService();
    const schedule = {
      id: 'old-shift',
      name: 'Original',
      start: '10:00',
      end: '18:00',
      days: [0],
      graceMinutes: 15,
    };
    store.db
      .prepare('INSERT INTO schedules VALUES (?, ?)')
      .run(schedule.id, JSON.stringify(schedule));
    store.db.prepare('INSERT INTO employees VALUES (?, ?, ?, ?)').run(
      'legacy-employee',
      '001234',
      'legacy@test.local',
      JSON.stringify({
        id: 'legacy-employee',
        startDate: '2026-09-01',
        scheduleId: schedule.id,
      }),
    );
    store.onModuleDestroy();
    store = new DatabaseService();
    expect(store.db.prepare('SELECT * FROM employee_schedules').all()).toEqual([
      {
        employee_id: 'legacy-employee',
        effective_from: '2026-09-01',
        schedule_id: schedule.id,
      },
    ]);
    expect(
      JSON.parse(
        store.db.prepare('SELECT data FROM schedule_versions').get()!
          .data as string,
      ),
    ).toEqual(schedule);
    const next = { ...schedule, start: '11:00' };
    store.db
      .prepare('INSERT INTO schedule_versions VALUES (?, ?, ?)')
      .run(schedule.id, '2026-10-15', JSON.stringify(next));
    store.db
      .prepare('UPDATE schedules SET data = ? WHERE id = ?')
      .run(JSON.stringify(next), schedule.id);
    store.db
      .prepare('INSERT INTO employee_schedules VALUES (?, ?, ?)')
      .run('legacy-employee', '2026-10-15', schedule.id);
    store.onModuleDestroy();
    store = new DatabaseService();
    expect(
      store.db.prepare('SELECT * FROM employee_schedules').all(),
    ).toHaveLength(2);
    const versions = store.db
      .prepare('SELECT data FROM schedule_versions ORDER BY effective_from')
      .all();
    expect(versions.map((row) => JSON.parse(row.data as string))).toEqual([
      schedule,
      next,
    ]);
  } finally {
    store?.onModuleDestroy();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('backfills employee numbers once and continues the sequence after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hr-employee-numbers-'));
  vi.stubEnv('HR_DATABASE_PATH', join(directory, 'test.sqlite'));
  let store: DatabaseService | undefined;
  try {
    store = new DatabaseService();
    store.db
      .prepare('INSERT INTO employees VALUES (?, ?, ?, ?)')
      .run(
        'legacy-id',
        '001234',
        'legacy@test.local',
        JSON.stringify({ id: 'legacy-id', nationalId: '001234' }),
      );
    store.onModuleDestroy();
    store = new DatabaseService();
    const read = () =>
      JSON.parse(
        store!.db
          .prepare('SELECT data FROM employees WHERE id = ?')
          .get('legacy-id')!.data as string,
      );
    expect(read()).toMatchObject({
      id: 'legacy-id',
      nationalId: '001234',
      employeeNumber: 'EMP-000001',
    });
    store.onModuleDestroy();
    store = new DatabaseService();
    expect(read().employeeNumber).toBe('EMP-000001');
    expect(store.transaction(() => store!.nextEmployeeNumber())).toBe(
      'EMP-000002',
    );
    expect(() =>
      store!.transaction(() => {
        store!.nextEmployeeNumber();
        throw new Error('Failed save');
      }),
    ).toThrow('Failed save');
    expect(store.transaction(() => store!.nextEmployeeNumber())).toBe(
      'EMP-000003',
    );
  } finally {
    store?.onModuleDestroy();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
