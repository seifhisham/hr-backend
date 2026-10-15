import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { CompanyService } from '../company/company.service.js';
import { DatabaseService } from '../database/database.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { SchedulesService } from '../schedules/schedules.service.js';
import { AttendanceEvidence } from './attendance-evidence.service.js';
import { AttendanceLocationService } from './attendance-location.service.js';
import { AttendanceService } from './attendance.service.js';
import type { Actor } from '../common/types/actor.type.js';

it('yields to other work without mixing employee snapshots and keeps report queries bounded', async () => {
  vi.stubEnv('HR_DATABASE_PATH', ':memory:');
  const store = new DatabaseService();
  const actor: Actor = {
    id: 'test-admin',
    name: 'Admin',
    email: 'test@test.local',
    role: 'admin',
    employeeId: null,
  };
  const audit = new AuditService(store),
    company = new CompanyService(store, audit);
  const schedules = new SchedulesService(store, audit, company);
  const employees = new EmployeesService(store, schedules, audit);
  const location = new AttendanceLocationService(company, store, employees, audit);
  const attendance = new AttendanceService(
    store,
    new AttendanceEvidence(company, store),
    employees,
    schedules,
    company,
    audit,
    location,
  );
  const schedule = {
    id: randomUUID(),
    name: 'Day',
    start: '09:00',
    end: '17:00',
    days: [0, 1, 2, 3, 4],
    graceMinutes: 15,
  };
  const employee = {
    id: randomUUID(),
    name: 'Original',
    department: 'Test',
    nationalId: 'TEST',
    startDate: '2026-01-01',
    active: true,
    scheduleId: schedule.id,
  };
  let otherWork: Promise<void> | undefined;
  try {
    store.db
      .prepare('INSERT INTO settings VALUES (?, ?)')
      .run('company', JSON.stringify({ name: 'Test', timezone: 'UTC' }));
    store.db
      .prepare('INSERT INTO schedules VALUES (?, ?)')
      .run(schedule.id, JSON.stringify(schedule));
    store.db
      .prepare('INSERT INTO employees VALUES (?, ?, ?, ?)')
      .run(
        employee.id,
        employee.nationalId,
        'employee@test.local',
        JSON.stringify(employee),
      );
    store.db
      .prepare('INSERT INTO employee_schedules VALUES (?, ?, ?)')
      .run(employee.id, '2026-01-01', schedule.id);
    let completed = false;
    otherWork = new Promise((done) =>
      setImmediate(() => {
        store.transaction(() =>
          store.db
            .prepare('UPDATE employees SET data = ? WHERE id = ?')
            .run(JSON.stringify({ ...employee, name: 'Updated' }), employee.id),
        );
        completed = true;
        done();
      }),
    );
    const rows = await attendance.report(actor, {
      from: '2026-09-01',
      to: '2026-09-02',
    });
    expect(completed).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.name === 'Original')).toBe(true);
    await otherWork;
    const prepared = vi.spyOn(store.db, 'prepare');
    const fresh = await attendance.report(actor, {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(fresh).toHaveLength(22);
    expect(fresh.every((row) => row.name === 'Updated')).toBe(true);
    expect(prepared.mock.calls.length).toBeLessThan(25);
    vi.spyOn(location, 'sweep').mockImplementationOnce(() => {
      throw new Error('Temporary report failure');
    });
    await expect(
      attendance.report(actor, { from: '2026-09-01', to: '2026-09-02' }),
    ).rejects.toThrow('Temporary report failure');
    expect(
      await attendance.report(actor, { from: '2026-09-01', to: '2026-09-02' }),
    ).toHaveLength(2);
  } finally {
    await otherWork;
    vi.restoreAllMocks();
    store.onModuleDestroy();
    vi.unstubAllEnvs();
  }
});
