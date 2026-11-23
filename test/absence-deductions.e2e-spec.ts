import { randomUUID } from 'node:crypto';
import './postgres.setup.js';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';

type Row = {
  employeeId: string;
  deductionDays: number;
  deductionAmount: number;
  netSalary: number;
  absenceDeductions?: {
    workDate: string;
    status: string;
    days: number;
    adjustment: { reason: string } | null;
  }[];
};

describe('Absence deductions', () => {
  let app: INestApplication;
  let store: DatabaseService;
  let adminToken: string;
  let branchA: string;
  let branchB: string;
  let scheduleId: string;
  const password = 'Absence-deduction-password-2026';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => app.getHttpServer();
  const login = async (email: string) =>
    (
      await request(http())
        .post('/api/auth/login')
        .send({ workspace: 'test-company', email, password })
        .expect(201)
    ).body as { token: string; user: { id: string } };
  async function person(code: string, role: string, branchId: string) {
    const email = `${code}@test.local`;
    const created = (
      await request(http())
        .post('/api/employees')
        .set(auth(adminToken))
        .send({
          nationalId: code,
          name: code,
          email,
          department: 'Operations',
          jobTitle: 'Engineer',
          startDate: '2026-01-01',
          scheduleId,
          branchId,
          active: true,
          salesEnabled: false,
          role,
          monthlySalary: 3000,
          password,
        })
        .expect(201)
    ).body as { id: string };
    const session = await login(email);
    return { id: created.id, token: session.token, userId: session.user.id };
  }
  const attend = (employeeId: string, workDate: string) =>
    store
      .prepare(
        'INSERT INTO attendance (id,employee_id,work_date,check_in,check_out,schedule,timezone) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        employeeId,
        workDate,
        `${workDate}T06:00:00.000Z`,
        `${workDate}T14:00:00.000Z`,
        JSON.stringify({
          id: scheduleId,
          name: 'Test',
          start: '09:00',
          end: '17:00',
          graceMinutes: 15,
          days: [0, 1, 2, 3, 4],
        }),
        'Africa/Cairo',
      );
  const policy = async () =>
    (
      await request(http())
        .get('/api/deduction-policy')
        .set(auth(adminToken))
        .expect(200)
    ).body as Record<string, unknown>;
  const savePolicy = async (absence: object | undefined) => {
    const { requests, lateArrival } = await policy();
    return request(http())
      .put('/api/deduction-policy')
      .set(auth(adminToken))
      .send({
        rules: { requests, lateArrival, ...(absence ? { absence } : {}) },
        reason: 'Test policy change',
      });
  };
  const enable = (changes: object = {}) =>
    savePolicy({
      enabled: true,
      daysPerAbsence: 1,
      effectiveFrom: null,
      excludedDates: [],
      ...changes,
    });
  const run = async (token = adminToken, month = '2026-10') =>
    (
      await request(http())
        .get(`/api/payroll/run?month=${month}`)
        .set(auth(token))
        .expect(200)
    ).body as { status: string; revision: string; rows: Row[] };
  const rowFor = async (id: string, token = adminToken, month = '2026-10') =>
    (await run(token, month)).rows.find((row) => row.employeeId === id);
  const adjust = (id: string, date: string, body: object, token = adminToken) =>
    request(http())
      .patch(`/api/payroll/absence-deductions/${id}/${date}`)
      .set(auth(token))
      .send(body);
  const never = async (token = adminToken, month = '2026-10') =>
    (
      await request(http())
        .get(`/api/payroll/never-checked-in?month=${month}`)
        .set(auth(token))
        .expect(200)
    ).body as { employeeId: string; branchName: string; startDate: string }[];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Thursday 15 October 2026, 23:00 in Cairo. Workdays are Sunday-Thursday.
    vi.setSystemTime(new Date('2026-10-15T20:00:00Z'));
    vi.stubEnv('HR_ADMIN_EMAIL', 'absence-admin@test.local');
    vi.stubEnv('HR_ADMIN_PASSWORD', password);
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
    store = app.get(DatabaseService);
    adminToken = (await login('absence-admin@test.local')).token;
    branchA = (
      await request(http())
        .get('/api/branches')
        .set(auth(adminToken))
        .expect(200)
    ).body[0].id;
    branchB = (
      await request(http())
        .post('/api/branches')
        .set(auth(adminToken))
        .send({
          latitude: 31,
          longitude: 30,
          radiusMeters: 50,
          trackingRadiusMeters: 150,
          trackingGraceMinutes: 5,
          code: 'second',
          name: 'Second branch',
          active: true,
          address: 'Second office',
        })
        .expect(201)
    ).body.id;
    const schedules = (
      await request(http())
        .get('/api/schedules')
        .set(auth(adminToken))
        .expect(200)
    ).body as { id: string; days: number[] }[];
    scheduleId = schedules[0].id;
    expect(schedules[0].days).toEqual([0, 1, 2, 3, 4]);
  });
  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('is off by default and an old saved policy behaves as before', async () => {
    const employee = await person('EMP-OFF', 'employee', branchA);
    await attend(employee.id, '2026-10-01');
    const before = await run();
    expect((await policy()).absence).toEqual({
      enabled: false,
      daysPerAbsence: 1,
      effectiveFrom: null,
      excludedDates: [],
    });
    const row = before.rows.find((item) => item.employeeId === employee.id)!;
    expect(row.deductionDays).toBe(0);
    expect(row).not.toHaveProperty('absenceDeductions');

    const { absence: _absence, ...legacy } = await policy();
    await store
      .prepare(
        "INSERT INTO settings(key,value) VALUES('deduction-policy',?) ON CONFLICT(company_id,key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(legacy));
    expect((await policy()).absence).toMatchObject({ enabled: false });
    expect((await run()).revision).toBe(before.revision);

    // A client that predates the rule must not switch it off when saving.
    await enable({ daysPerAbsence: 0.5 }).then((res) => expect(res.status).toBe(200));
    await savePolicy(undefined).then((res) => expect(res.status).toBe(200));
    expect((await policy()).absence).toMatchObject({
      enabled: true,
      daysPerAbsence: 0.5,
    });
    await enable({ daysPerAbsence: 0.3 }).then((res) => expect(res.status).toBe(400));
  });

  it('charges from first check-in, uses cents, and lists who never checked in', async () => {
    const employee = await person('EMP-ON', 'employee', branchA);
    const absent = await person('EMP-NEVER', 'employee', branchA);
    await attend(employee.id, '2026-09-30');
    await attend(employee.id, '2026-10-01');
    await enable({
      effectiveFrom: '2026-01-01',
      excludedDates: ['2026-10-06', '2026-10-06'],
    });
    expect((await policy()).absence).toMatchObject({
      excludedDates: ['2026-10-06'],
    });
    const row = (await rowFor(employee.id))!;
    // Today (the 15th) and the excluded 6th are not charged.
    expect(row.absenceDeductions!.map((item) => item.workDate)).toEqual([
      '2026-10-04',
      '2026-10-05',
      '2026-10-07',
      '2026-10-08',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
    ]);
    expect(row.deductionDays).toBe(8);
    expect(row.deductionAmount).toBe(800);
    expect(row.netSalary).toBe(2200);
    const missing = (await rowFor(absent.id))!;
    expect(missing.absenceDeductions).toEqual([]);
    expect(missing.deductionDays).toBe(0);
    expect(await never()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          employeeId: absent.id,
          branchName: 'Main',
          startDate: '2026-01-01',
        }),
      ]),
    );
    expect((await never()).some((item) => item.employeeId === employee.id)).toBe(
      false,
    );
    await request(http())
      .get('/api/payroll/never-checked-in?month=2026-10')
      .set(auth(employee.token))
      .expect(403);
  });

  it('recalculates when earlier attendance appears and keeps a valid override', async () => {
    const employee = await person('EMP-MOVE', 'employee', branchA);
    await attend(employee.id, '2026-10-12');
    await enable();
    expect(
      (await rowFor(employee.id))!.absenceDeductions!.map((i) => i.workDate),
    ).toEqual(['2026-10-13', '2026-10-14']);
    await adjust(employee.id, '2026-10-13', {
      days: 0.5,
      reason: 'Half day agreed',
    }).expect(200);
    await attend(employee.id, '2026-10-08');
    const row = (await rowFor(employee.id))!;
    expect(row.absenceDeductions!.map((i) => i.workDate)).toEqual([
      '2026-10-11',
      '2026-10-13',
      '2026-10-14',
    ]);
    expect(
      row.absenceDeductions!.find((i) => i.workDate === '2026-10-13'),
    ).toMatchObject({ days: 0.5, adjustment: { reason: 'Half day agreed' } });
    expect(row.deductionDays).toBe(2.5);
  });

  it('edits and removes with audit, and refuses dates that are not chargeable', async () => {
    const employee = await person('EMP-EDIT', 'employee', branchA);
    await attend(employee.id, '2026-10-01');
    await enable();
    await adjust(employee.id, '2026-10-04', { days: 1, reason: 'Same value' }).expect(400);
    await adjust(employee.id, '2026-10-04', { days: 0.5, reason: 'x' }).expect(400);
    await adjust(employee.id, '2026-10-04', { days: 0.3, reason: 'Bad step' }).expect(400);
    await adjust(employee.id, '2026-10-01', { days: 1, reason: 'Attended day' }).expect(409);
    await adjust(employee.id, '2026-10-15', { days: 1, reason: 'Today is open' }).expect(409);
    await adjust(employee.id, '2026-10-04', {
      days: 0.5,
      reason: 'Employee cannot edit',
    }, employee.token).expect(403);
    await adjust(employee.id, '2026-10-04', {
      days: 0.5,
      reason: 'Partial day confirmed',
    }).expect(200);
    await adjust(employee.id, '2026-10-05', {
      days: 0,
      reason: 'Company closure',
    }).expect(200);
    const items = (
      await request(http())
        .get('/api/payroll/automatic-deductions?month=2026-10')
        .set(auth(adminToken))
        .expect(200)
    ).body as {
      source: string;
      id: string;
      days: number;
      automaticDays: number;
      editable: boolean;
    }[];
    expect(
      items.find((item) => item.id === `${employee.id}:2026-10-04`),
    ).toMatchObject({
      source: 'absence',
      days: 0.5,
      automaticDays: 1,
      editable: true,
    });
    const audit = (
      await request(http())
        .get(
          `/api/audit?recordId=${encodeURIComponent(`${employee.id}:2026-10-05`)}`,
        )
        .set(auth(adminToken))
        .expect(200)
    ).body as { action: string; reason: string; before: object; after: object }[];
    expect(audit[0]).toMatchObject({
      action: 'payroll.absence.deduction_removed',
      reason: 'Company closure',
      before: { days: 1 },
      after: { days: 0, originalDays: 1 },
    });
  });

  it('never double-charges a day with a request', async () => {
    const employee = await person('EMP-REQ', 'employee', branchA);
    await attend(employee.id, '2026-10-01');
    await enable();
    const submit = async (type: string, date: string) =>
      (
        await request(http())
          .post('/api/requests')
          .set(auth(employee.token))
          .send({ type, from: date, to: date, reason: 'Personal matter' })
          .expect(201)
      ).body as { id: string };
    const decide = (id: string, decision: string) =>
      request(http())
        .patch(`/api/requests/${id}/decision`)
        .set(auth(adminToken))
        .send({ status: decision, reason: 'HR final decision' })
        .expect(200);
    const approved = await submit('sick', '2026-10-04');
    const rejected = await submit('leave', '2026-10-05');
    await submit('unpaid', '2026-10-06');
    await decide(approved.id, 'approved');
    await decide(rejected.id, 'rejected');
    const row = (await rowFor(employee.id))!;
    const byDate = new Map(
      row.absenceDeductions!.map((item) => [item.workDate, item]),
    );
    expect(byDate.has('2026-10-04')).toBe(false);
    expect(byDate.get('2026-10-05')).toMatchObject({ status: 'covered', days: 0 });
    expect(byDate.get('2026-10-06')).toMatchObject({ status: 'held', days: 0 });
    // 1 (approved sick) + 3 (rejected leave) + 6 plain absences.
    expect(row.deductionDays).toBe(10);
    await adjust(employee.id, '2026-10-05', { days: 1, reason: 'Second charge' }).expect(409);
    await adjust(employee.id, '2026-10-06', { days: 1, reason: 'Still pending' }).expect(409);
  });

  it('keeps HR branch isolation but uses full history for first check-in', async () => {
    const transferred = await person('EMP-MOVED', 'employee', branchA);
    const otherBranch = await person('EMP-OTHER', 'employee', branchA);
    const hrB = await person('HR-ONLY-B', 'hr', branchB);
    await request(http())
      .patch(`/api/hr-accounts/${hrB.userId}/branches`)
      .set(auth(adminToken))
      .send({ branchIds: [branchB], reason: 'Second branch responsibility' })
      .expect(200);
    await attend(transferred.id, '2026-09-10');
    await attend(otherBranch.id, '2026-10-01');
    const snapshot = await store
      .prepare('SELECT data FROM employees WHERE id = ?')
      .get(transferred.id);
    await store
      .prepare(
        'INSERT INTO employee_branches (employee_id,branch_id,effective_from,employee_snapshot) VALUES (?,?,?,?)',
      )
      .run(transferred.id, branchB, '2026-10-01', snapshot!.data as string);
    await enable();
    // September attendance belongs to branch A, which this HR user cannot read.
    const row = (await rowFor(transferred.id, hrB.token))!;
    expect(row.absenceDeductions!.length).toBeGreaterThan(0);
    expect(row.deductionDays).toBe(
      (await rowFor(transferred.id))!.deductionDays,
    );
    expect(await rowFor(otherBranch.id, hrB.token)).toBeUndefined();
    expect(
      (await never(hrB.token)).some(
        (item) =>
          item.employeeId === transferred.id ||
          item.employeeId === otherBranch.id,
      ),
    ).toBe(false);
    await adjust(otherBranch.id, '2026-10-04', {
      days: 0,
      reason: 'Outside my branch',
    }, hrB.token).expect(400);
    await adjust(transferred.id, '2026-10-04', {
      days: 0,
      reason: 'Inside my branch',
    }, hrB.token).expect(200);
  });

  it('never changes an approved run, including runs saved before this rule', async () => {
    const employee = await person('EMP-LOCK', 'employee', branchA);
    await attend(employee.id, '2026-10-01');
    await enable();
    const draft = await run();
    await request(http())
      .post('/api/payroll/approve')
      .set(auth(adminToken))
      .send({
        month: '2026-10',
        expectedRevision: draft.revision,
        reason: 'October payroll reviewed',
      })
      .expect(201);
    const approved = await run();
    await attend(employee.id, '2026-10-04');
    await enable({ daysPerAbsence: 2 });
    expect(await run()).toEqual(approved);
    await adjust(employee.id, '2026-10-05', {
      days: 0,
      reason: 'Too late, approved',
    }).expect(409);

    const legacyRow = {
      employeeId: employee.id,
      employeeNumber: 'EMP-1',
      name: 'Legacy',
      department: 'Operations',
      active: true,
      month: '2026-08',
      currency: 'EGP',
      grossSalary: 3000,
      dailyRate: 100,
      deductionDays: 0,
      deductionAmount: 0,
      netSalary: 3000,
      deductions: [],
      manualDeductions: [],
    };
    await store
      .prepare('INSERT INTO payroll_runs (month,data) VALUES (?, ?)')
      .run(
        '2026-08',
        JSON.stringify({
          month: '2026-08',
          status: 'approved',
          company: 'Company HR',
          timezone: 'Africa/Cairo',
          revision: 'legacy',
          approvedAt: '2026-09-01T08:00:00.000Z',
          approvedBy: 'Admin',
          approvedById: 'admin',
          approvalReason: 'Legacy run',
          rows: [legacyRow],
        }),
      );
    expect((await run(adminToken, '2026-08')).rows).toEqual([legacyRow]);
    await request(http())
      .get('/api/payroll/automatic-deductions?month=2026-08')
      .set(auth(adminToken))
      .expect(200)
      .expect([]);
  });
});
