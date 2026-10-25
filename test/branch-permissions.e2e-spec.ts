import { BootstrapService } from '../src/database/bootstrap.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { randomUUID } from 'node:crypto';
import { testCompanyId } from './postgres.setup.js';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { AttendanceLocationService } from '../src/attendance/attendance-location.service.js';
import { tokenHash } from '../src/common/security/credentials.js';
import type { Actor } from '../src/common/types/actor.type.js';
import { provisionTestCompany } from './postgres.setup.js';

describe('Company and branch permissions', () => {
  let app: INestApplication,
    store: DatabaseService,
    adminToken: string,
    branchA: string,
    branchB: string,
    scheduleId: string,
    photo: Buffer;
  const password = 'Branch-permissions-password-2026';
  type Staff = {
    id: string;
    token: string;
    user: Actor;
    branchId: string;
    email: string;
  };
  let hrA: Staff,
    hrB: Staff,
    unassigned: Staff,
    employeeA: Staff,
    employeeB: Staff;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => app.getHttpServer();
  const policy = {
    latitude: 30.023092,
    longitude: 31.528179,
    radiusMeters: 50,
    trackingRadiusMeters: 150,
    trackingGraceMinutes: 5,
  };
  const login = async (email: string) =>
    (
      await request(http())
        .post('/api/auth/login')
        .send({ workspace: 'test-company', email, password })
        .expect(201)
    ).body;
  const grant = async (person: Staff, ids: string[]) =>
    request(http())
      .patch(`/api/hr-accounts/${person.user.id}/branches`)
      .set(auth(adminToken))
      .send({
        branchIds: ids,
        reason: 'Administrator reviewed branch responsibilities',
      })
      .expect(200);
  async function staff(code: string, role: string, branchId: string) {
    const email = `${code}@test.local`;
    const employee = (
      await request(http())
        .post('/api/employees')
        .set(auth(adminToken))
        .send({
          nationalId: code,
          name: code,
          email,
          department: 'Shared department',
          jobTitle: 'Engineer',
          startDate: '2026-01-01',
          scheduleId,
          branchId,
          active: true,
          salesEnabled: true,
          role,
          monthlySalary: 3000,
          password,
        })
        .expect(201)
    ).body;
    const session = await login(email);
    return {
      id: employee.id,
      token: session.token,
      user: session.user,
      branchId,
      email,
    };
  }
  const capture = (path: string, person: Staff, point = policy) =>
    request(http())
      .post('/api/attendance' + path)
      .set(auth(person.token))
      .field('latitude', String(point.latitude))
      .field('longitude', String(point.longitude))
      .field('accuracyMeters', '10')
      .field('capturedAt', new Date().toISOString())
      .attach('photo', photo, {
        filename: 'office.png',
        contentType: 'image/png',
      });
  beforeAll(async () => {
    photo = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T20:00:00Z'));
    vi.stubEnv('HR_ADMIN_EMAIL', 'branch-admin@test.local');
    vi.stubEnv('HR_ADMIN_PASSWORD', password);
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
    store = app.get(DatabaseService);
    adminToken = (await login('branch-admin@test.local')).token;
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
          ...policy,
          latitude: 31,
          longitude: 30,
          code: 'second',
          name: 'Second branch',
          active: true,
          address: 'Second office',
        })
        .expect(201)
    ).body.id;
    scheduleId = (
      await request(http())
        .get('/api/schedules')
        .set(auth(adminToken))
        .expect(200)
    ).body[0].id;
    hrA = await staff('HR-A', 'hr', branchB);
    hrB = await staff('HR-B', 'hr', branchB);
    unassigned = await staff('HR-NONE', 'hr', branchA);
    employeeA = await staff('EMP-A', 'employee', branchA);
    employeeB = await staff('EMP-B', 'employee', branchB);
    await grant(hrA, [branchA]);
    await grant(hrB, [branchB]);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('enforces explicit grants, assigned-branch attendance and company-only branch references', async () => {
    const a = (
      await request(http())
        .get('/api/employees')
        .set(auth(hrA.token))
        .expect(200)
    ).body;
    expect(a.map((row: { id: string }) => row.id)).toContain(employeeA.id);
    expect(a.map((row: { id: string }) => row.id)).not.toContain(employeeB.id);
    expect(a.map((row: { id: string }) => row.id)).not.toContain(hrA.id);
    await request(http())
      .get('/api/employees')
      .set(auth(unassigned.token))
      .expect(403);
    const newEmployee = {
      nationalId: 'HR-CREATED',
      name: 'Created by scoped HR',
      email: 'hr-created@test.local',
      department: 'Shared department',
      jobTitle: 'Engineer',
      startDate: '2026-01-01',
      scheduleId,
      branchId: branchA,
      active: true,
      role: 'employee',
      password,
    };
    await request(http())
      .post('/api/employees')
      .set(auth(hrA.token))
      .send(newEmployee)
      .expect(201);
    await request(http())
      .post('/api/employees')
      .set(auth(hrA.token))
      .send({
        ...newEmployee,
        nationalId: 'FORGED-CREATE',
        email: 'forged-create@test.local',
        branchId: branchB,
      })
      .expect(400);
    expect(
      (
        await request(http())
          .get('/api/auth/me')
          .set(auth(unassigned.token))
          .expect(200)
      ).body.employee.id,
    ).toBe(unassigned.id);
    expect(
      (
        await request(http())
          .get('/api/branches')
          .set(auth(hrA.token))
          .expect(200)
      ).body.map((row: { id: string }) => row.id),
    ).toEqual([branchA]);
    expect(
      (
        await request(http())
          .get('/api/attendance/policy')
          .set(auth(hrA.token))
          .expect(200)
      ).body.latitude,
    ).toBe(31);
    await capture('/check-in', hrA, {
      ...policy,
      latitude: 31,
      longitude: 30,
    }).expect(201);
    await request(http())
      .post('/api/requests')
      .set(auth(unassigned.token))
      .send({
        type: 'leave',
        from: '2026-10-15',
        to: '2026-10-15',
        reason: 'Personal request without administrative grants',
      })
      .expect(201);
    await request(http())
      .post('/api/branches')
      .set(auth(hrA.token))
      .send({ ...policy, code: 'forged', name: 'Forged' })
      .expect(403);
    await request(http())
      .patch(`/api/hr-accounts/${hrA.user.id}/branches`)
      .set(auth(hrA.token))
      .send({ branchIds: [branchB], reason: 'Attempt to expand access' })
      .expect(403);
    await request(http())
      .post(`/api/employees/${employeeA.id}/branches`)
      .set(auth(hrA.token))
      .send({
        branchId: branchB,
        effectiveFrom: '2026-10-16',
        reason: 'Attempt to transfer employee',
      })
      .expect(403);
    await request(http())
      .post('/api/payroll/approve')
      .set(auth(hrA.token))
      .send({
        month: '2026-10',
        expectedRevision: '0'.repeat(64),
        reason: 'Attempt to approve company payroll',
      })
      .expect(403);
    await capture('/check-in', employeeA, {
      ...policy,
      latitude: 31,
      longitude: 30,
    }).expect(403);
    const record = (await capture('/check-in', employeeA).expect(201)).body;
    expect(record.branchId).toBe(branchA);
    await request(http())
      .get(`/api/attendance/${record.id}/photos/check-in`)
      .set(auth(hrB.token))
      .expect(404);
    await request(http())
      .get(`/api/attendance/${record.id}/photos/check-in`)
      .set(auth(hrA.token))
      .expect(200);
    await request(http())
      .post(`/api/employees/${employeeA.id}/branches`)
      .set(auth(adminToken))
      .send({
        branchId: branchB,
        effectiveFrom: '2026-10-16',
        reason: 'Open interval transfer',
      })
      .expect(409);
    const branch = (
      await request(http())
        .get('/api/branches')
        .set(auth(adminToken))
        .expect(200)
    ).body.find((row: { id: string }) => row.id === branchA);
    const { id: _id, ...input } = branch;
    await request(http())
      .patch(`/api/branches/${branchA}`)
      .set(auth(adminToken))
      .send({ ...input, latitude: 29, longitude: 29 })
      .expect(200);
    await capture(`/${record.id}/check-out`, employeeA).expect(201);
    await store.withSession(hrA.user, tokenHash(hrA.token), async () => {
      const ids = (await store.prepare('SELECT id FROM employees').all()).map(
        (row) => row.id,
      );
      expect(ids).toContain(employeeA.id);
      expect(ids).not.toContain(employeeB.id);
    });
    const other = await provisionTestCompany('foreign-company');
    const foreign = await store.withCompany(
      other,
      async () =>
        (await store.prepare('SELECT id FROM branches').get())!.id as string,
    );
    await request(http())
      .patch(`/api/hr-accounts/${hrA.user.id}/branches`)
      .set(auth(adminToken))
      .send({ branchIds: [foreign], reason: 'Cross-company branch reference' })
      .expect(400);
  });

  it('keeps prior-branch records private after transfers and redacts payroll spanning inaccessible branches', async () => {
    const record = (await capture('/check-in', employeeA).expect(201)).body;
    await capture(`/${record.id}/check-out`, employeeA).expect(201);
    const submitted = (
      await request(http())
        .post('/api/requests')
        .set(auth(employeeA.token))
        .send({
          type: 'leave',
          from: '2026-10-15',
          to: '2026-10-15',
          reason: 'A private first branch request',
        })
        .expect(201)
    ).body;
    await request(http())
      .post(`/api/employees/${employeeA.id}/branches`)
      .set(auth(adminToken))
      .send({
        branchId: branchB,
        effectiveFrom: '2026-10-16',
        reason: 'Administrator approved branch transfer',
      })
      .expect(201);
    vi.setSystemTime(new Date('2026-10-15T22:30:00Z'));
    const current = (
      await request(http())
        .get('/api/employees')
        .set(auth(adminToken))
        .expect(200)
    ).body.find((row: { id: string }) => row.id === employeeA.id);
    const {
      id: _id,
      employeeNumber: _number,
      accountId: _account,
      ...fields
    } = current;
    await request(http())
      .patch('/api/employees/' + employeeA.id)
      .set(auth(adminToken))
      .send({
        ...fields,
        name: 'New branch confidential profile',
        monthlySalary: 6000,
      })
      .expect(200);
    expect(
      (
        await request(http())
          .get('/api/employees')
          .set(auth(hrA.token))
          .expect(200)
      ).body.map((row: { id: string }) => row.id),
    ).not.toContain(employeeA.id);
    expect(
      (
        await request(http())
          .get('/api/employees')
          .set(auth(hrB.token))
          .expect(200)
      ).body.map((row: { id: string }) => row.id),
    ).toContain(employeeA.id);
    const oldRows = (
      await request(http())
        .get('/api/attendance?from=2026-10-15&to=2026-10-15')
        .set(auth(hrA.token))
        .expect(200)
    ).body;
    expect(
      oldRows.find((row: { id: string }) => row.id === record.id).name,
    ).toBe('EMP-A');
    expect(
      (
        await request(http())
          .get('/api/audit?search=New%20branch%20confidential%20profile')
          .set(auth(hrA.token))
          .expect(200)
      ).body,
    ).toEqual([]);
    const newRows = (
      await request(http())
        .get('/api/attendance?from=2026-10-15&to=2026-10-15')
        .set(auth(hrB.token))
        .expect(200)
    ).body;
    expect(
      newRows.some(
        (row: { employeeId: string }) => row.employeeId === employeeA.id,
      ),
    ).toBe(false);
    await request(http())
      .get(`/api/attendance/${record.id}/evidence`)
      .set(auth(hrB.token))
      .expect(404);
    await request(http())
      .get(`/api/attendance/${record.id}/photos/check-in`)
      .set(auth(employeeA.token))
      .expect(200);
    const oldRequests = (
      await request(http())
        .get('/api/requests')
        .set(auth(hrA.token))
        .expect(200)
    ).body;
    expect(oldRequests.map((row: { id: string }) => row.id)).toContain(
      submitted.id,
    );
    expect(
      (
        await request(http())
          .get('/api/requests')
          .set(auth(hrB.token))
          .expect(200)
      ).body.map((row: { id: string }) => row.id),
    ).not.toContain(submitted.id);
    await request(http())
      .patch(`/api/requests/${submitted.id}/decision`)
      .set(auth(hrB.token))
      .send({ status: 'rejected', reason: 'Forged branch decision' })
      .expect(404);
    for (const person of [hrA, hrB])
      expect(
        (
          await request(http())
            .get('/api/payroll?month=2026-10')
            .set(auth(person.token))
            .expect(200)
        ).body.map((row: { employeeId: string }) => row.employeeId),
      ).not.toContain(employeeA.id);
    const hidden = (
      await request(http())
        .get(`/api/audit?recordId=${record.id}`)
        .set(auth(hrB.token))
        .expect(200)
    ).body;
    expect(hidden).toEqual([]);
    const notifications = (
      await request(http())
        .get('/api/notifications')
        .set(auth(hrB.token))
        .expect(200)
    ).body;
    expect(
      notifications.items.some(
        (item: { requestId?: string }) => item.requestId === submitted.id,
      ),
    ).toBe(false);
    await grant(hrA, [branchA, branchB]);
    expect(
      (
        await request(http())
          .get('/api/payroll?month=2026-10')
          .set(auth(hrA.token))
          .expect(200)
      ).body.map((row: { employeeId: string }) => row.employeeId),
    ).toContain(employeeA.id);
  });

  it('isolates files, records, cursors, mutations and payroll locks between two companies', async () => {
    const record = (await capture('/check-in', employeeA).expect(201)).body;
    await capture('/' + record.id + '/check-out', employeeA).expect(201);
    const leave = (
      await request(http())
        .post('/api/requests')
        .set(auth(employeeA.token))
        .send({
          type: 'leave',
          from: '2026-10-15',
          to: '2026-10-15',
          reason: 'Private company request',
        })
        .expect(201)
    ).body;
    const activity = (
      await request(http())
        .post('/api/sales/activities')
        .set(auth(employeeA.token))
        .send({
          id: randomUUID(),
          activity: {
            kind: 'meeting',
            activityDate: '2026-10-15',
            clientName: 'Private company client',
            projectName: 'Private company project',
            notes: '',
            purpose: 'Discuss options',
            outcome: 'Follow up agreed',
            propertyReference: '',
            followUpDate: null,
          },
        })
        .expect(201)
    ).body;
    const second = await provisionTestCompany('second-customer');
    vi.stubEnv('HR_BOOTSTRAP_COMPANY_ID', second);
    await app.get(BootstrapService).onModuleInit();
    vi.stubEnv('HR_BOOTSTRAP_COMPANY_ID', testCompanyId);
    const session = (
      await request(http())
        .post('/api/auth/login')
        .send({
          workspace: 'second-customer',
          email: 'branch-admin@test.local',
          password,
        })
        .expect(201)
    ).body;
    const otherAuth = auth(session.token);
    const otherSchedule = (
      await request(http()).get('/api/schedules').set(otherAuth).expect(200)
    ).body[0].id;
    const otherBranch = (
      await request(http()).get('/api/branches').set(otherAuth).expect(200)
    ).body[0].id;
    const input = {
      nationalId: 'EMP-A',
      name: 'Other company employee',
      email: 'EMP-A@test.local',
      department: 'Shared department',
      jobTitle: 'Engineer',
      startDate: '2026-01-01',
      scheduleId: otherSchedule,
      branchId: otherBranch,
      active: true,
      salesEnabled: true,
      role: 'employee',
      monthlySalary: 3000,
      password,
    };
    const other = (
      await request(http())
        .post('/api/employees')
        .set(otherAuth)
        .send(input)
        .expect(201)
    ).body;
    await request(http())
      .patch('/api/employees/' + employeeA.id)
      .set(otherAuth)
      .send(input)
      .expect(404);
    await request(http())
      .get('/api/attendance/' + record.id + '/photos/check-in')
      .set(otherAuth)
      .expect(404);
    await request(http())
      .get('/api/attendance/' + record.id + '/evidence')
      .set(otherAuth)
      .expect(404);
    await request(http())
      .patch('/api/requests/' + leave.id + '/decision')
      .set(otherAuth)
      .send({ status: 'rejected', reason: 'Cross-company decision attempt' })
      .expect(404);
    expect(
      (
        await request(http())
          .get('/api/requests?before=' + leave.id)
          .set(otherAuth)
          .expect(200)
      ).body,
    ).toEqual([]);
    expect(
      (
        await request(http())
          .get('/api/audit?recordId=' + record.id)
          .set(otherAuth)
          .expect(200)
      ).body,
    ).toEqual([]);
    await request(http())
      .get('/api/sales/activities/' + activity.id)
      .set(otherAuth)
      .expect(404);
    await request(http())
      .get('/api/hr-accounts/' + hrA.user.id + '/branches')
      .set(otherAuth)
      .expect(404);
    const rows = (
      await request(http())
        .get('/api/attendance?from=2026-10-15&to=2026-10-15')
        .set(otherAuth)
        .expect(200)
    ).body;
    expect(
      rows.every((row: { employeeId: string }) => row.employeeId === other.id),
    ).toBe(true);
    const draft = (
      await request(http())
        .get('/api/payroll/run?month=2026-10')
        .set(auth(adminToken))
        .expect(200)
    ).body;
    await request(http())
      .post('/api/payroll/approve')
      .set(auth(adminToken))
      .send({
        month: '2026-10',
        expectedRevision: draft.revision,
        reason: 'Company payroll reviewed',
      })
      .expect(201);
    expect(
      (
        await request(http())
          .get('/api/payroll/run?month=2026-10')
          .set(otherAuth)
          .expect(200)
      ).body.status,
    ).toBe('draft');
    const ownPayroll = (
      await request(http())
        .get('/api/payroll?month=2026-10')
        .set(auth(hrA.token))
        .expect(200)
    ).body;
    expect(
      ownPayroll.some(
        (row: { employeeId: string }) => row.employeeId === employeeA.id,
      ),
    ).toBe(true);
    expect(
      ownPayroll.every((row: { employeeId: string }) =>
        [employeeA.id, unassigned.id].includes(row.employeeId),
      ),
    ).toBe(true);
    await request(http())
      .post('/api/payroll/deductions')
      .set(auth(hrA.token))
      .send({
        employeeId: employeeA.id,
        month: '2026-10',
        days: 1,
        reason: 'Cannot change frozen payroll',
        approvedBy: 'HR',
      })
      .expect(409);
  });

  it('keeps an overnight workday on its original branch across a scheduled transfer', async () => {
    const shift = (
      await request(http())
        .get('/api/schedules')
        .set(auth(adminToken))
        .expect(200)
    ).body[0];
    const { id: _id, ...definition } = shift;
    await request(http())
      .patch('/api/schedules/' + shift.id)
      .set(auth(adminToken))
      .send({
        ...definition,
        start: '22:00',
        end: '06:00',
        days: [0, 1, 2, 3, 4, 5, 6],
      })
      .expect(200);
    await request(http())
      .post('/api/employees/' + employeeA.id + '/branches')
      .set(auth(adminToken))
      .send({
        branchId: branchB,
        effectiveFrom: '2026-10-16',
        reason: 'Scheduled overnight branch transfer',
      })
      .expect(201);
    const record = (await capture('/check-in', employeeA).expect(201)).body;
    vi.setSystemTime(new Date('2026-10-15T22:30:00Z'));
    const policyAtNight = (
      await request(http())
        .get('/api/attendance/policy')
        .set(auth(employeeA.token))
        .expect(200)
    ).body;
    expect(policyAtNight.branchId).toBe(branchA);
    await capture('/' + record.id + '/check-out', employeeA).expect(201);
    vi.setSystemTime(new Date('2026-10-16T07:00:00Z'));
    expect(
      (
        await request(http())
          .get('/api/attendance/policy')
          .set(auth(employeeA.token))
          .expect(200)
      ).body.branchId,
    ).toBe(branchB);
    await capture('/check-in', employeeA).expect(403);
    expect(
      (
        await capture('/check-in', employeeA, {
          ...policy,
          latitude: 31,
          longitude: 30,
        }).expect(201)
      ).body.branchId,
    ).toBe(branchB);
  });
  it('prevents deactivation of assigned branches and retains explicitly granted inactive-branch history', async () => {
    const branch = (
      await request(http())
        .get('/api/branches')
        .set(auth(adminToken))
        .expect(200)
    ).body.find((row: { id: string }) => row.id === branchA);
    const { id: _id, ...input } = branch;
    await request(http())
      .patch('/api/branches/' + branchA)
      .set(auth(adminToken))
      .send({ ...input, active: false })
      .expect(409);
    for (const employee of [employeeA, unassigned])
      await request(http())
        .post('/api/employees/' + employee.id + '/branches')
        .set(auth(adminToken))
        .send({
          branchId: branchB,
          effectiveFrom: '2026-10-16',
          reason: 'Move active staff before branch closure',
        })
        .expect(201);
    vi.setSystemTime(new Date('2026-10-15T22:30:00Z'));
    await request(http())
      .patch('/api/branches/' + branchA)
      .set(auth(adminToken))
      .send({ ...input, active: false })
      .expect(200);
    await grant(hrB, [branchA]);
    const historic = (
      await request(http())
        .get('/api/attendance?from=2026-10-15&to=2026-10-15')
        .set(auth(hrB.token))
        .expect(200)
    ).body;
    expect(
      historic.some(
        (row: { employeeId: string }) => row.employeeId === employeeA.id,
      ),
    ).toBe(true);
    const profile = (
      await request(http())
        .get('/api/employees')
        .set(auth(adminToken))
        .expect(200)
    ).body.find((row: { id: string }) => row.id === employeeA.id);
    const {
      id: _employeeId,
      employeeNumber: _number,
      accountId: _account,
      ...fields
    } = profile;
    await request(http())
      .post('/api/employees')
      .set(auth(adminToken))
      .send({
        ...fields,
        nationalId: 'INACTIVE-BRANCH',
        email: 'inactive-branch@test.local',
        branchId: branchA,
        password,
      })
      .expect(400);
  });
  it('rolls back branch mutations when their audit cannot be saved', async () => {
    vi.spyOn(app.get(AuditService), 'record').mockRejectedValueOnce(
      new Error('Audit unavailable'),
    );
    await request(http())
      .post('/api/branches')
      .set(auth(adminToken))
      .send({
        ...policy,
        code: 'rollback',
        name: 'Must not persist',
        active: true,
      })
      .expect(500);
    expect(
      (
        await request(http())
          .get('/api/branches')
          .set(auth(adminToken))
          .expect(200)
      ).body.some((row: { code: string }) => row.code === 'rollback'),
    ).toBe(false);
  });
  it.each(['attendance', 'attendance/export'])(
    'revokes branch access during a queued %s response',
    async (path) => {
      let release!: () => void, entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const location = app.get(AttendanceLocationService);
      const original = location.views.bind(location);
      vi.spyOn(location, 'views').mockImplementationOnce(async (...args) => {
        const rows = await original(...args);
        entered();
        await blocked;
        return rows;
      });
      const pending = request(http())
        .get(`/api/${path}?from=2026-10-15&to=2026-10-15`)
        .set(auth(hrA.token))
        .then((result) => result);
      try {
        await ready;
        await grant(hrA, []);
      } finally {
        release();
      }
      expect((await pending).status).toBe(403);
      await request(http())
        .get('/api/employees')
        .set(auth(hrA.token))
        .expect(403);
      await request(http())
        .get('/api/employees')
        .set(auth(hrB.token))
        .expect(200);
    },
  );
});
