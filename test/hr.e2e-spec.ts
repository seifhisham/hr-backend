import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AttendanceEvidence } from '../src/attendance/attendance-evidence.service.js';
import { AttendanceService } from '../src/attendance/attendance.service.js';
import { AttendanceLocationService } from '../src/attendance/attendance-location.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { DATABASE_SCHEMA } from '../src/database/database.schema.js';
import type { Employee } from '../src/employees/types/employee.type.js';
import { EmployeesService } from '../src/employees/employees.service.js';
import { SchedulesService } from '../src/schedules/schedules.service.js';
import { RequestsService } from '../src/requests/requests.service.js';
import { PayrollService } from '../src/payroll/payroll.service.js';
import type { Schedule } from '../src/schedules/types/schedule.type.js';

describe('HR REST API', () => {
  let app: INestApplication;
  let adminToken: string;
  let schedule: Schedule;
  let employee: Employee;
  let employeeToken: string;
  let photo: Buffer;
  const adminPassword = 'Test-admin-password-2026';
  const employeePassword = 'Test-employee-password-2026';
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const submit = (
    path: string,
    token: string,
    changes: Record<string, string> = {},
    image?: Buffer,
  ) => {
    const form = {
      latitude: '30.023092',
      longitude: '31.528179',
      accuracyMeters: '10',
      capturedAt: new Date().toISOString(),
      ...changes,
    };
    const test = request(server()).post(path).set(auth(token));
    for (const [key, value] of Object.entries(form)) test.field(key, value);
    return test.attach('photo', image ?? photo, {
      filename: 'office.png',
      contentType: 'image/png',
    });
  };
  const fields = () => {
    const { id: _id, employeeNumber: _employeeNumber, ...values } = employee;
    return values;
  };

  const locationUpdate = (
    id: string,
    changes: Record<string, unknown> = {},
    token = employeeToken,
  ) =>
    request(server())
      .post(`/api/attendance/${id}/location`)
      .set(auth(token))
      .send({
        available: true,
        latitude: 30.026,
        longitude: 31.528179,
        accuracyMeters: 10,
        capturedAt: new Date().toISOString(),
        ...changes,
      });

  it('confirms departure, persists a five-minute deadline, and checks out once with an audit', async () => {
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
    ).body;
    const policy = (
      await request(server())
        .get('/api/attendance/policy')
        .set(auth(employeeToken))
        .expect(200)
    ).body;
    expect(policy.tracking.radiusMeters).toBe(150);
    expect(policy.radiusMeters).toBe(50);
    expect(
      (await locationUpdate(record.id).expect(201)).body.returnBy,
    ).toBeNull();
    vi.setSystemTime(new Date('2026-10-04T07:00:30Z'));
    const started = (await locationUpdate(record.id).expect(201)).body;
    expect(started.returnBy).toBe('2026-10-04T07:05:30.000Z');
    // A new provider instance uses the same persisted deadline, not an in-memory timer.
    const processor = new AttendanceLocationService(
      app.get(DatabaseService),
      app.get(EmployeesService),
      app.get(AuditService),
    );
    for (let seconds = 60; seconds <= 330; seconds += 30) {
      vi.setSystemTime(
        new Date(Date.parse('2026-10-04T07:00:00Z') + seconds * 1000),
      );
      await locationUpdate(record.id).expect(201);
    }
    processor.sweep();
    processor.sweep();
    const mine = (
      await request(server())
        .get('/api/attendance/me')
        .set(auth(employeeToken))
        .expect(200)
    ).body.records[0];
    expect(mine.checkOut).toBe(started.returnBy);
    expect(mine.location.status).toBe('auto-checked-out');
    expect(mine.location.actor).toBeUndefined();
    expect(
      app
        .get(DatabaseService)
        .db.prepare(
          "SELECT COUNT(*) AS total FROM audit WHERE action = 'attendance.auto_checked_out'",
        )
        .get()?.total,
    ).toBe(1);
    await locationUpdate(record.id).expect(409);
    expect(
      app
        .get(DatabaseService)
        .db.prepare('SELECT COUNT(*) AS total FROM payroll_deductions')
        .get()?.total,
    ).toBe(0);
  });

  it('cancels departure on return and never checks out for unavailable, uncertain or missing location', async () => {
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
    ).body;
    const processor = app.get(AttendanceLocationService);
    await locationUpdate(record.id).expect(201);
    vi.setSystemTime(new Date('2026-10-04T07:00:30Z'));
    await locationUpdate(record.id).expect(201);
    vi.setSystemTime(new Date('2026-10-04T07:01:00Z'));
    expect(
      (await locationUpdate(record.id, { latitude: 30.023092 }).expect(201))
        .body,
    ).toMatchObject({ status: 'inside', returnBy: null });
    vi.setSystemTime(new Date('2026-10-04T07:01:30Z'));
    await locationUpdate(record.id).expect(201);
    vi.setSystemTime(new Date('2026-10-04T07:02:00Z'));
    await locationUpdate(record.id).expect(201);
    await request(server())
      .post(`/api/attendance/${record.id}/location`)
      .set(auth(employeeToken))
      .send({ available: false })
      .expect(201);
    expect(processor.view(record.id)).toMatchObject({
      status: 'unavailable',
      returnBy: null,
    });
    vi.setSystemTime(new Date('2026-10-04T07:02:30Z'));
    expect(
      (await locationUpdate(record.id, { accuracyMeters: 100 }).expect(201))
        .body.status,
    ).toBe('unavailable');
    vi.setSystemTime(new Date('2026-10-04T07:03:00Z'));
    expect(
      (
        await locationUpdate(record.id, {
          latitude: 30.02444,
          accuracyMeters: 30,
        }).expect(201)
      ).body.status,
    ).toBe('unavailable');
    vi.setSystemTime(new Date('2026-10-04T07:03:30Z'));
    await locationUpdate(record.id).expect(201);
    vi.setSystemTime(new Date('2026-10-04T07:04:00Z'));
    await locationUpdate(record.id).expect(201);
    vi.setSystemTime(new Date('2026-10-04T07:10:00Z'));
    processor.sweep();
    expect(processor.view(record.id)).toMatchObject({
      status: 'unavailable',
      returnBy: null,
    });
    expect(
      app
        .get(DatabaseService)
        .db.prepare('SELECT check_out FROM attendance WHERE id = ?')
        .get(record.id)?.check_out,
    ).toBeNull();
    const report = (
      await request(server())
        .get('/api/attendance?from=2026-10-04&to=2026-10-04')
        .set(auth(adminToken))
        .expect(200)
    ).body;
    expect(report[0].location.status).toBe('unavailable');
    expect(
      app
        .get(DatabaseService)
        .db.prepare('SELECT COUNT(*) AS total FROM payroll_deductions')
        .get()?.total,
    ).toBe(0);
    const resumed = (await locationUpdate(record.id).expect(201)).body;
    expect(resumed.returnBy).toBeNull();
  });

  it('rolls back automatic checkout if the audit fails and clears monitoring on HR correction', async () => {
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
    ).body;
    await locationUpdate(record.id).expect(201);
    vi.setSystemTime(new Date('2026-10-04T07:00:30Z'));
    await locationUpdate(record.id).expect(201);
    for (let seconds = 60; seconds <= 330; seconds += 30) {
      vi.setSystemTime(
        new Date(Date.parse('2026-10-04T07:00:00Z') + seconds * 1000),
      );
      await locationUpdate(record.id).expect(201);
    }
    const audit = vi
      .spyOn(app.get(AuditService), 'record')
      .mockImplementation(() => {
        throw new Error('Audit unavailable');
      });
    const processor = app.get(AttendanceLocationService);
    expect(() => processor.sweep()).toThrow('Audit unavailable');
    expect(
      app
        .get(DatabaseService)
        .db.prepare('SELECT check_out FROM attendance WHERE id = ?')
        .get(record.id)?.check_out,
    ).toBeNull();
    expect(processor.view(record.id)?.status).toBe('outside');
    audit.mockRestore();
    processor.sweep();
    await request(server())
      .patch(`/api/attendance/${record.id}`)
      .set(auth(adminToken))
      .send({
        checkIn: record.checkIn,
        checkOut: null,
        reason: 'Reopened after reviewing location evidence',
      })
      .expect(200);
    expect(processor.view(record.id)).toBeNull();
    processor.sweep();
    expect(
      app
        .get(DatabaseService)
        .db.prepare('SELECT check_out FROM attendance WHERE id = ?')
        .get(record.id)?.check_out,
    ).toBeNull();
  });

  it('protects location ownership and rejects forged, stale and out-of-order payloads', async () => {
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
    ).body;
    await request(server())
      .post(`/api/attendance/${record.id}/location`)
      .send({ available: false })
      .expect(401);
    await locationUpdate(randomUUID()).expect(404);
    const other = (
      await request(server())
        .post('/api/employees')
        .set(auth(adminToken))
        .send({
          ...fields(),
          nationalId: 'LOCATION-OTHER',
          email: 'location-other@test.local',
          password: employeePassword,
        })
        .expect(201)
    ).body;
    const token = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: other.email, password: employeePassword })
        .expect(201)
    ).body.token;
    await locationUpdate(record.id, {}, token).expect(404);
    await locationUpdate(record.id, { employeeId: employee.id }).expect(400);
    await locationUpdate(record.id, { latitude: 91 }).expect(400);
    await locationUpdate(record.id, {
      capturedAt: '2026-10-04T06:58:00Z',
    }).expect(409);
    await locationUpdate(record.id, {
      capturedAt: '2026-10-04T07:01:00Z',
    }).expect(409);
    await locationUpdate(record.id).expect(201);
    await locationUpdate(record.id).expect(409);
    vi.setSystemTime(new Date('2026-10-04T07:00:30Z'));
    await locationUpdate(record.id).expect(201);
    const deadline = app
      .get(AttendanceLocationService)
      .view(record.id)?.returnBy;
    await submit(
      `/api/attendance/${record.id}/check-out`,
      employeeToken,
    ).expect(201);
    vi.setSystemTime(new Date(deadline!));
    app.get(AttendanceLocationService).sweep();
    expect(app.get(AttendanceLocationService).view(record.id)).toBeNull();
  });

  const salaryForApproval = async (salary = 3000) => {
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), monthlySalary: salary })
      .expect(200);
  };
  const payrollRun = async (month = '2026-10') =>
    (
      await request(server())
        .get(`/api/payroll/run?month=${month}`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
  const approvePayroll = (
    run: { month: string; revision: string },
    token = adminToken,
  ) =>
    request(server()).post('/api/payroll/approve').set(auth(token)).send({
      month: run.month,
      expectedRevision: run.revision,
      reason: 'Reviewed salaries and deductions',
    });

  it('freezes approved payroll salaries, employee details and deduction breakdowns', async () => {
    await salaryForApproval();
    const vacation = await workflowRequest();
    await hrDecision(vacation.id).expect(200);
    const deduction = await request(server())
      .post('/api/payroll/deductions')
      .set(auth(adminToken))
      .send({
        employeeId: employee.id,
        month: '2026-10',
        days: 2,
        reason: 'Confirmed attendance adjustment',
        approvedBy: 'HR Supervisor',
      })
      .expect(201);
    const draft = await payrollRun();
    expect(draft.status).toBe('draft');
    expect(draft.rows[0]).toMatchObject({
      grossSalary: 3000,
      deductionDays: 3,
      netSalary: 2700,
    });
    const approved = await approvePayroll(draft).expect(201);
    expect(approved.body).toMatchObject({
      status: 'approved',
      approvedBy: 'Company Administrator',
      approvalReason: 'Reviewed salaries and deductions',
      revision: draft.revision,
    });
    expect(approved.body.rows[0].manualDeductions).toEqual([deduction.body]);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({
        ...fields(),
        name: 'Changed employee name',
        department: 'Operations',
        monthlySalary: 6000,
        salaryCurrency: 'USD',
        active: false,
      })
      .expect(200);
    await request(server())
      .patch('/api/settings')
      .set(auth(adminToken))
      .send({ name: 'Changed Company', timezone: 'UTC' })
      .expect(200);
    expect(await payrollRun()).toEqual(approved.body);
    const legacy = await request(server())
      .get('/api/payroll?month=2026-10')
      .set(auth(adminToken))
      .expect(200);
    expect(legacy.body).toEqual(approved.body.rows);
    const nextMonth = await payrollRun('2026-11');
    expect(nextMonth.status).toBe('draft');
    expect(nextMonth.rows[0]).toMatchObject({
      name: 'Changed employee name',
      department: 'Operations',
      grossSalary: 6000,
      currency: 'USD',
      deductionDays: 0,
      active: false,
    });
    await approvePayroll(draft).expect(409);
    const audit = await request(server())
      .get('/api/audit?recordId=2026-10')
      .set(auth(adminToken))
      .expect(200);
    expect(
      audit.body.filter(
        (item: { action: string }) => item.action === 'payroll.approved',
      ),
    ).toHaveLength(1);
    expect(audit.body[0].after.rows).toEqual(approved.body.rows);
  });

  it('blocks changes to locked payroll while permitting non-financial attendance corrections', async () => {
    await salaryForApproval();
    const vacation = await workflowRequest();
    await hrDecision(vacation.id).expect(200);
    await approvePayroll(await payrollRun()).expect(201);
    await request(server())
      .post('/api/payroll/deductions')
      .set(auth(adminToken))
      .send({
        employeeId: employee.id,
        month: '2026-10',
        days: 1,
        reason: 'Cannot deduct locked payroll',
        approvedBy: 'HR Supervisor',
      })
      .expect(409);
    await request(server())
      .patch(`/api/requests/${vacation.id}/reopen`)
      .set(auth(adminToken))
      .send({ reason: 'Cannot reopen locked deduction' })
      .expect(409);
    const next = await workflowRequest(employeeToken, '2026-10-06');
    await hrDecision(next.id).expect(409);
    await hrDecision(next.id, 'rejected').expect(409);
    await request(server())
      .post('/api/payroll/deductions')
      .set(auth(adminToken))
      .send({
        employeeId: employee.id,
        month: '2026-11',
        days: 1,
        reason: 'Adjustment for next payroll',
        approvedBy: 'HR Supervisor',
      })
      .expect(201);
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
    ).body;
    vi.setSystemTime(new Date('2026-10-04T16:00:00Z'));
    const forgotten = (
      await request(server())
        .post('/api/requests')
        .set(auth(employeeToken))
        .send({
          type: 'forgotten-check-out',
          attendanceId: record.id,
          proposedCheckOut: '2026-10-04T15:00:00Z',
          reason: 'Departure confirmed after payroll lock',
        })
        .expect(201)
    ).body;
    await hrDecision(forgotten.id).expect(200);
    expect((await payrollRun()).rows[0].deductionDays).toBe(1);
  });

  it('rejects stale payroll approval and approves only the newly reviewed values', async () => {
    await salaryForApproval();
    const stale = await payrollRun();
    await salaryForApproval(3600);
    await approvePayroll(stale).expect(409);
    const fresh = await payrollRun();
    expect(fresh.revision).not.toBe(stale.revision);
    await request(server())
      .post('/api/payroll/deductions')
      .set(auth(adminToken))
      .send({
        employeeId: employee.id,
        month: '2026-10',
        days: 1,
        reason: 'Late adjustment before approval',
        approvedBy: 'HR Supervisor',
      })
      .expect(201);
    await approvePayroll(fresh).expect(409);
    const reviewed = await payrollRun();
    const approved = await approvePayroll(reviewed).expect(201);
    expect(approved.body.rows[0]).toMatchObject({
      grossSalary: 3600,
      deductionDays: 1,
      netSalary: 3480,
    });
  });

  it('validates payroll approval, prevents employee access and requires configured salaries', async () => {
    const draft = await payrollRun();
    await request(server()).get('/api/payroll/run?month=2026-10').expect(401);
    await request(server())
      .get('/api/payroll/run?month=2026-10')
      .set(auth(employeeToken))
      .expect(403);
    await approvePayroll(draft, employeeToken).expect(403);
    await approvePayroll(draft).expect(409);
    const valid = {
      month: '2026-10',
      expectedRevision: draft.revision,
      reason: 'Reviewed payroll amounts',
    };
    for (const body of [
      { ...valid, month: '2026-13' },
      { ...valid, expectedRevision: 'bad-revision' },
      { ...valid, reason: 'no' },
      { ...valid, rows: [] },
    ]) {
      await request(server())
        .post('/api/payroll/approve')
        .set(auth(adminToken))
        .send(body)
        .expect(400);
    }
    await salaryForApproval();
    await approvePayroll(await payrollRun('2026-11')).expect(400);
    await approvePayroll(await payrollRun('2026-09')).expect(409);
  });

  it('keeps payroll approved and unchanged after restarting with the saved database', async () => {
    await salaryForApproval();
    const approved = (await approvePayroll(await payrollRun()).expect(201))
      .body;
    const directory = mkdtempSync(join(tmpdir(), 'hr-payroll-lock-'));
    const path = join(directory, 'hr.sqlite');
    let restarted: INestApplication | undefined;
    const previousPath = process.env.HR_DATABASE_PATH;
    try {
      app.get(DatabaseService).db.prepare('VACUUM INTO ?').run(path);
      vi.stubEnv('HR_DATABASE_PATH', path);
      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      restarted = module.createNestApplication();
      await restarted.init();
      const run = await request(restarted.getHttpServer())
        .get('/api/payroll/run?month=2026-10')
        .set(auth(adminToken))
        .expect(200);
      expect(run.body).toEqual(approved);
      await request(restarted.getHttpServer())
        .post('/api/payroll/deductions')
        .set(auth(adminToken))
        .send({
          employeeId: employee.id,
          month: '2026-10',
          days: 1,
          reason: 'Cannot edit after restart',
          approvedBy: 'HR Supervisor',
        })
        .expect(409);
    } finally {
      await restarted?.close();
      vi.stubEnv('HR_DATABASE_PATH', previousPath ?? ':memory:');
      rmSync(directory, { recursive: true });
    }
  });

  it('allows HR to approve configured zero salaries and records the approving identity', async () => {
    await salaryForApproval(0);
    const hr = (
      await request(server())
        .post('/api/employees')
        .set(auth(adminToken))
        .send({
          ...fields(),
          nationalId: 'PAYROLL-HR',
          name: 'Payroll HR',
          email: 'payroll-approver@test.local',
          role: 'hr',
          password: employeePassword,
          monthlySalary: 0,
        })
        .expect(201)
    ).body;
    const login = await request(server())
      .post('/api/auth/login')
      .send({ email: hr.email, password: employeePassword })
      .expect(201);
    const draft = await request(server())
      .get('/api/payroll/run?month=2026-10')
      .set(auth(login.body.token))
      .expect(200);
    const approved = await approvePayroll(draft.body, login.body.token).expect(
      201,
    );
    expect(approved.body).toMatchObject({
      approvedBy: 'Payroll HR',
      approvedById: login.body.user.id,
      status: 'approved',
    });
    expect(
      approved.body.rows.every(
        (row: { grossSalary: number; netSalary: number }) =>
          row.grossSalary === 0 && row.netSalary === 0,
      ),
    ).toBe(true);
  });

  it('rolls back payroll approval when its audit cannot be saved', async () => {
    await salaryForApproval();
    const draft = await payrollRun();
    const actor = app.get(AuthService).authenticate(adminToken);
    const audit = vi
      .spyOn(app.get(AuditService), 'record')
      .mockImplementationOnce(() => {
        throw new Error('Audit unavailable');
      });
    try {
      expect(() =>
        app.get(PayrollService).approve(actor, {
          month: draft.month,
          expectedRevision: draft.revision,
          reason: 'Reviewed salaries and deductions',
        }),
      ).toThrow('Audit unavailable');
      expect((await payrollRun()).status).toBe('draft');
      expect(
        app
          .get(DatabaseService)
          .db.prepare('SELECT COUNT(*) AS count FROM payroll_runs')
          .get()?.count,
      ).toBe(0);
    } finally {
      audit.mockRestore();
    }
    await approvePayroll(draft).expect(201);
  });

  const createManager = async (
    suffix: string,
    department = 'Engineering',
    role = 'manager',
    assign = true,
  ) => {
    const email = `manager${suffix}@test.local`;
    const person = (
      await request(server())
        .post('/api/employees')
        .set(auth(adminToken))
        .send({
          ...fields(),
          nationalId: `MANAGER-${suffix}`,
          email,
          department,
          role,
          managerId: null,
          password: employeePassword,
        })
        .expect(201)
    ).body;
    if (assign) {
      await request(server())
        .patch(`/api/employees/${employee.id}`)
        .set(auth(adminToken))
        .send({ ...fields(), managerId: person.id })
        .expect(200);
      employee.managerId = person.id;
    }
    const token = (
      await request(server())
        .post('/api/auth/login')
        .send({ email, password: employeePassword })
        .expect(201)
    ).body.token;
    return { person, token };
  };
  const workflowRequest = async (token = employeeToken, date = '2026-10-05') =>
    (
      await request(server())
        .post('/api/requests')
        .set(auth(token))
        .send({
          type: 'leave',
          from: date,
          to: date,
          reason: 'Family appointment',
        })
        .expect(201)
    ).body;
  const managerReview = (id: string, token: string, status = 'approved') =>
    request(server())
      .patch(`/api/requests/${id}/manager-review`)
      .set(auth(token))
      .send({ status, reason: 'Manager checked department coverage' });
  const hrDecision = (id: string, status = 'approved', token = adminToken) =>
    request(server())
      .patch(`/api/requests/${id}/decision`)
      .set(auth(token))
      .send({ status, reason: 'HR considered the recommendation' });
  const inbox = async (token: string) =>
    (
      await request(server())
        .get('/api/notifications')
        .set(auth(token))
        .expect(200)
    ).body;

  it('separates direct reports for two managers in one department', async () => {
    const first = await createManager('1');
    const second = await createManager('2');
    const secondReport = (
      await request(server())
        .post('/api/employees')
        .set(auth(adminToken))
        .send({
          ...fields(),
          nationalId: 'SECOND-REPORT',
          email: 'second-report@test.local',
          managerId: second.person.id,
          password: employeePassword,
        })
        .expect(201)
    ).body as Employee;
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), managerId: first.person.id })
      .expect(200);
    const firstReports = (
      await request(server())
        .get('/api/employees/reports')
        .set(auth(first.token))
        .expect(200)
    ).body;
    expect(firstReports.map((report: Employee) => report.id)).toEqual([
      employee.id,
    ]);
    expect(firstReports[0]).not.toHaveProperty('monthlySalary');
    expect(firstReports[0]).not.toHaveProperty('nationalId');
    expect(
      (
        await request(server())
          .get('/api/employees/reports')
          .set(auth(second.token))
          .expect(200)
      ).body.map((report: Employee) => report.id),
    ).toContain(secondReport.id);
    const firstAttendance = (
      await request(server())
        .get('/api/attendance?from=2026-10-04&to=2026-10-04')
        .set(auth(first.token))
        .expect(200)
    ).body;
    expect(
      firstAttendance.every(
        (row: { employeeId: string; nationalId: string }) =>
          row.employeeId === employee.id && row.nationalId === '',
      ),
    ).toBe(true);
    await request(server())
      .get('/api/employees')
      .set(auth(first.token))
      .expect(403);
    await request(server())
      .get('/api/payroll/run?month=2026-10')
      .set(auth(first.token))
      .expect(403);
  });

  it('paginates request lists without duplicates and reuses profiles without resolving schedules', async () => {
    const manager = await createManager('1');
    const unrelated = await workflowRequest(manager.token);
    const original = await workflowRequest();
    const ids = [original.id];
    const db = app.get(DatabaseService).db;
    for (let index = 0; index < 104; index++) {
      const id = randomUUID();
      ids.unshift(id);
      db.prepare('INSERT INTO employee_requests VALUES (?, ?, ?, ?)').run(
        id,
        employee.id,
        'pending',
        JSON.stringify({ ...original, id }),
      );
    }
    const profiles = vi.spyOn(app.get(EmployeesService), 'storedEmployee');
    const schedules = vi.spyOn(app.get(SchedulesService), 'assignedSchedule');
    try {
      const first = await request(server())
        .get('/api/requests/managed')
        .set(auth(manager.token))
        .expect(200);
      expect(first.body.map((item: { id: string }) => item.id)).toEqual(
        ids.slice(0, 50),
      );
      expect(profiles).toHaveBeenCalledTimes(2);
      expect(schedules).not.toHaveBeenCalled();
      profiles.mockClear();
      await inbox(manager.token);
      expect(profiles).toHaveBeenCalledTimes(2);
      expect(schedules).not.toHaveBeenCalled();
      for (const [path, token, expected] of [
        ['/api/requests/me', employeeToken, ids],
        ['/api/requests/managed', manager.token, ids],
        ['/api/requests', adminToken, [...ids, unrelated.id]],
      ] as const) {
        const received: string[] = [];
        let before: string | undefined;
        do {
          const query = new URLSearchParams({
            limit: '17',
            ...(before ? { before } : {}),
          });
          const page = await request(server())
            .get(`${path}?${query}`)
            .set(auth(token))
            .expect(200);
          const pageIds = page.body.map(
            (item: { id: string }) => item.id,
          ) as string[];
          expect(pageIds.length).toBeLessThanOrEqual(17);
          received.push(...pageIds);
          before = pageIds.length === 17 ? pageIds.at(-1) : undefined;
        } while (before);
        expect(received).toEqual(expected);
      }
      db.prepare(
        "UPDATE employee_requests SET status = 'approved', data = json_set(data, '$.status', 'approved') WHERE id = ?",
      ).run(original.id);
      const approved = await request(server())
        .get('/api/requests/me?status=approved&limit=1')
        .set(auth(employeeToken))
        .expect(200);
      expect(approved.body.map((item: { id: string }) => item.id)).toEqual([
        original.id,
      ]);
      await request(server())
        .get('/api/requests/managed?status=approved')
        .set(auth(manager.token))
        .expect(200, []);
      for (const query of [
        'limit=0',
        'limit=101',
        'limit=1.5',
        'before=invalid',
        'status=invalid',
        'extra=1',
      ]) {
        await request(server())
          .get(`/api/requests/me?${query}`)
          .set(auth(employeeToken))
          .expect(400);
      }
    } finally {
      profiles.mockRestore();
      schedules.mockRestore();
    }
  });

  it('only computes pending workflows for accessible direct reports', async () => {
    const manager = await createManager('1');
    const reportRequest = await workflowRequest();
    const ownRequest = await workflowRequest(manager.token);
    const workflow = vi.spyOn(app.get(RequestsService), 'workflow');
    try {
      expect((await inbox(employeeToken)).items).toHaveLength(0);
      expect(workflow).not.toHaveBeenCalled();
      const queue = await request(server())
        .get('/api/requests/managed')
        .set(auth(manager.token))
        .expect(200);
      expect(queue.body.map((item: { id: string }) => item.id)).toEqual([
        reportRequest.id,
      ]);
      expect(workflow).toHaveBeenCalledTimes(1);
      workflow.mockClear();
      expect(
        (await inbox(manager.token)).items.map(
          (item: { requestId: string }) => item.requestId,
        ),
      ).toEqual([reportRequest.id]);
      expect(workflow).toHaveBeenCalledTimes(1);
      workflow.mockClear();
      expect(
        (await inbox(adminToken)).items.map(
          (item: { requestId: string }) => item.requestId,
        ),
      ).toContain(ownRequest.id);
      expect(workflow).toHaveBeenCalledTimes(2);
    } finally {
      workflow.mockRestore();
    }
  });

  it('requires manager review before HR, isolates permissions and routes notifications', async () => {
    const manager = await createManager('1');
    const created = await workflowRequest();
    expect(created).toMatchObject({
      status: 'pending',
      managerStage: 'pending',
      managerEmployeeId: manager.person.id,
      salaryDeductionDays: null,
    });
    await hrDecision(created.id).expect(409);
    await hrDecision(created.id, 'rejected').expect(409);
    await managerReview(created.id, employeeToken).expect(403);
    for (const path of [
      '/api/requests',
      '/api/employees',
      '/api/payroll?month=2026-10',
    ])
      await request(server()).get(path).set(auth(manager.token)).expect(403);
    const queue = await request(server())
      .get('/api/requests/managed')
      .set(auth(manager.token))
      .expect(200);
    expect(queue.body.map((item: { id: string }) => item.id)).toEqual([
      created.id,
    ]);
    expect((await inbox(manager.token)).items[0]).toMatchObject({
      type: 'manager-review-required',
      requestId: created.id,
    });
    expect((await inbox(adminToken)).items).toHaveLength(0);
    const reviewed = await managerReview(created.id, manager.token).expect(200);
    expect(reviewed.body).toMatchObject({
      status: 'pending',
      managerStage: 'approved',
      salaryDeductionDays: null,
      decidedAt: null,
      managerReview: { employeeId: manager.person.id },
    });
    await managerReview(created.id, manager.token).expect(409);
    await hrDecision(created.id, 'approved', manager.token).expect(403);
    expect((await inbox(manager.token)).items).toHaveLength(0);
    expect((await inbox(adminToken)).items[0].type).toBe('pending-request');
    expect((await inbox(employeeToken)).items[0].type).toBe('manager-reviewed');
    const report = await request(server())
      .get('/api/attendance?from=2026-10-05&to=2026-10-05')
      .set(auth(adminToken))
      .expect(200);
    expect(
      report.body.find(
        (row: { employeeId: string }) => row.employeeId === employee.id,
      ).status,
    ).toBe('No record');
    const final = await hrDecision(created.id).expect(200);
    expect(final.body).toMatchObject({
      status: 'approved',
      salaryDeductionDays: 1,
      managerReview: { employeeId: manager.person.id },
    });
    const audit = await request(server())
      .get(`/api/audit?recordId=${created.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(audit.body.map((item: { action: string }) => item.action)).toContain(
      'request.manager_reviewed',
    );
    expect(
      (
        await request(server())
          .get('/api/requests/managed')
          .set(auth(manager.token))
          .expect(200)
      ).body,
    ).toHaveLength(0);
  });

  it('limits manager scope, validates assignments, and sends own requests directly to HR', async () => {
    const manager = await createManager('1');
    const other = await createManager('2', 'Operations', 'manager', false);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(employeeToken))
      .send({ ...fields(), managerId: other.person.id })
      .expect(403);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), managerId: 'bad-id' })
      .expect(400);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), managerId: employee.id })
      .expect(400);
    const created = await workflowRequest();
    expect(
      (
        await request(server())
          .get('/api/requests/managed')
          .set(auth(other.token))
          .expect(200)
      ).body,
    ).toHaveLength(0);
    await managerReview(created.id, other.token).expect(403);
    await request(server())
      .patch(`/api/requests/${created.id}/manager-review`)
      .set(auth(manager.token))
      .send({ status: 'approved', reason: 'no' })
      .expect(400);
    const own = await workflowRequest(manager.token);
    expect(own.managerStage).toBe('not-required');
    await managerReview(own.id, manager.token).expect(403);
    await hrDecision(own.id).expect(200);
  });

  it('leaves manager rejection advisory and applies salary deductions only on HR decisions', async () => {
    const manager = await createManager('1');
    for (const [index, status] of ['approved', 'rejected'].entries()) {
      const created = await workflowRequest(
        employeeToken,
        `2026-10-0${index + 5}`,
      );
      const reviewed = await managerReview(
        created.id,
        manager.token,
        'rejected',
      ).expect(200);
      expect(reviewed.body).toMatchObject({
        status: 'pending',
        salaryDeductionDays: null,
      });
      const final = await hrDecision(created.id, status).expect(200);
      expect(final.body.salaryDeductionDays).toBe(
        status === 'approved' ? 1 : 3,
      );
    }
  });

  it('renews manager review after reassignment, reopening and employee department changes', async () => {
    const first = await createManager('1');
    const created = await workflowRequest();
    await managerReview(created.id, first.token).expect(200);
    const second = await createManager('2');
    await hrDecision(created.id).expect(409);
    await managerReview(created.id, first.token).expect(403);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), managerId: first.person.id })
      .expect(200);
    await hrDecision(created.id).expect(409);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), managerId: second.person.id })
      .expect(200);
    await managerReview(created.id, second.token).expect(200);
    await hrDecision(created.id).expect(200);
    const reopened = await request(server())
      .patch(`/api/requests/${created.id}/reopen`)
      .set(auth(adminToken))
      .send({ reason: 'Correction requires new review' })
      .expect(200);
    expect(reopened.body).toMatchObject({
      status: 'pending',
      managerStage: 'pending',
      managerReview: null,
      salaryDeductionDays: null,
    });
    await hrDecision(created.id).expect(409);
    await managerReview(created.id, second.token).expect(200);
    const operations = await createManager('3', 'Operations');
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), department: 'Operations' })
      .expect(200);
    await hrDecision(created.id).expect(409);
    expect(
      (
        await request(server())
          .get('/api/requests/managed')
          .set(auth(second.token))
          .expect(200)
      ).body,
    ).toHaveLength(0);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), department: 'Engineering' })
      .expect(200);
    await hrDecision(created.id).expect(409);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), department: 'Operations' })
      .expect(200);
    await managerReview(created.id, operations.token).expect(200);
    await hrDecision(created.id).expect(200);
  });

  it('removes inactive manager assignments and separates manager and HR decisions', async () => {
    const manager = await createManager('1');
    const created = await workflowRequest();
    await managerReview(created.id, manager.token).expect(200);
    await hrDecision(created.id, 'approved', manager.token).expect(403);
    const { id: _id, employeeNumber: _number, ...values } = manager.person;
    await request(server())
      .patch(`/api/employees/${manager.person.id}`)
      .set(auth(adminToken))
      .send({ ...values, active: false })
      .expect(200);
    const reports = await request(server())
      .get('/api/employees')
      .set(auth(adminToken))
      .expect(200);
    expect(
      reports.body.find((item: Employee) => item.id === employee.id).managerId,
    ).toBeNull();
    await hrDecision(created.id).expect(200);
  });

  it('waits for final HR approval before applying a manager-reviewed forgotten check-out', async () => {
    const manager = await createManager('1');
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
    ).body;
    vi.setSystemTime(new Date('2026-10-04T16:00:00Z'));
    const created = (
      await request(server())
        .post('/api/requests')
        .set(auth(employeeToken))
        .send({
          type: 'forgotten-check-out',
          attendanceId: record.id,
          proposedCheckOut: '2026-10-04T15:00:00Z',
          reason: 'Forgot to record departure',
        })
        .expect(201)
    ).body;
    await hrDecision(created.id).expect(409);
    await managerReview(created.id, manager.token).expect(200);
    const before = await request(server())
      .get('/api/attendance/me')
      .set(auth(employeeToken))
      .expect(200);
    expect(before.body.records[0].checkOut).toBeNull();
    await hrDecision(created.id).expect(200);
    const after = await request(server())
      .get('/api/attendance/me')
      .set(auth(employeeToken))
      .expect(200);
    expect(after.body.records[0].checkOut).toBe('2026-10-04T15:00:00.000Z');
  });

  it('rolls back manager review when its audit fails', async () => {
    const manager = await createManager('1');
    const created = await workflowRequest();
    const actor = app.get(AuthService).authenticate(manager.token);
    const audit = vi
      .spyOn(app.get(AuditService), 'record')
      .mockImplementationOnce(() => {
        throw new Error('Audit unavailable');
      });
    try {
      expect(() =>
        app.get(RequestsService).reviewRequest(actor, created.id, {
          status: 'approved',
          reason: 'Manager reviewed request',
        }),
      ).toThrow('Audit unavailable');
      const mine = await request(server())
        .get('/api/requests/me')
        .set(auth(employeeToken))
        .expect(200);
      expect(mine.body[0]).toMatchObject({
        managerStage: 'pending',
        managerReview: null,
      });
      expect((await inbox(employeeToken)).items).toHaveLength(0);
    } finally {
      audit.mockRestore();
    }
  });

  it('notifies employees of decisions and keeps notification reads private and idempotent', async () => {
    await request(server()).get('/api/notifications').expect(401);
    const created = await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        type: 'leave',
        from: '2026-10-05',
        to: '2026-10-05',
        reason: 'Family appointment',
      })
      .expect(201);
    const hr = await request(server())
      .get('/api/notifications')
      .set(auth(adminToken))
      .expect(200);
    expect(hr.body.unreadCount).toBe(1);
    expect(hr.body.items[0]).toMatchObject({
      type: 'pending-request',
      requestId: created.body.id,
    });
    const pendingId = hr.body.items[0].id;
    await request(server())
      .patch(`/api/notifications/${encodeURIComponent(pendingId)}/read`)
      .set(auth(employeeToken))
      .send({})
      .expect(404);
    await request(server())
      .patch(`/api/notifications/${encodeURIComponent(pendingId)}/read`)
      .set(auth(adminToken))
      .send({})
      .expect(200);
    const hrRead = await request(server())
      .get('/api/notifications')
      .set(auth(adminToken))
      .expect(200);
    expect(hrRead.body.unreadCount).toBe(0);
    await request(server())
      .patch(`/api/requests/${created.body.id}/decision`)
      .set(auth(adminToken))
      .send({ status: 'approved', reason: 'Approved family leave' })
      .expect(200);
    const mine = await request(server())
      .get('/api/notifications')
      .set(auth(employeeToken))
      .expect(200);
    expect(mine.body.unreadCount).toBe(1);
    expect(mine.body.items[0]).toMatchObject({
      type: 'request-decided',
      title: 'Request approved',
      requestId: created.body.id,
    });
    const id = mine.body.items[0].id;
    await request(server())
      .patch(`/api/notifications/${id}/read`)
      .set(auth(adminToken))
      .send({})
      .expect(404);
    const read = await request(server())
      .patch(`/api/notifications/${id}/read`)
      .set(auth(employeeToken))
      .send({})
      .expect(200);
    expect(read.body.readAt).not.toBeNull();
    const repeated = await request(server())
      .patch(`/api/notifications/${id}/read`)
      .set(auth(employeeToken))
      .send({})
      .expect(200);
    expect(repeated.body.readAt).toBe(read.body.readAt);
    const final = await request(server())
      .get('/api/notifications')
      .set(auth(employeeToken))
      .expect(200);
    expect(final.body.items).toHaveLength(1);
    expect(final.body.unreadCount).toBe(0);
    expect(
      (
        await request(server())
          .get('/api/notifications')
          .set(auth(adminToken))
          .expect(200)
      ).body.items,
    ).toHaveLength(0);
    await request(server())
      .patch(`/api/requests/${created.body.id}/reopen`)
      .set(auth(adminToken))
      .send({ reason: 'Correct requested dates' })
      .expect(200);
    const reopened = await request(server())
      .get('/api/notifications')
      .set(auth(employeeToken))
      .expect(200);
    expect(reopened.body.items).toHaveLength(2);
    expect(reopened.body.unreadCount).toBe(1);
    expect(
      reopened.body.items.some(
        (item: { type: string }) => item.type === 'request-reopened',
      ),
    ).toBe(true);
    const pendingAgain = await request(server())
      .get('/api/notifications')
      .set(auth(adminToken))
      .expect(200);
    expect(pendingAgain.body.unreadCount).toBe(1);
    expect(pendingAgain.body.items[0].id).not.toBe(pendingId);
    await request(server())
      .patch(`/api/requests/${created.body.id}/withdraw`)
      .set(auth(employeeToken))
      .send({ reason: 'Submit corrected dates' })
      .expect(200);
    expect(
      (
        await request(server())
          .get('/api/notifications')
          .set(auth(adminToken))
          .expect(200)
      ).body.items,
    ).toHaveLength(0);
  });

  it('notifies rejected requests only to their employee and tracks HR reads independently', async () => {
    const other = (
      await request(server())
        .post('/api/employees')
        .set(auth(adminToken))
        .send({
          ...fields(),
          nationalId: 'OTHER-001',
          email: 'other@test.local',
          role: 'hr',
          password: employeePassword,
        })
        .expect(201)
    ).body;
    const otherToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: other.email, password: employeePassword })
        .expect(201)
    ).body.token;
    const created = await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        type: 'sick',
        from: '2026-10-05',
        to: '2026-10-05',
        reason: 'Medical appointment',
      })
      .expect(201);
    const admin = await request(server())
      .get('/api/notifications')
      .set(auth(adminToken))
      .expect(200);
    await request(server())
      .patch(
        `/api/notifications/${encodeURIComponent(admin.body.items[0].id)}/read`,
      )
      .set(auth(adminToken))
      .send({})
      .expect(200);
    expect(
      (
        await request(server())
          .get('/api/notifications')
          .set(auth(otherToken))
          .expect(200)
      ).body.unreadCount,
    ).toBe(1);
    await request(server())
      .patch(`/api/requests/${created.body.id}/decision`)
      .set(auth(adminToken))
      .send({ status: 'rejected', reason: 'Missing supporting document' })
      .expect(200);
    expect(
      (
        await request(server())
          .get('/api/notifications')
          .set(auth(otherToken))
          .expect(200)
      ).body.items,
    ).toHaveLength(0);
    const mine = await request(server())
      .get('/api/notifications')
      .set(auth(employeeToken))
      .expect(200);
    expect(mine.body.items[0]).toMatchObject({
      title: 'Request rejected',
      requestId: created.body.id,
    });
  });

  it('alerts HR only after shift end and resolves missing check-outs after correction', async () => {
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
    ).body;
    expect(
      (
        await request(server())
          .get('/api/notifications')
          .set(auth(adminToken))
          .expect(200)
      ).body.unreadCount,
    ).toBe(0);
    vi.setSystemTime(new Date('2026-10-04T16:00:00Z'));
    const inbox = await request(server())
      .get('/api/notifications')
      .set(auth(adminToken))
      .expect(200);
    expect(inbox.body.items[0]).toMatchObject({
      type: 'missing-check-out',
      attendanceId: record.id,
    });
    expect(
      (
        await request(server())
          .get('/api/notifications')
          .set(auth(employeeToken))
          .expect(200)
      ).body.items,
    ).toHaveLength(0);
    await request(server())
      .patch(
        `/api/notifications/${encodeURIComponent(inbox.body.items[0].id)}/read`,
      )
      .set(auth(adminToken))
      .send({})
      .expect(200);
    await request(server())
      .patch(`/api/attendance/${record.id}`)
      .set(auth(adminToken))
      .send({
        checkIn: record.checkIn,
        checkOut: '2026-10-04T15:00:00Z',
        reason: 'Confirmed employee departure',
      })
      .expect(200);
    expect(
      (
        await request(server())
          .get('/api/notifications')
          .set(auth(adminToken))
          .expect(200)
      ).body.items,
    ).toHaveLength(0);
  });

  it('uses the recorded overnight shift and timezone for missing check-out notifications', async () => {
    const db = app.get(DatabaseService).db;
    const id = '726d7b9b-3997-4b3a-b0ed-b20f5de20be3';
    db.prepare('INSERT INTO attendance VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      employee.id,
      '2026-10-03',
      '2026-10-03T19:00:00Z',
      null,
      JSON.stringify({ ...schedule, start: '22:00', end: '06:00' }),
      'Africa/Cairo',
    );
    vi.setSystemTime(new Date('2026-10-04T02:59:00Z'));
    expect(
      (
        await request(server())
          .get('/api/notifications')
          .set(auth(adminToken))
          .expect(200)
      ).body.items,
    ).toHaveLength(0);
    vi.setSystemTime(new Date('2026-10-04T03:00:00Z'));
    expect(
      (
        await request(server())
          .get('/api/notifications')
          .set(auth(adminToken))
          .expect(200)
      ).body.items[0],
    ).toMatchObject({ type: 'missing-check-out', attendanceId: id });
  });

  it('upgrades existing request storage without losing records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hr-request-migration-'));
    const path = join(directory, 'hr.sqlite');
    const previousPath = process.env.HR_DATABASE_PATH;
    let upgraded: DatabaseService | undefined;
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(
        DATABASE_SCHEMA.replace(
          "'pending', 'approved', 'rejected', 'withdrawn'",
          "'pending', 'approved', 'rejected'",
        ),
      );
      legacy
        .prepare('INSERT INTO employees VALUES (?, ?, ?, ?)')
        .run(
          employee.id,
          employee.nationalId,
          employee.email,
          JSON.stringify(employee),
        );
      legacy
        .prepare('INSERT INTO employee_requests VALUES (?, ?, ?, ?)')
        .run(
          'legacy-request',
          employee.id,
          'pending',
          JSON.stringify({ salaryDeductionDays: null }),
        );
      legacy.close();
      process.env.HR_DATABASE_PATH = path;
      upgraded = new DatabaseService();
      expect(
        upgraded.db
          .prepare('SELECT status FROM employee_requests WHERE id = ?')
          .get('legacy-request')?.status,
      ).toBe('pending');
      upgraded.db
        .prepare(
          "UPDATE employee_requests SET status = 'withdrawn' WHERE id = ?",
        )
        .run('legacy-request');
      expect(
        upgraded.db
          .prepare('SELECT status FROM employee_requests WHERE id = ?')
          .get('legacy-request')?.status,
      ).toBe('withdrawn');
    } finally {
      upgraded?.onModuleDestroy();
      if (previousPath === undefined) delete process.env.HR_DATABASE_PATH;
      else process.env.HR_DATABASE_PATH = previousPath;
      rmSync(directory, { recursive: true });
    }
  });

  it('rolls back withdrawal if recording its audit fails', async () => {
    const created = await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        type: 'leave',
        from: '2026-10-05',
        to: '2026-10-05',
        reason: 'Family appointment',
      })
      .expect(201);
    const audit = vi
      .spyOn(app.get(AuditService), 'record')
      .mockImplementationOnce(() => {
        throw new Error('Audit unavailable');
      });
    try {
      await request(server())
        .patch(`/api/requests/${created.body.id}/withdraw`)
        .set(auth(employeeToken))
        .send({ reason: 'No longer needed' })
        .expect(500);
      const mine = await request(server())
        .get('/api/requests/me')
        .set(auth(employeeToken))
        .expect(200);
      expect(mine.body[0].status).toBe('pending');
    } finally {
      audit.mockRestore();
    }
  });

  it('withdraws pending excuses, releases the allowance, and preserves an audit trail', async () => {
    const payload = {
      type: 'excuse',
      from: '2026-10-05',
      to: '2026-10-05',
      durationMinutes: 240,
      excuseType: 'leaving-early',
      shiftId: schedule.id,
    };
    const created = await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(payload)
      .expect(201);
    const url = `/api/requests/${created.body.id}/withdraw`;
    await request(server())
      .patch(url)
      .set(auth(adminToken))
      .send({ reason: 'Wrong employee action' })
      .expect(403);
    await request(server())
      .patch(url)
      .set(auth(employeeToken))
      .send({ reason: 'no' })
      .expect(400);
    const result = await request(server())
      .patch(url)
      .set(auth(employeeToken))
      .send({ reason: 'No longer needed' })
      .expect(200);
    expect(result.body.status).toBe('withdrawn');
    expect(result.body.salaryDeductionDays).toBeNull();
    await request(server())
      .patch(url)
      .set(auth(employeeToken))
      .send({ reason: 'No longer needed' })
      .expect(409);
    await request(server())
      .patch(`/api/requests/${created.body.id}/decision`)
      .set(auth(adminToken))
      .send({ status: 'approved', reason: 'Cannot approve withdrawn' })
      .expect(409);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(payload)
      .expect(201);
    const audit = await request(server())
      .get(`/api/audit?recordId=${created.body.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(
      audit.body.some(
        (entry: { action: string }) => entry.action === 'request.withdrawn',
      ),
    ).toBe(true);
  });

  it('allows only HR to reopen an approval and removes its payroll and attendance effects', async () => {
    const created = await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        type: 'leave',
        from: '2026-10-05',
        to: '2026-10-05',
        reason: 'Family appointment',
      })
      .expect(201);
    const root = `/api/requests/${created.body.id}`;
    await request(server())
      .patch(`${root}/reopen`)
      .set(auth(adminToken))
      .send({ reason: 'Correction needed' })
      .expect(409);
    await request(server())
      .patch(`${root}/decision`)
      .set(auth(adminToken))
      .send({ status: 'approved', reason: 'Approved time off' })
      .expect(200);
    await request(server())
      .patch(`${root}/withdraw`)
      .set(auth(employeeToken))
      .send({ reason: 'No longer needed' })
      .expect(409);
    await request(server())
      .patch(`${root}/reopen`)
      .set(auth(employeeToken))
      .send({ reason: 'Correction needed' })
      .expect(403);
    const reopened = await request(server())
      .patch(`${root}/reopen`)
      .set(auth(adminToken))
      .send({ reason: 'Correction needed' })
      .expect(200);
    expect(reopened.body).toMatchObject({
      status: 'pending',
      salaryDeductionDays: null,
      decidedAt: null,
      lastChange: { action: 'reopen' },
    });
    const payroll = await request(server())
      .get('/api/payroll?month=2026-10')
      .set(auth(adminToken))
      .expect(200);
    expect(
      payroll.body.find(
        (row: { employeeId: string }) => row.employeeId === employee.id,
      )?.deductionDays,
    ).toBe(0);
    const attendance = await request(server())
      .get('/api/attendance?from=2026-10-05&to=2026-10-05')
      .set(auth(adminToken))
      .expect(200);
    expect(attendance.body[0].status).toBe('No record');
    await request(server())
      .patch(`${root}/decision`)
      .set(auth(adminToken))
      .send({ status: 'approved', reason: 'Reviewed correction' })
      .expect(200);
    const audit = await request(server())
      .get(`/api/audit?recordId=${created.body.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(
      audit.body.some(
        (entry: { action: string; before: { salaryDeductionDays: number } }) =>
          entry.action === 'request.reopened' &&
          entry.before.salaryDeductionDays === 1,
      ),
    ).toBe(true);
  });

  it('allows exactly 3 excuses totaling 4 hours and releases rejected reservations', async () => {
    const ids: string[] = [];
    for (const [index, excuseType] of [
      'leaving-early',
      'arriving-late',
      'during-shift',
    ].entries()) {
      const date = `2026-10-0${index + 5}`;
      const result = await request(server())
        .post('/api/requests')
        .set(auth(employeeToken))
        .send({
          type: 'excuse',
          from: date,
          to: date,
          durationMinutes: 80,
          excuseType,
          shiftId: schedule.id,
        })
        .expect(201);
      ids.push(result.body.id);
    }
    const fourth = {
      type: 'excuse',
      from: '2026-10-08',
      to: '2026-10-08',
      durationMinutes: 80,
      excuseType: 'leaving-early',
      shiftId: schedule.id,
    };
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(fourth)
      .expect(409);
    await request(server())
      .patch(`/api/requests/${ids[0]}/decision`)
      .set(auth(adminToken))
      .send({ status: 'approved', reason: 'Verified excuse' })
      .expect(200);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(fourth)
      .expect(409);
    await request(server())
      .patch(`/api/requests/${ids[1]}/decision`)
      .set(auth(adminToken))
      .send({ status: 'rejected', reason: 'Not accepted' })
      .expect(200);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(fourth)
      .expect(201);
    const rows = await request(server())
      .get('/api/requests/me')
      .set(auth(employeeToken))
      .expect(200);
    expect(rows.body.length).toBe(4);
  });

  it('enforces the 240-minute cap even below 3 requests and counts every date', async () => {
    const payload = {
      type: 'excuse',
      from: '2026-10-05',
      to: '2026-10-06',
      durationMinutes: 121,
      excuseType: 'leaving-early',
      shiftId: schedule.id,
    };
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(payload)
      .expect(409);
    const result = await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({ ...payload, durationMinutes: 120 })
      .expect(201);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        ...payload,
        from: '2026-10-07',
        to: '2026-10-07',
        durationMinutes: 1,
      })
      .expect(409);
    await request(server())
      .patch(`/api/requests/${result.body.id}/decision`)
      .set(auth(adminToken))
      .send({ status: 'approved', reason: 'Verified excuse' })
      .expect(200);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        type: 'sick',
        from: '2026-10-07',
        to: '2026-10-07',
        reason: 'Medical appointment',
      })
      .expect(201);
  });

  it('splits excuse minutes across calendar months and resets each monthly allowance', async () => {
    const payload = {
      type: 'excuse',
      from: '2026-10-31',
      to: '2026-11-01',
      durationMinutes: 120,
      excuseType: 'leaving-early',
      shiftId: schedule.id,
    };
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(payload)
      .expect(201);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({ ...payload, from: '2026-11-02', to: '2026-11-02' })
      .expect(201);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        ...payload,
        from: '2026-11-03',
        to: '2026-11-03',
        durationMinutes: 1,
      })
      .expect(409);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({ ...payload, from: '2026-10-30', to: '2026-10-30' })
      .expect(201);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        ...payload,
        from: '2026-12-01',
        to: '2026-12-01',
        durationMinutes: 240,
      })
      .expect(201);
  });

  it('lists manual deductions by recording date in company timezone, with HR access only', async () => {
    vi.setSystemTime(new Date('2026-10-04T22:30:00Z'));
    adminToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: 'admin@test.local', password: adminPassword })
        .expect(201)
    ).body.token;
    employeeToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: employee.email, password: employeePassword })
        .expect(201)
    ).body.token;

    const created = await request(server())
      .post('/api/payroll/deductions')
      .set(auth(adminToken))
      .send({
        employeeId: employee.id,
        month: '2026-11',
        days: 2,
        reason: 'Reviewed deduction',
        approvedBy: 'Management',
      })
      .expect(201);
    const recorded = await request(server())
      .get('/api/payroll/deductions?from=2026-10-05&to=2026-10-05')
      .set(auth(adminToken))
      .expect(200);
    expect(recorded.body).toEqual([created.body]);
    const previous = await request(server())
      .get('/api/payroll/deductions?from=2026-10-04&to=2026-10-04')
      .set(auth(adminToken))
      .expect(200);
    expect(previous.body).toEqual([]);
    await request(server())
      .get('/api/payroll/deductions?from=2026-10-05&to=2026-10-04')
      .set(auth(adminToken))
      .expect(400);
    await request(server())
      .get('/api/payroll/deductions?from=2026-10-05&to=2027-10-05')
      .set(auth(adminToken))
      .expect(400);
    await request(server())
      .get('/api/payroll/deductions?from=2026-10-05&to=2026-10-05')
      .set(auth(employeeToken))
      .expect(403);
  });

  it('creates empty departments, rejects duplicates and assigns an existing employee later', async () => {
    await request(server())
      .post('/api/departments')
      .set(auth(adminToken))
      .send({ name: '  Operations  ' })
      .expect(201, { name: 'Operations' });
    await request(server())
      .post('/api/departments')
      .set(auth(adminToken))
      .send({ name: 'operations' })
      .expect(409);
    for (const body of [
      { name: '   ' },
      { name: 'x'.repeat(121) },
      { name: 'HR', unexpected: true },
    ])
      await request(server())
        .post('/api/departments')
        .set(auth(adminToken))
        .send(body)
        .expect(400);
    const departments = await request(server())
      .get('/api/departments')
      .set(auth(adminToken))
      .expect(200);
    expect(departments.body).toEqual([
      { name: 'Engineering' },
      { name: 'Operations' },
    ]);
    const before = await request(server())
      .get('/api/employees')
      .set(auth(adminToken))
      .expect(200);
    expect(before.body[0].department).toBe('Engineering');
    const store = app.get(DatabaseService);
    store.db
      .prepare('DELETE FROM departments WHERE name = ?')
      .run('Engineering');
    store.db.exec(DATABASE_SCHEMA);
    const migrated = await request(server())
      .get('/api/departments')
      .set(auth(adminToken))
      .expect(200);
    expect(migrated.body).toEqual(departments.body);

    const moved = await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), department: 'operations' })
      .expect(200);
    expect(moved.body.department).toBe('Operations');
    expect(moved.body.employeeNumber).toBe(employee.employeeNumber);
    expect(
      (await request(server()).get('/api/departments').set(auth(adminToken)))
        .body,
    ).toEqual(departments.body);
    const audit = await request(server())
      .get('/api/audit')
      .set(auth(adminToken))
      .expect(200);
    expect(
      audit.body.some(
        (entry: { action: string }) => entry.action === 'department.created',
      ),
    ).toBe(true);
  });
  it('allows HR to create departments and denies employee access', async () => {
    await request(server())
      .get('/api/departments')
      .set(auth(employeeToken))
      .expect(403);
    await request(server())
      .post('/api/departments')
      .set(auth(employeeToken))
      .send({ name: 'Unauthorized' })
      .expect(403);
    await request(server())
      .post('/api/employees')
      .set(auth(adminToken))
      .send({
        ...fields(),
        nationalId: 'HR-TEST',
        email: 'hr@test.local',
        name: 'HR Test',
        role: 'hr',
        password: employeePassword,
      })
      .expect(201);
    const hr = await request(server())
      .post('/api/auth/login')
      .send({ email: 'hr@test.local', password: employeePassword })
      .expect(201);
    await request(server())
      .post('/api/departments')
      .set(auth(hr.body.token))
      .send({ name: 'Finance' })
      .expect(201);
    await request(server())
      .get('/api/departments')
      .set(auth(hr.body.token))
      .expect(200);
  });

  it.each(['sick', 'unpaid', 'urgent', 'mission'])(
    'submits and approves %s requests with the shared salary deduction policy',
    async (type) => {
      const created = await request(server())
        .post('/api/requests')
        .set(auth(employeeToken))
        .send({
          type,
          from: '2026-10-05',
          to: '2026-10-05',
          reason: 'Mobile request description',
        })
        .expect(201);
      const approved = await request(server())
        .patch(`/api/requests/${created.body.id}/decision`)
        .set(auth(adminToken))
        .send({ status: 'approved', reason: 'Reviewed by HR' })
        .expect(200);
      expect(approved.body.salaryDeductionDays).toBe(1);
      const report = await request(server())
        .get('/api/attendance?from=2026-10-05&to=2026-10-05')
        .set(auth(adminToken))
        .expect(200);
      expect(report.body[0].status).toBe(`Approved ${type}`);
    },
  );

  it('persists excuse details and attachments without turning a partial excuse into full-day leave', async () => {
    const payload = {
      type: 'excuse',
      from: '2026-10-05',
      to: '2026-10-05',
      durationMinutes: 15,
      excuseType: 'leaving-early',
      shiftId: schedule.id,
      reason: '',
      attachments: [
        {
          name: 'note.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('%PDF-1.4 test').toString('base64'),
        },
      ],
    };
    const created = await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(payload)
      .expect(201);
    expect(created.body).toMatchObject(payload);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(payload)
      .expect(409);
    await request(server())
      .patch(`/api/requests/${created.body.id}/decision`)
      .set(auth(adminToken))
      .send({ status: 'approved', reason: 'Reviewed by HR' })
      .expect(200);
    const mine = await request(server())
      .get('/api/requests/me')
      .set(auth(employeeToken))
      .expect(200);
    expect(mine.body[0]).toMatchObject({
      ...payload,
      status: 'approved',
      salaryDeductionDays: 1,
    });
    const report = await request(server())
      .get('/api/attendance?from=2026-10-05&to=2026-10-05')
      .set(auth(adminToken))
      .expect(200);
    expect(report.body[0].status).toBe('No record');
  });

  it('rejects invalid excuse fields, dates, durations and attachments', async () => {
    const payload = {
      type: 'excuse',
      from: '2026-10-05',
      to: '2026-10-05',
      durationMinutes: 15,
      excuseType: 'leaving-early',
      shiftId: schedule.id,
      reason: '',
    };
    for (const changes of [
      { durationMinutes: 0 },
      { durationMinutes: 1440 },
      { durationMinutes: 1.5 },
      { excuseType: 'unknown' },
      { shiftId: '00000000-0000-4000-8000-000000000000' },
      { to: '2026-10-04' },
      { reason: 'x'.repeat(121) },
      {
        attachments: [
          { name: 'bad.pdf', mimeType: 'application/pdf', content: 'invalid!' },
        ],
      },
    ]) {
      await request(server())
        .post('/api/requests')
        .set(auth(employeeToken))
        .send({ ...payload, ...changes })
        .expect(400);
    }
  });

  beforeAll(async () => {
    photo = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#779988' },
    })
      .png()
      .toBuffer();
  });
  beforeEach(async () => {
    vi.stubEnv('HR_DATABASE_PATH', ':memory:');
    vi.stubEnv('HR_ADMIN_EMAIL', 'admin@test.local');
    vi.stubEnv('HR_ADMIN_PASSWORD', adminPassword);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T07:00:00Z'));
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    adminToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: 'admin@test.local', password: adminPassword })
        .expect(201)
    ).body.token;
    schedule = (
      await request(server())
        .get('/api/schedules')
        .set(auth(adminToken))
        .expect(200)
    ).body[0];
    employee = (
      await request(server())
        .post('/api/employees')
        .set(auth(adminToken))
        .send({
          nationalId: '00123456789012',
          name: 'Test Employee',
          email: 'employee@test.local',
          department: 'Engineering',
          jobTitle: 'Engineer',
          startDate: '2026-10-01',
          scheduleId: schedule.id,
          role: 'employee',
          active: true,
          password: employeePassword,
        })
        .expect(201)
    ).body;
    employeeToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: employee.email, password: employeePassword })
        .expect(201)
    ).body.token;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('keeps future assignments out of current attendance and preserves missing-day expectations', async () => {
    const next = (
      await request(server())
        .post('/api/schedules')
        .set(auth(adminToken))
        .send({
          name: 'Monday schedule',
          start: '11:00',
          end: '19:00',
          days: [1],
          graceMinutes: 15,
        })
        .expect(201)
    ).body;
    const changed = await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({
        ...fields(),
        scheduleId: next.id,
        scheduleEffectiveFrom: '2026-10-05',
      })
      .expect(200);
    expect(changed.body.scheduleId).toBe(schedule.id);
    const current = await request(server())
      .get('/api/attendance/me')
      .set(auth(employeeToken))
      .expect(200);
    expect(current.body.schedule.id).toBe(schedule.id);
    const history = await request(server())
      .get(`/api/employees/${employee.id}/schedules`)
      .set(auth(adminToken))
      .expect(200);
    expect(
      history.body.map((a: { effectiveFrom: string }) => a.effectiveFrom),
    ).toEqual(['2026-10-01', '2026-10-05']);
    await request(server())
      .get(`/api/employees/${employee.id}/schedules`)
      .set(auth(employeeToken))
      .expect(403);
    const rows = await request(server())
      .get('/api/attendance?from=2026-10-04&to=2026-10-06')
      .set(auth(adminToken))
      .expect(200);
    expect(rows.body.map((r: { workDate: string }) => r.workDate)).toEqual([
      '2026-10-05',
      '2026-10-04',
    ]);
    // Editing unrelated employee fields must not remove an upcoming assignment.
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), name: 'Updated name' })
      .expect(200);
    vi.setSystemTime(new Date('2026-10-05T07:00:00Z'));
    const token = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: employee.email, password: employeePassword })
        .expect(201)
    ).body.token;
    const active = await request(server())
      .get('/api/attendance/me')
      .set(auth(token))
      .expect(200);
    expect(active.body.schedule.id).toBe(next.id);
    expect(active.body.employee.scheduleId).toBe(next.id);
    const record = await submit('/api/attendance/check-in', token).expect(201);
    expect(record.body.schedule.id).toBe(next.id);
  });

  it('versions shared schedule edits and uses the old definition for historical manual entries', async () => {
    const record = await submit(
      '/api/attendance/check-in',
      employeeToken,
    ).expect(201);
    await request(server())
      .patch(`/api/schedules/${schedule.id}`)
      .set(auth(adminToken))
      .send({
        name: schedule.name,
        start: '11:00',
        end: '19:00',
        days: [1],
        graceMinutes: 15,
      })
      .expect(200);
    const rows = await request(server())
      .get('/api/attendance?from=2026-10-01&to=2026-10-04')
      .set(auth(adminToken))
      .expect(200);
    expect(
      rows.body.find((r: { workDate: string }) => r.workDate === '2026-10-01'),
    ).toMatchObject({ status: 'No record' });
    expect(
      rows.body.find((r: { id: string }) => r.id === record.body.id),
    ).toMatchObject({ status: 'On time' });
    const manual = await request(server())
      .post('/api/attendance')
      .set(auth(adminToken))
      .send({
        employeeId: employee.id,
        workDate: '2026-10-01',
        checkIn: '2026-10-01T07:00:00Z',
        checkOut: '2026-10-01T15:00:00Z',
        reason: 'Confirmed historical attendance',
      })
      .expect(201);
    expect(manual.body.schedule).toEqual(schedule);
  });

  it('rejects backdated and pre-employment assignments and rolls back assignment writes with audit failure', async () => {
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), scheduleEffectiveFrom: '2026-10-03' })
      .expect(400);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), scheduleEffectiveFrom: 'not-a-date' })
      .expect(400);
    const spy = vi
      .spyOn(app.get(AuditService), 'record')
      .mockImplementation(() => {
        throw new Error('Audit unavailable');
      });
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), scheduleEffectiveFrom: '2026-10-05' })
      .expect(500);
    spy.mockRestore();
    const history = await request(server())
      .get(`/api/employees/${employee.id}/schedules`)
      .set(auth(adminToken))
      .expect(200);
    expect(history.body).toHaveLength(1);
  });

  it('uses the previous workday schedule for overnight attendance across an assignment change', async () => {
    await request(server())
      .patch(`/api/schedules/${schedule.id}`)
      .set(auth(adminToken))
      .send({
        name: 'Night shift',
        start: '22:00',
        end: '06:00',
        days: [0, 1, 2, 3, 4],
        graceMinutes: 15,
      })
      .expect(200);
    const sales = (
      await request(server())
        .get('/api/schedules')
        .set(auth(adminToken))
        .expect(200)
    ).body[1];
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({
        ...fields(),
        scheduleId: sales.id,
        scheduleEffectiveFrom: '2026-10-05',
      })
      .expect(200);
    vi.setSystemTime(new Date('2026-10-04T22:30:00Z')); // October 5, 01:30 in Cairo.
    const token = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: employee.email, password: employeePassword })
        .expect(201)
    ).body.token;
    const current = await request(server())
      .get('/api/attendance/me')
      .set(auth(token))
      .expect(200);
    expect(current.body.workDate).toBe('2026-10-04');
    expect(current.body.schedule.start).toBe('22:00');
    const record = await submit('/api/attendance/check-in', token).expect(201);
    expect(record.body.workDate).toBe('2026-10-04');
    expect(record.body.schedule.start).toBe('22:00');
  });

  it('validates Excuse shifts against each requested date', async () => {
    const sales = (
      await request(server())
        .get('/api/schedules')
        .set(auth(adminToken))
        .expect(200)
    ).body[1];
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({
        ...fields(),
        scheduleId: sales.id,
        scheduleEffectiveFrom: '2026-10-05',
      })
      .expect(200);
    const excuse = {
      type: 'excuse',
      from: '2026-10-05',
      to: '2026-10-05',
      durationMinutes: 30,
      excuseType: 'arriving-late',
      shiftId: sales.id,
    };
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(excuse)
      .expect(201);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({ ...excuse, from: '2026-10-04', shiftId: schedule.id })
      .expect(400);
  });

  it('generates sequential employee numbers and preserves them on edits', async () => {
    expect(employee.employeeNumber).toBe('EMP-000001');
    const second = await request(server())
      .post('/api/employees')
      .set(auth(adminToken))
      .send({
        ...fields(),
        nationalId: '00987654321098',
        email: 'second@test.local',
        password: employeePassword,
      })
      .expect(201);
    expect(second.body.employeeNumber).toBe('EMP-000002');
    const updated = await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), name: 'Updated Employee' })
      .expect(200);
    expect(updated.body.employeeNumber).toBe(employee.employeeNumber);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), employeeNumber: 'EMP-999999' })
      .expect(400);
  });

  it('calculates monthly payroll with vacation deductions once per decision', async () => {
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), monthlySalary: 3000.01, salaryCurrency: 'EGP' })
      .expect(200);
    for (const [date, status] of [
      ['2026-10-04', 'approved'],
      ['2026-10-08', 'rejected'],
    ]) {
      const pending = await request(server())
        .post('/api/requests')
        .set(auth(employeeToken))
        .send({
          type: 'leave',
          from: date,
          to: date,
          reason: 'Family vacation',
        })
        .expect(201);
      await request(server())
        .patch(`/api/requests/${pending.body.id}/decision`)
        .set(auth(adminToken))
        .send({ status, reason: 'HR vacation decision' })
        .expect(200);
      await request(server())
        .patch(`/api/requests/${pending.body.id}/decision`)
        .set(auth(adminToken))
        .send({ status, reason: 'Repeated HR decision' })
        .expect(409);
    }
    const payroll = await request(server())
      .get('/api/payroll?month=2026-10')
      .set(auth(adminToken))
      .expect(200);
    expect(payroll.body).toHaveLength(1);
    expect(payroll.body[0]).toMatchObject({
      employeeNumber: employee.employeeNumber,
      currency: 'EGP',
      grossSalary: 3000.01,
      dailyRate: 100,
      deductionDays: 4,
      deductionAmount: 400,
      netSalary: 2600.01,
    });
    expect(payroll.body[0].deductions).toHaveLength(2);
    const nextMonth = await request(server())
      .get('/api/payroll?month=2026-11')
      .set(auth(adminToken))
      .expect(200);
    expect(nextMonth.body[0]).toMatchObject({
      deductionDays: 0,
      deductionAmount: 0,
      netSalary: 3000.01,
    });
  });

  it('uses the company decision month and rounds the total deduction once', async () => {
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), monthlySalary: 1000, salaryCurrency: 'USD' })
      .expect(200);
    const pending = await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        type: 'holiday',
        from: '2026-10-04',
        to: '2026-10-08',
        reason: 'Family vacation',
      })
      .expect(201);
    vi.setSystemTime(new Date('2026-10-31T22:30:00Z'));
    const token = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: 'admin@test.local', password: adminPassword })
        .expect(201)
    ).body.token;
    await request(server())
      .patch(`/api/requests/${pending.body.id}/decision`)
      .set(auth(token))
      .send({ status: 'rejected', reason: 'HR vacation decision' })
      .expect(200);
    const october = await request(server())
      .get('/api/payroll?month=2026-10')
      .set(auth(token))
      .expect(200);
    expect(october.body[0].deductionDays).toBe(0);
    const november = await request(server())
      .get('/api/payroll?month=2026-11')
      .set(auth(token))
      .expect(200);
    expect(november.body[0]).toMatchObject({
      dailyRate: 33.33,
      deductionDays: 3,
      deductionAmount: 100,
      netSalary: 900,
    });
  });

  it('lets HR record manual deductions with reasons and approvers alongside vacation deductions', async () => {
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), monthlySalary: 3000 })
      .expect(200);
    await request(server())
      .post('/api/employees')
      .set(auth(adminToken))
      .send({
        ...fields(),
        nationalId: '987654321',
        email: 'payroll-hr@test.local',
        name: 'Payroll HR',
        role: 'hr',
        password: employeePassword,
      })
      .expect(201);
    const hrToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: 'payroll-hr@test.local', password: employeePassword })
        .expect(201)
    ).body.token;
    const deduction = await request(server())
      .post('/api/payroll/deductions')
      .set(auth(hrToken))
      .send({
        employeeId: employee.id,
        month: '2026-10',
        days: 2,
        reason: '  Unexcused absence  ',
        approvedBy: '  Operations Director  ',
      })
      .expect(201);
    expect(deduction.body).toMatchObject({
      days: 2,
      reason: 'Unexcused absence',
      approvedBy: 'Operations Director',
      recordedBy: 'Payroll HR',
      month: '2026-10',
    });
    const pending = await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        type: 'leave',
        from: '2026-10-04',
        to: '2026-10-04',
        reason: 'Family vacation',
      })
      .expect(201);
    await request(server())
      .patch(`/api/requests/${pending.body.id}/decision`)
      .set(auth(hrToken))
      .send({ status: 'approved', reason: 'HR vacation decision' })
      .expect(200);
    const preview = await request(server())
      .get('/api/payroll?month=2026-10')
      .set(auth(hrToken))
      .expect(200);
    const row = preview.body.find(
      (item: { employeeId: string }) => item.employeeId === employee.id,
    );
    expect(row).toMatchObject({
      deductionDays: 3,
      deductionAmount: 300,
      netSalary: 2700,
    });
    expect(row.manualDeductions).toEqual([deduction.body]);
    expect(row.deductions).toHaveLength(1);
    const november = await request(server())
      .get('/api/payroll?month=2026-11')
      .set(auth(hrToken))
      .expect(200);
    expect(
      november.body.find(
        (item: { employeeId: string }) => item.employeeId === employee.id,
      ).deductionDays,
    ).toBe(0);
    const audit = await request(server())
      .get(`/api/audit?recordId=${deduction.body.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(audit.body[0]).toMatchObject({
      action: 'payroll.deduction.created',
      actor: 'Payroll HR',
      reason: 'Unexcused absence',
      after: { approvedBy: 'Operations Director' },
    });
  });

  it('requires valid deduction details and prevents employee access', async () => {
    const body = {
      employeeId: employee.id,
      month: '2026-10',
      days: 1,
      reason: 'Unexcused absence',
      approvedBy: 'Department Manager',
    };
    await request(server())
      .post('/api/payroll/deductions')
      .send(body)
      .expect(401);
    await request(server())
      .post('/api/payroll/deductions')
      .set(auth(employeeToken))
      .send(body)
      .expect(403);
    for (const changes of [
      { reason: undefined },
      { reason: '   ' },
      { approvedBy: undefined },
      { approvedBy: '   ' },
      { days: 0 },
      { days: -1 },
      { days: 1.5 },
      { days: '2' },
      { month: '2026-13' },
      { month: '2026-09' },
      { employeeId: 'bad-id' },
      { recordedBy: 'Spoofed HR' },
    ]) {
      await request(server())
        .post('/api/payroll/deductions')
        .set(auth(adminToken))
        .send({ ...body, ...changes })
        .expect(400);
    }
    await request(server())
      .post('/api/payroll/deductions')
      .set(auth(adminToken))
      .send({ ...body, employeeId: '00000000-0000-4000-8000-000000000001' })
      .expect(404);
    expect(
      app
        .get(DatabaseService)
        .db.prepare('SELECT COUNT(*) AS count FROM payroll_deductions')
        .get()!.count,
    ).toBe(0);
  });

  it('rolls back a manual deduction if its audit cannot be recorded', () => {
    const actor = app
      .get(DatabaseService)
      .db.prepare('SELECT id FROM users WHERE email = ?')
      .get('admin@test.local')!;
    vi.spyOn(app.get(AuditService), 'record').mockImplementationOnce(() => {
      throw new Error('Audit failed');
    });
    expect(() =>
      app.get(PayrollService).addDeduction(
        {
          id: actor.id as string,
          name: 'Company Administrator',
          email: 'admin@test.local',
          role: 'admin',
          employeeId: null,
        },
        {
          employeeId: employee.id,
          month: '2026-10',
          days: 1,
          reason: 'Unexcused absence',
          approvedBy: 'Department Manager',
        },
      ),
    ).toThrow('Audit failed');
    expect(
      app
        .get(DatabaseService)
        .db.prepare('SELECT COUNT(*) AS count FROM payroll_deductions')
        .get()!.count,
    ).toBe(0);
  });

  it('protects payroll access and validates salary and month inputs', async () => {
    await request(server()).get('/api/payroll?month=2026-10').expect(401);
    await request(server())
      .get('/api/payroll?month=2026-10')
      .set(auth(employeeToken))
      .expect(403);
    for (const month of ['', '2026-13', '2026-00', '2026-1', 'wrong']) {
      await request(server())
        .get(`/api/payroll?month=${month}`)
        .set(auth(adminToken))
        .expect(400);
    }
    for (const monthlySalary of [-1, 100.001, '100', 1000000001]) {
      await request(server())
        .patch(`/api/employees/${employee.id}`)
        .set(auth(adminToken))
        .send({ ...fields(), monthlySalary })
        .expect(400);
    }
    const missing = await request(server())
      .get('/api/payroll?month=2026-10')
      .set(auth(adminToken))
      .expect(200);
    expect(missing.body[0]).toMatchObject({
      grossSalary: null,
      deductionAmount: null,
      netSalary: null,
    });
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), monthlySalary: 0 })
      .expect(200);
    const zero = await request(server())
      .get('/api/payroll?month=2026-10')
      .set(auth(adminToken))
      .expect(200);
    expect(zero.body[0]).toMatchObject({ grossSalary: 0, netSalary: 0 });
    const earlier = await request(server())
      .get('/api/payroll?month=2026-09')
      .set(auth(adminToken))
      .expect(200);
    expect(earlier.body).toHaveLength(0);
  });

  it('preserves national IDs as strings and rejects missing or duplicate IDs', async () => {
    expect(employee.nationalId).toBe('00123456789012');
    const response = await request(server())
      .get('/api/employees')
      .set(auth(adminToken))
      .expect(200);
    expect(response.body[0].nationalId).toBe('00123456789012');
    expect(response.body[0]).not.toHaveProperty('employeeCode');
    await request(server())
      .post('/api/employees')
      .set(auth(adminToken))
      .send({
        ...fields(),
        name: 'Duplicate ID',
        email: 'duplicate@test.local',
        password: employeePassword,
      })
      .expect(409);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({
        ...fields(),
        nationalId: '   ',
      })
      .expect(400);
  });

  it('submits private time-off requests and applies only approved requests to reports', async () => {
    const result = await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        type: 'leave',
        from: '2026-10-04',
        to: '2026-10-05',
        reason: 'Family appointment',
      })
      .expect(201);
    const pending = result.body;
    expect(pending.status).toBe('pending');
    expect(pending.salaryDeductionDays).toBeNull();
    expect(pending.employeeId).toBe(employee.id);
    await request(server())
      .get('/api/requests')
      .set(auth(employeeToken))
      .expect(403);
    const mine = await request(server())
      .get('/api/requests/me')
      .set(auth(employeeToken))
      .expect(200);
    expect(mine.body).toHaveLength(1);
    const before = await request(server())
      .get('/api/attendance?from=2026-10-04&to=2026-10-05')
      .set(auth(adminToken))
      .expect(200);
    expect(
      before.body.every((r: { status: string }) => r.status === 'No record'),
    ).toBe(true);
    await request(server())
      .patch(`/api/requests/${pending.id}/decision`)
      .set(auth(employeeToken))
      .send({ status: 'approved', reason: 'Approved for time off' })
      .expect(403);
    const approved = await request(server())
      .patch(`/api/requests/${pending.id}/decision`)
      .set(auth(adminToken))
      .send({ status: 'approved', reason: 'Approved for time off' })
      .expect(200);
    expect(approved.body.decidedBy).toBe('Company Administrator');
    expect(approved.body.salaryDeductionDays).toBe(1);
    const after = await request(server())
      .get(
        '/api/attendance?from=2026-10-04&to=2026-10-05&status=Approved%20leave',
      )
      .set(auth(adminToken))
      .expect(200);
    expect(after.body).toHaveLength(2);
    expect(
      after.body.every(
        (r: { status: string }) => r.status === 'Approved leave',
      ),
    ).toBe(true);
    await request(server())
      .patch(`/api/requests/${pending.id}/decision`)
      .set(auth(adminToken))
      .send({ status: 'rejected', reason: 'Changed decision later' })
      .expect(409);
    const audit = await request(server())
      .get(`/api/audit?recordId=${pending.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(audit.body.map((a: { action: string }) => a.action)).toContain(
      'request.approved',
    );
  });

  it('deducts three salary days per rejected vacation and prevents repeated deductions', async () => {
    const pending = await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        type: 'leave',
        from: '2026-10-04',
        to: '2026-10-08',
        reason: 'Family vacation',
      })
      .expect(201);
    await request(server())
      .patch(`/api/requests/${pending.body.id}/decision`)
      .set(auth(adminToken))
      .send({
        status: 'rejected',
        reason: 'Insufficient staffing',
        salaryDeductionDays: 1,
      })
      .expect(400);
    const rejected = await request(server())
      .patch(`/api/requests/${pending.body.id}/decision`)
      .set(auth(adminToken))
      .send({ status: 'rejected', reason: 'Insufficient staffing' })
      .expect(200);
    expect(rejected.body.salaryDeductionDays).toBe(3);
    for (const status of ['approved', 'rejected']) {
      await request(server())
        .patch(`/api/requests/${pending.body.id}/decision`)
        .set(auth(adminToken))
        .send({ status, reason: 'Repeated HR decision' })
        .expect(409);
    }
    const mine = await request(server())
      .get('/api/requests/me')
      .set(auth(employeeToken))
      .expect(200);
    expect(mine.body[0].salaryDeductionDays).toBe(3);
    const audit = await request(server())
      .get(`/api/audit?recordId=${pending.body.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(
      audit.body.filter(
        (entry: { action: string }) => entry.action === 'request.rejected',
      ),
    ).toHaveLength(1);
    expect(audit.body[0].after.salaryDeductionDays).toBe(3);
  });

  it('rejects overlaps and malformed requests, and allows resubmission after rejection', async () => {
    const body = {
      type: 'holiday',
      from: '2026-10-04',
      to: '2026-10-04',
      reason: 'Personal holiday day',
    };
    await request(server()).post('/api/requests').send(body).expect(401);
    for (const invalid of [
      { ...body, employeeId: employee.id },
      { ...body, to: '2026-10-03' },
      { ...body, from: '2026-02-30' },
      { ...body, reason: 'no' },
      { ...body, to: '2027-10-04' },
      { ...body, from: '2026-09-30' },
    ]) {
      await request(server())
        .post('/api/requests')
        .set(auth(employeeToken))
        .send(invalid)
        .expect(400);
    }
    const result = await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(body)
      .expect(201);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({ ...body, type: 'leave' })
      .expect(409);
    await request(server())
      .patch(`/api/requests/${result.body.id}/decision`)
      .set(auth(adminToken))
      .send({ status: 'rejected', reason: 'Insufficient staffing' })
      .expect(200);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(body)
      .expect(201);
    const report = await request(server())
      .get('/api/attendance?from=2026-10-04&to=2026-10-04')
      .set(auth(adminToken))
      .expect(200);
    expect(report.body[0].status).toBe('No record');
  });

  it('approves forgotten check-outs atomically with the attendance correction audit', async () => {
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
    ).body;
    vi.setSystemTime(new Date('2026-10-04T16:00:00Z'));
    const body = {
      type: 'forgotten-check-out',
      attendanceId: record.id,
      proposedCheckOut: '2026-10-04T15:00:00Z',
      reason: 'Forgot to check out when leaving',
    };
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({ ...body, proposedCheckOut: '2026-10-05T15:00:00Z' })
      .expect(400);
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({ ...body, proposedCheckOut: '2026-10-04T06:00:00Z' })
      .expect(400);
    const pending = (
      await request(server())
        .post('/api/requests')
        .set(auth(employeeToken))
        .send(body)
        .expect(201)
    ).body;
    expect(pending.attendance.checkIn).toBe(record.checkIn);
    expect(pending.salaryDeductionDays).toBeNull();
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send(body)
      .expect(409);
    const before = await request(server())
      .get('/api/attendance/me')
      .set(auth(employeeToken))
      .expect(200);
    expect(before.body.records[0].checkOut).toBeNull();
    await request(server())
      .patch(`/api/requests/${pending.id}/decision`)
      .set(auth(adminToken))
      .send({ status: 'approved', reason: 'Departure confirmed by HR' })
      .expect(200);
    const after = await request(server())
      .get('/api/attendance/me')
      .set(auth(employeeToken))
      .expect(200);
    expect(after.body.records[0].checkOut).toBe('2026-10-04T15:00:00.000Z');
    const requests = await request(server())
      .get('/api/requests/me')
      .set(auth(employeeToken))
      .expect(200);
    expect(requests.body[0].salaryDeductionDays).toBeNull();
    const history = await request(server())
      .get(`/api/audit?recordId=${record.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(history.body[0].action).toBe('attendance.corrected');
    expect(history.body[0].reason).toContain(pending.id);
    const evidence = await request(server())
      .get(`/api/attendance/${record.id}/evidence`)
      .set(auth(adminToken))
      .expect(200);
    expect(evidence.body).toHaveLength(1);
  });

  it('leaves a stale correction request pending if attendance was already closed', async () => {
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
    ).body;
    vi.setSystemTime(new Date('2026-10-04T16:00:00Z'));
    const pending = (
      await request(server())
        .post('/api/requests')
        .set(auth(employeeToken))
        .send({
          type: 'forgotten-check-out',
          attendanceId: record.id,
          proposedCheckOut: '2026-10-04T15:00:00Z',
          reason: 'Forgot departure submission',
        })
        .expect(201)
    ).body;
    await submit(
      `/api/attendance/${record.id}/check-out`,
      employeeToken,
    ).expect(201);
    await request(server())
      .patch(`/api/requests/${pending.id}/decision`)
      .set(auth(adminToken))
      .send({ status: 'approved', reason: 'Departure confirmed by HR' })
      .expect(409);
    const mine = await request(server())
      .get('/api/requests/me')
      .set(auth(employeeToken))
      .expect(200);
    expect(mine.body[0].status).toBe('pending');
  });

  it('prevents HR deciding their own request and isolates employee request histories', async () => {
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), role: 'hr' })
      .expect(200);
    const hrToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: employee.email, password: employeePassword })
        .expect(201)
    ).body.token;
    const pending = (
      await request(server())
        .post('/api/requests')
        .set(auth(hrToken))
        .send({
          type: 'leave',
          from: '2026-10-04',
          to: '2026-10-04',
          reason: 'Family appointment',
        })
        .expect(201)
    ).body;
    await request(server())
      .patch(`/api/requests/${pending.id}/decision`)
      .set(auth(hrToken))
      .send({ status: 'approved', reason: 'Approving my own request' })
      .expect(403);
    const other = (
      await request(server())
        .post('/api/employees')
        .set(auth(adminToken))
        .send({
          ...fields(),
          nationalId: 'EMP-002',
          email: 'other@test.local',
          role: 'employee',
          password: employeePassword,
        })
        .expect(201)
    ).body;
    const otherToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: other.email, password: employeePassword })
        .expect(201)
    ).body.token;
    const mine = await request(server())
      .get('/api/requests/me')
      .set(auth(otherToken))
      .expect(200);
    expect(mine.body).toEqual([]);
    const record = (
      await submit('/api/attendance/check-in', hrToken).expect(201)
    ).body;
    await request(server())
      .post('/api/requests')
      .set(auth(otherToken))
      .send({
        type: 'forgotten-check-out',
        attendanceId: record.id,
        proposedCheckOut: record.checkIn,
        reason: 'Trying another employee record',
      })
      .expect(404);
  });

  it('shows approved holidays without overriding recorded attendance or extending to weekends', async () => {
    const pending = (
      await request(server())
        .post('/api/requests')
        .set(auth(employeeToken))
        .send({
          type: 'holiday',
          from: '2026-10-04',
          to: '2026-10-10',
          reason: 'Personal holiday week',
        })
        .expect(201)
    ).body;
    await request(server())
      .patch(`/api/requests/${pending.id}/decision`)
      .set(auth(adminToken))
      .send({ status: 'approved', reason: 'Approved personal holiday' })
      .expect(200);
    const before = await request(server())
      .get('/api/attendance?from=2026-10-04&to=2026-10-10')
      .set(auth(adminToken))
      .expect(200);
    expect(before.body).toHaveLength(5);
    expect(
      before.body.every(
        (r: { status: string }) => r.status === 'Approved holiday',
      ),
    ).toBe(true);
    await submit('/api/attendance/check-in', employeeToken).expect(201);
    const after = await request(server())
      .get('/api/attendance?from=2026-10-04&to=2026-10-04')
      .set(auth(adminToken))
      .expect(200);
    expect(after.body[0].status).toBe('On time');
    await request(server())
      .post('/api/requests')
      .set(auth(employeeToken))
      .send({
        type: 'leave',
        from: '2026-10-05',
        to: '2026-10-05',
        reason: 'Overlapping leave day',
      })
      .expect(409);
  });

  it('rolls back request and attendance together if the decision audit fails', async () => {
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
    ).body;
    vi.setSystemTime(new Date('2026-10-04T16:00:00Z'));
    const pending = (
      await request(server())
        .post('/api/requests')
        .set(auth(employeeToken))
        .send({
          type: 'forgotten-check-out',
          attendanceId: record.id,
          proposedCheckOut: '2026-10-04T15:00:00Z',
          reason: 'Forgot departure submission',
        })
        .expect(201)
    ).body;
    app.get(DatabaseService).db
      .exec(`CREATE TEMP TRIGGER fail_decision_audit BEFORE INSERT ON audit
      WHEN NEW.action = 'request.approved' BEGIN SELECT RAISE(ABORT, 'Audit failed'); END;`);
    const authService = app.get(AuthService);
    const auditBefore = app
      .get(AuditService)
      .auditHistory(authService.authenticate(adminToken), record.id);
    expect(() =>
      app
        .get(RequestsService)
        .decideRequest(authService.authenticate(adminToken), pending.id, {
          status: 'approved',
          reason: 'Departure confirmed by HR',
        }),
    ).toThrow('Audit failed');
    expect(
      app
        .get(RequestsService)
        .requests(authService.authenticate(employeeToken), true)[0].status,
    ).toBe('pending');
    expect(
      app
        .get(AttendanceService)
        .myAttendance(authService.authenticate(employeeToken)).records[0]
        .checkOut,
    ).toBeNull();
    expect(
      app
        .get(AuditService)
        .auditHistory(authService.authenticate(adminToken), record.id),
    ).toEqual(auditBefore);
  });

  it('requires authentication, isolates employee access, and permits cookie sessions', async () => {
    const directory = await request(server()).get('/api/employees').set(auth(adminToken)).expect(200);
    const linked = directory.body.find((row: { id: string }) => row.id === employee.id);
    expect(linked.accountId).toBe(app.get(AuthService).authenticate(employeeToken).id);
    expect(linked.accountId).not.toBe(employee.id);
    expect(linked).not.toHaveProperty('password_hash');

    await request(server()).get('/api/health').expect(200, { status: 'ok' });
    for (const route of [
      '/api/schedules',
      '/api/attendance/policy',
      '/api/requests',
      '/api/audit',
    ]) {
      await request(server()).get(route).expect(401);
    }
    await request(server()).get('/api/employees').expect(401);
    await request(server())
      .get('/api/employees')
      .set(auth(employeeToken))
      .expect(403);
    await request(server())
      .get('/api/attendance')
      .set(auth(employeeToken))
      .expect(403);
    await request(server())
      .get('/api/audit')
      .set(auth(employeeToken))
      .expect(403);
    await request(server())
      .patch('/api/settings')
      .set(auth(employeeToken))
      .send({ name: 'Changed', timezone: 'UTC' })
      .expect(403);
    const agent = request.agent(server());
    const login = await agent
      .post('/api/auth/login')
      .send({ email: employee.email, password: employeePassword })
      .expect(201);
    expect(login.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(
      (await agent.get('/api/auth/me').expect(200)).body.user.employeeId,
    ).toBe(employee.id);
    await agent.post('/api/auth/logout').expect(201);
    await agent.get('/api/auth/me').expect(401);
  });

  it('rejects a login if credentials change during password verification', async () => {
    const authService = app.get(AuthService);
    const db = app.get(DatabaseService).db;
    const user = db
      .prepare('SELECT id FROM users WHERE employee_id = ?')
      .get(employee.id)!;
    const before = db
      .prepare('SELECT COUNT(*) AS total FROM sessions WHERE user_id = ?')
      .get(user.id)!;
    const pending = authService.login(employee.email, employeePassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      `${'0'.repeat(32)}:${'0'.repeat(128)}`,
      user.id,
    );
    await expect(pending).rejects.toThrow('Invalid email or password');
    expect(
      db
        .prepare('SELECT COUNT(*) AS total FROM sessions WHERE user_id = ?')
        .get(user.id)?.total,
    ).toBe(before.total);
  });

  it('blocks untrusted browser origins, even on login', async () => {
    await request(server())
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: employee.email, password: employeePassword })
      .expect(403);
    await submit('/api/attendance/check-in', employeeToken)
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);
  });

  it('records server time and makes concurrent check-in/check-out retries idempotent', async () => {
    const responses = await Promise.all([
      submit('/api/attendance/check-in', employeeToken),
      submit('/api/attendance/check-in', employeeToken),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(responses[0].body.id).toBe(responses[1].body.id);
    expect(responses[0].body.checkIn).toBe('2026-10-04T07:00:00.000Z');
    const id = responses[0].body.id;
    vi.setSystemTime(new Date('2026-10-04T14:00:00Z'));
    const first = await submit(
      `/api/attendance/${id}/check-out`,
      employeeToken,
    ).expect(201);
    vi.setSystemTime(new Date('2026-10-04T15:00:00Z'));
    const repeated = await submit(
      `/api/attendance/${id}/check-out`,
      employeeToken,
    ).expect(201);
    expect(repeated.body.checkOut).toBe(first.body.checkOut);
    expect(
      (
        await request(server())
          .get('/api/attendance/me')
          .set(auth(employeeToken))
      ).body.records,
    ).toHaveLength(1);
    expect(
      (await submit('/api/attendance/check-in', employeeToken)).body.id,
    ).toBe(id);
    await submit(`/api/attendance/${id}/check-out`, adminToken).expect(400);
  });

  it('requires location and photo evidence for both employee events', async () => {
    await request(server())
      .post('/api/attendance/check-in')
      .set(auth(employeeToken))
      .expect(400);
    await request(server())
      .post('/api/attendance/check-in')
      .set(auth(employeeToken))
      .field('latitude', '30.023092')
      .field('longitude', '31.528179')
      .field('accuracyMeters', '10')
      .field('capturedAt', new Date().toISOString())
      .expect(400);
    await submit(
      '/api/attendance/check-in',
      employeeToken,
      {},
      Buffer.from('not a photograph'),
    ).expect(400);
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
    ).body;
    await request(server())
      .post(`/api/attendance/${record.id}/check-out`)
      .set(auth(employeeToken))
      .expect(400);
    expect(
      (
        await request(server())
          .get('/api/attendance/me')
          .set(auth(employeeToken))
      ).body.records[0].checkOut,
    ).toBeNull();
  });

  it('rejects outside-office events and rejects stale, future, inaccurate, or invalid positions', async () => {
    await submit('/api/attendance/check-in', employeeToken, {
      latitude: '30.025092',
    }).expect(403);
    await submit('/api/attendance/check-in', employeeToken, {
      accuracyMeters: '51',
    }).expect(400);
    await submit('/api/attendance/check-in', employeeToken, {
      latitude: 'NaN',
    }).expect(400);
    await submit('/api/attendance/check-in', employeeToken, {
      longitude: '181',
    }).expect(400);
    await submit('/api/attendance/check-in', employeeToken, {
      capturedAt: '2026-10-04T06:57:00Z',
    }).expect(400);
    await submit('/api/attendance/check-in', employeeToken, {
      capturedAt: '2026-10-04T07:01:00Z',
    }).expect(400);
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
    ).body;
    await submit(`/api/attendance/${record.id}/check-out`, employeeToken, {
      latitude: '30.025092',
    }).expect(403);
    expect(
      (
        await request(server())
          .get('/api/attendance/me')
          .set(auth(employeeToken))
      ).body.records[0].checkOut,
    ).toBeNull();
  });

  it('limits photo uploads and rejects duplicate photo fields', async () => {
    await submit(
      '/api/attendance/check-in',
      employeeToken,
      {},
      Buffer.alloc(5 * 1024 * 1024 + 1),
    ).expect(413);
    await submit('/api/attendance/check-in', employeeToken)
      .attach('photo', photo, 'second.png')
      .expect(400);
    expect(
      (
        await request(server())
          .get('/api/attendance/me')
          .set(auth(employeeToken))
      ).body.records,
    ).toHaveLength(0);
  });

  it('stores private, normalized photos and keeps the original evidence on retries', async () => {
    const landscape = await sharp({
      create: { width: 1920, height: 1080, channels: 3, background: '#0000ff' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const record = (
      await submit(
        '/api/attendance/check-in',
        employeeToken,
        {},
        landscape,
      ).expect(201)
    ).body;
    const path = `/api/attendance/${record.id}`;
    const first = await request(server())
      .get(`${path}/photos/check-in`)
      .set(auth(employeeToken))
      .expect(200);
    expect(first.headers['content-type']).toContain('image/jpeg');
    expect(first.headers['cache-control']).toBe('private, no-store');
    const metadata = await sharp(first.body as Buffer).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(720);
    expect(metadata.height).toBe(1280);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    const alternative = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    await submit(
      '/api/attendance/check-in',
      employeeToken,
      {},
      alternative,
    ).expect(201);
    expect(
      (
        await request(server())
          .get(`${path}/photos/check-in`)
          .set(auth(employeeToken))
      ).body,
    ).toEqual(first.body);
    await submit(`${path}/check-out`, employeeToken).expect(201);
    await submit(`${path}/check-out`, employeeToken).expect(201);
    const evidence = (
      await request(server())
        .get(`${path}/evidence`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    expect(evidence).toHaveLength(2);
    const attendanceAudit = app
      .get(AuditService)
      .auditHistory(app.get(AuthService).authenticate(adminToken), record.id);
    expect(attendanceAudit.map((entry) => entry.action)).toEqual([
      'attendance.checked_out',
      'attendance.checked_in',
    ]);
    expect(attendanceAudit[0].before).toMatchObject({ checkOut: null });
    expect(attendanceAudit[0].after).toMatchObject({ id: record.id });
    expect(evidence[0].policy.radiusMeters).toBe(50);
    expect(evidence[0].distanceMeters).toBe(0);
    await request(server()).get(`${path}/photos/check-in`).expect(401);
    await request(server())
      .get(`${path}/photos/check-out`)
      .set(auth(adminToken))
      .expect(200);
  });

  it('rolls attendance back if evidence cannot be committed', () => {
    const authService = app.get(AuthService);
    const db = app.get(DatabaseService).db;
    vi.spyOn(app.get(AttendanceEvidence), 'save').mockImplementationOnce(() => {
      throw new Error('Storage failure');
    });
    expect(() =>
      app
        .get(AttendanceService)
        .checkIn(authService.authenticate(employeeToken), {
          latitude: 30.023092,
          longitude: 31.528179,
          accuracyMeters: 10,
          capturedAt: new Date().toISOString(),
          distanceMeters: 0,
          photo,
        }),
    ).toThrow('Storage failure');
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM attendance').get()?.count,
    ).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM attendance_evidence').get()
        ?.count,
    ).toBe(0);
  });

  it('does not allow another employee to close a record', async () => {
    const record = (await submit('/api/attendance/check-in', employeeToken))
      .body;
    const other = (
      await request(server())
        .post('/api/employees')
        .set(auth(adminToken))
        .send({
          ...fields(),
          nationalId: 'EMP-002',
          name: 'Another Employee',
          email: 'other@test.local',
          password: employeePassword,
        })
        .expect(201)
    ).body;
    const token = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: other.email, password: employeePassword })
    ).body.token;
    await submit(`/api/attendance/${record.id}/check-out`, token).expect(404);
    await request(server())
      .get(`/api/attendance/${record.id}/photos/check-in`)
      .set(auth(token))
      .expect(404);
    await request(server())
      .get(`/api/attendance/${record.id}/evidence`)
      .set(auth(token))
      .expect(404);
    const mine = (
      await request(server()).get('/api/attendance/me').set(auth(token))
    ).body.records;
    expect(mine).toHaveLength(0);
  });

  it('keeps history after deactivation and revokes existing sessions', async () => {
    await submit('/api/attendance/check-in', employeeToken).expect(201);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), active: false })
      .expect(200);
    await request(server())
      .get('/api/attendance/me')
      .set(auth(employeeToken))
      .expect(401);
    await request(server())
      .post('/api/auth/login')
      .send({ email: employee.email, password: employeePassword })
      .expect(401);
    expect(
      (
        await request(server())
          .get('/api/attendance?from=2026-10-04&to=2026-10-04')
          .set(auth(adminToken))
      ).body,
    ).toHaveLength(1);
  });

  it('validates unique accounts, passwords, dates, and unknown fields', async () => {
    await request(server())
      .post('/api/employees')
      .set(auth(adminToken))
      .send({ ...fields(), password: employeePassword })
      .expect(409);
    await request(server())
      .post('/api/employees')
      .set(auth(adminToken))
      .send({
        ...fields(),
        nationalId: 'EMP-002',
        email: 'two@test.local',
        password: 'short',
      })
      .expect(400);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), startDate: '2026-02-30' })
      .expect(400);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), salary: 1000 })
      .expect(400);
    await request(server())
      .get('/api/attendance?from=2026-01-01&to=2026-12-31')
      .set(auth(adminToken))
      .expect(400);
  });

  it('snapshots schedules and audits corrections with the original values', async () => {
    const record = (await submit('/api/attendance/check-in', employeeToken))
      .body;
    const { id: _id, ...shift } = schedule;
    await request(server())
      .patch(`/api/schedules/${schedule.id}`)
      .set(auth(adminToken))
      .send({ ...shift, start: '12:00' })
      .expect(200);
    vi.setSystemTime(new Date('2026-10-04T15:00:00Z'));
    await request(server())
      .patch(`/api/attendance/${record.id}`)
      .set(auth(employeeToken))
      .send({
        checkIn: record.checkIn,
        checkOut: '2026-10-04T14:00:00Z',
        reason: 'Confirmed departure',
      })
      .expect(403);
    const corrected = await request(server())
      .patch(`/api/attendance/${record.id}`)
      .set(auth(adminToken))
      .send({
        checkIn: '2026-10-04T06:00:00Z',
        checkOut: '2026-10-04T14:00:00Z',
        reason: 'Confirmed with employee',
      })
      .expect(200);
    expect(corrected.body.schedule.start).toBe('10:00');
    const audit = (
      await request(server())
        .get(`/api/audit?recordId=${record.id}`)
        .set(auth(adminToken))
    ).body;
    expect(audit[0].before.checkIn).toBe(record.checkIn);
    expect(audit[0].after.checkIn).toBe('2026-10-04T06:00:00.000Z');
    expect(audit[0].reason).toBe('Confirmed with employee');
    await request(server())
      .patch(`/api/attendance/${record.id}`)
      .set(auth(adminToken))
      .send({
        checkIn: '2026-10-03T06:00:00Z',
        checkOut: null,
        reason: 'Wrong calendar day',
      })
      .expect(400);
    await request(server())
      .patch(`/api/attendance/${record.id}`)
      .set(auth(adminToken))
      .send({
        checkIn: '2026-10-04T16:00:00Z',
        checkOut: null,
        reason: 'Future check-in time',
      })
      .expect(400);
  });

  it.each(['withdrawn', 'rejected', 'approved'])(
    'allows a new workday with a pending forgotten check-out, then handles %s',
    async (status) => {
      const db = app.get(DatabaseService).db;
      db.exec(
        'CREATE UNIQUE INDEX one_open_interval ON attendance(employee_id) WHERE check_out IS NULL',
      );
      db.exec(DATABASE_SCHEMA);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'one_open_interval'",
          )
          .get(),
      ).toBeUndefined();
      const yesterday = (
        await submit('/api/attendance/check-in', employeeToken).expect(201)
      ).body;
      vi.setSystemTime(new Date('2026-10-05T07:00:00Z'));
      employeeToken = (
        await request(server())
          .post('/api/auth/login')
          .send({ email: employee.email, password: employeePassword })
      ).body.token;
      await submit('/api/attendance/check-in', employeeToken).expect(409);
      const pending = (
        await request(server())
          .post('/api/requests')
          .set(auth(employeeToken))
          .send({
            type: 'forgotten-check-out',
            attendanceId: yesterday.id,
            proposedCheckOut: '2026-10-04T15:00:00Z',
            reason: 'Forgot to record departure',
          })
          .expect(201)
      ).body;
      const today = (
        await submit('/api/attendance/check-in', employeeToken).expect(201)
      ).body;
      expect(today.id).not.toBe(yesterday.id);
      expect(today.workDate).toBe('2026-10-05');
      expect(
        (await submit('/api/attendance/check-in', employeeToken).expect(201))
          .body.id,
      ).toBe(today.id);
      const records = (
        await request(server())
          .get('/api/attendance/me')
          .set(auth(employeeToken))
          .expect(200)
      ).body.records;
      expect(
        records.find((r: { id: string }) => r.id === yesterday.id).checkOut,
      ).toBeNull();
      adminToken = (
        await request(server())
          .post('/api/auth/login')
          .send({ email: 'admin@test.local', password: adminPassword })
      ).body.token;
      if (status === 'withdrawn') {
        await request(server())
          .patch(`/api/requests/${pending.id}/withdraw`)
          .set(auth(employeeToken))
          .send({ reason: 'Replace incorrect departure request' })
          .expect(200);
      } else {
        await request(server())
          .patch(`/api/requests/${pending.id}/decision`)
          .set(auth(adminToken))
          .send({ status, reason: 'HR reviewed departure request' })
          .expect(200);
      }
      const after = (
        await request(server())
          .get('/api/attendance/me')
          .set(auth(employeeToken))
          .expect(200)
      ).body.records;
      expect(
        after.find((r: { id: string }) => r.id === yesterday.id).checkOut,
      ).toBe(status === 'approved' ? '2026-10-04T15:00:00.000Z' : null);
      await submit(
        `/api/attendance/${today.id}/check-out`,
        employeeToken,
      ).expect(201);
      vi.setSystemTime(new Date('2026-10-06T07:00:00Z'));
      employeeToken = (
        await request(server())
          .post('/api/auth/login')
          .send({ email: employee.email, password: employeePassword })
      ).body.token;
      await submit('/api/attendance/check-in', employeeToken).expect(
        status === 'approved' ? 201 : 409,
      );
    },
  );

  it('flags missing check-outs and prevents a second open workday', async () => {
    await submit('/api/attendance/check-in', employeeToken).expect(201);
    vi.setSystemTime(new Date('2026-10-04T15:00:00Z'));
    const report = (
      await request(server())
        .get('/api/attendance?status=Missing%20check-out')
        .set(auth(adminToken))
    ).body;
    expect(report[0].status).toBe('Missing check-out');
    vi.setSystemTime(new Date('2026-10-05T07:00:00Z'));
    // Renew the session after its 12-hour expiry.
    employeeToken = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: employee.email, password: employeePassword })
    ).body.token;
    await submit('/api/attendance/check-in', employeeToken).expect(409);
  });

  it('filters reports and exports matching rows without spreadsheet formulas', async () => {
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(adminToken))
      .send({ ...fields(), name: '=HYPERLINK("test")' })
      .expect(200);
    await submit('/api/attendance/check-in', employeeToken).expect(201);
    const path =
      '/api/attendance?from=2026-10-04&to=2026-10-04&department=Engineering';
    expect(
      (await request(server()).get(path).set(auth(adminToken))).body,
    ).toHaveLength(1);
    expect(
      (
        await request(server())
          .get(path.replace('Engineering', 'Sales'))
          .set(auth(adminToken))
      ).body,
    ).toHaveLength(0);
    const csv = await request(server())
      .get(
        '/api/attendance/export?from=2026-10-04&to=2026-10-04&department=Engineering',
      )
      .set(auth(adminToken))
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain("'=");
    expect(csv.text).toContain('National ID');
    expect(csv.text).toContain('00123456789012');
  });

  it('limits failed logins and expires sessions', async () => {
    for (let i = 0; i < 5; i++)
      await request(server())
        .post('/api/auth/login')
        .send({ email: 'unknown@test.local', password: 'wrong' })
        .expect(401);
    await request(server())
      .post('/api/auth/login')
      .send({ email: 'unknown@test.local', password: 'wrong' })
      .expect(429);
    vi.setSystemTime(new Date('2026-10-04T20:00:00Z'));
    await request(server())
      .get('/api/auth/me')
      .set(auth(employeeToken))
      .expect(401);
  });

  it('allows only HR to enter missing attendance, validates times, and audits the reason', async () => {
    const input = {
      employeeId: employee.id,
      workDate: '2026-10-04',
      checkIn: '2026-10-04T06:00:00Z',
      checkOut: null,
      reason: 'Employee reported connection failure',
    };
    await request(server())
      .post('/api/attendance')
      .set(auth(employeeToken))
      .send(input)
      .expect(403);
    await request(server())
      .post('/api/attendance')
      .set(auth(adminToken))
      .send({ ...input, checkOut: '2026-10-04T05:00:00Z' })
      .expect(400);
    const result = await request(server())
      .post('/api/attendance')
      .set(auth(adminToken))
      .send(input)
      .expect(201);
    await request(server())
      .post('/api/attendance')
      .set(auth(adminToken))
      .send(input)
      .expect(409);
    const audit = (
      await request(server())
        .get(`/api/audit?recordId=${result.body.id}`)
        .set(auth(adminToken))
    ).body;
    expect(audit[0].action).toBe('attendance.manual_entry');
    expect(audit[0].reason).toBe(input.reason);
  });

  it('revokes all sessions when a user changes their password', async () => {
    await request(server())
      .post('/api/auth/password')
      .set(auth(employeeToken))
      .send({
        currentPassword: employeePassword,
        newPassword: 'New-test-password-2026',
      })
      .expect(201);
    await request(server())
      .get('/api/auth/me')
      .set(auth(employeeToken))
      .expect(401);
    await request(server())
      .post('/api/auth/login')
      .send({ email: employee.email, password: employeePassword })
      .expect(401);
    await request(server())
      .post('/api/auth/login')
      .send({ email: employee.email, password: 'New-test-password-2026' })
      .expect(201);
  });

  it('allows HR to manage employees but reserves privileged accounts and schedules for admins', async () => {
    const hr = (
      await request(server())
        .post('/api/employees')
        .set(auth(adminToken))
        .send({
          ...fields(),
          nationalId: 'HR-001',
          email: 'hr@test.local',
          role: 'hr',
          password: employeePassword,
        })
        .expect(201)
    ).body;
    const token = (
      await request(server())
        .post('/api/auth/login')
        .send({ email: hr.email, password: employeePassword })
    ).body.token;
    await request(server()).get('/api/employees').set(auth(token)).expect(200);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(token))
      .send({ ...fields(), department: 'Product' })
      .expect(200);
    await request(server())
      .patch(`/api/employees/${employee.id}`)
      .set(auth(token))
      .send({ ...fields(), role: 'admin' })
      .expect(403);
    const { id: _id, employeeNumber: _employeeNumber, ...values } = hr;
    await request(server())
      .patch(`/api/employees/${hr.id}`)
      .set(auth(token))
      .send({ ...values, active: false })
      .expect(403);
    const { id: _scheduleId, ...shift } = schedule;
    await request(server())
      .patch(`/api/schedules/${schedule.id}`)
      .set(auth(token))
      .send(shift)
      .expect(403);
  });
});
