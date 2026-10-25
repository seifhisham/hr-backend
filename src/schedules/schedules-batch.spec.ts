import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CompanyService } from '../company/company.service.js';
import { SchedulesService } from './schedules.service.js';
it('bulk assignment reads preserve historical versions, future changes and earliest-assignment fallback', async () => {
  vi.stubEnv('HR_DATABASE_PATH', ':memory:');
  const store = new DatabaseService();
  try {
    const audit = new AuditService(store);
    const schedules = new SchedulesService(
      store,
      audit,
      new CompanyService(store, audit),
    );
    const first = {
      id: randomUUID(),
      name: 'Current',
      start: '09:00',
      end: '17:00',
      days: [0, 1],
      graceMinutes: 15,
    };
    const second = {
      ...first,
      id: randomUUID(),
      name: 'Night',
      start: '22:00',
      end: '06:00',
    };
    for (const schedule of [first, second])
      await store.db
        .prepare('INSERT INTO schedules (id,data) VALUES (?, ?)')
        .run(schedule.id, JSON.stringify(schedule));
    await store.db
      .prepare(
        'INSERT INTO schedule_versions (schedule_id,effective_from,data) VALUES (?, ?, ?)',
      )
      .run(
        first.id,
        '2026-01-01',
        JSON.stringify({ ...first, name: 'Historical', start: '08:00' }),
      );
    await store.db
      .prepare(
        'INSERT INTO schedule_versions (schedule_id,effective_from,data) VALUES (?, ?, ?)',
      )
      .run(first.id, '2026-06-01', JSON.stringify(first));
    const employeeId = randomUUID();
    await store.db
      .prepare('INSERT INTO employees (id,code,email,data) VALUES (?, ?, ?, ?)')
      .run(
        employeeId,
        'TEST',
        'test@test.local',
        JSON.stringify({
          id: employeeId,
          employeeNumber: 'EMP-000001',
          startDate: '2026-01-01',
        }),
      );
    await store.db
      .prepare(
        'INSERT INTO employee_schedules (employee_id,effective_from,schedule_id) VALUES (?, ?, ?)',
      )
      .run(employeeId, '2026-02-01', first.id);
    await store.db
      .prepare(
        'INSERT INTO employee_schedules (employee_id,effective_from,schedule_id) VALUES (?, ?, ?)',
      )
      .run(employeeId, '2026-11-01', second.id);
    const reader = await schedules.assignmentReader([employeeId]);
    for (const date of [
      '2025-12-01',
      '2026-01-15',
      '2026-02-01',
      '2026-05-31',
      '2026-06-01',
      '2026-10-31',
      '2026-11-01',
    ])
      expect(reader(employeeId, date)).toEqual(
        await schedules.assignedSchedule(employeeId, date),
      );
    expect(() => reader(randomUUID(), '2026-01-01')).toThrow(
      'Employee has no schedule assignment',
    );
    await store.transaction(
      async () =>
        await store.db
          .prepare(
            'UPDATE employee_schedules SET schedule_id = ? WHERE employee_id = ? AND effective_from = ?',
          )
          .run(second.id, employeeId, '2026-02-01'),
    );
    expect(
      (await schedules.assignmentReader([employeeId]))(
        employeeId,
        '2026-03-01',
      ),
    ).toEqual(second);
  } finally {
    await store.onModuleDestroy();
    vi.unstubAllEnvs();
  }
});
