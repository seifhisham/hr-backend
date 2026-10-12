import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AuditService } from '../src/audit/audit.service.js';
import type { Employee } from '../src/employees/types/employee.type.js';

describe('Real estate sales REST workflows', () => {
  let app: INestApplication;
  let directory: string;
  let admin: string;
  let agent: { employee: Employee; token: string };
  let manager: { employee: Employee; token: string };
  let outsider: { employee: Employee; token: string };
  let scheduleId: string;
  const password = 'Isolated-sales-test-2026';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();
  const start = async () => {
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
  };
  const login = async (email: string) =>
    (
      await request(server())
        .post('/api/auth/login')
        .send({ email, password })
        .expect(201)
    ).body.token as string;
  const person = async (
    name: string,
    department: string,
    salesEnabled = false,
  ) => {
    const employee = (
      await request(server())
        .post('/api/employees')
        .set(auth(admin))
        .send({
          nationalId: name,
          name,
          email: `${name}@test.local`,
          department,
          jobTitle: 'Property consultant',
          startDate: '2026-10-01',
          scheduleId,
          role: 'employee',
          active: true,
          salesEnabled,
          password,
        })
        .expect(201)
    ).body as Employee;
    return { employee, token: await login(employee.email) };
  };
  const meeting = (changes = {}) => ({
    kind: 'meeting',
    activityDate: '2026-10-07',
    clientName: 'Test buyer',
    projectName: 'Test compound',
    propertyReference: '',
    notes: '',
    purpose: 'Discuss apartment options',
    outcome: 'Viewing arranged',
    followUpDate: '2026-10-09',
    ...changes,
  });
  const deal = (changes = {}) => ({
    kind: 'closed-deal',
    activityDate: '2026-10-07',
    clientName: 'Test buyer',
    projectName: 'Test compound',
    propertyReference: 'Unit A-12',
    notes: '',
    dealReference: 'TEST-CONTRACT-001',
    transactionType: 'sale',
    value: 2500000.25,
    currency: 'EGP',
    ...changes,
  });
  const create = (
    activity: unknown = meeting(),
    token = agent.token,
    id = randomUUID(),
  ) =>
    request(server())
      .post('/api/sales/activities')
      .set(auth(token))
      .send({ id, activity });
  const review = (
    activity: { id: string; revision: number },
    status = 'verified',
    token = manager.token,
  ) =>
    request(server())
      .patch(`/api/sales/activities/${activity.id}/review`)
      .set(auth(token))
      .send({
        expectedRevision: activity.revision,
        status,
        reason: 'Checked the activity and signed agreement',
      });
  const performance = async (token = admin, own = false) =>
    (
      await request(server())
        .get(`/api/sales/performance${own ? '/me' : ''}?month=2026-10`)
        .set(auth(token))
        .expect(200)
    ).body;
  const target = (changes = {}) => ({
    employeeId: agent.employee.id,
    month: '2026-10',
    meetings: 2,
    deals: 2,
    transactionValue: 5000000,
    currency: 'EGP',
    expectedRevision: 0,
    reason: 'Agreed monthly real estate targets',
    ...changes,
  });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'hr-sales-test-'));
    vi.stubEnv('HR_DATABASE_PATH', join(directory, 'test.sqlite'));
    vi.stubEnv('HR_ADMIN_EMAIL', 'admin@test.local');
    vi.stubEnv('HR_ADMIN_PASSWORD', password);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T09:00:00Z'));
    await start();
    admin = await login('admin@test.local');
    scheduleId = (
      await request(server()).get('/api/schedules').set(auth(admin)).expect(200)
    ).body[0].id;
    agent = await person('agent', 'Sales', true);
    manager = await person('manager', 'Sales');
    outsider = await person('outsider', 'Operations', true);
    const {
      id: _managerId,
      employeeNumber: _managerNumber,
      ...managerFields
    } = manager.employee;
    await request(server())
      .patch(`/api/employees/${manager.employee.id}`)
      .set(auth(admin))
      .send({ ...managerFields, role: 'manager' })
      .expect(200);
    manager.token = await login(manager.employee.email);
    manager.employee.role = 'manager';
    const {
      id: _agentId,
      employeeNumber: _agentNumber,
      ...agentFields
    } = agent.employee;
    await request(server())
      .patch(`/api/employees/${agent.employee.id}`)
      .set(auth(admin))
      .send({ ...agentFields, managerId: manager.employee.id })
      .expect(200);
    agent.employee.managerId = manager.employee.id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('requires explicit sales access, authenticates callers and limits private records', async () => {
    await request(server()).get('/api/sales/access').expect(401);
    expect(
      (
        await request(server())
          .get('/api/sales/access')
          .set(auth(manager.token))
          .expect(200)
      ).body,
    ).toEqual({ canSubmit: false, canReview: true, canSetTargets: false });
    await create(meeting(), manager.token).expect(403);
    const activity = (await create().expect(201)).body;
    await request(server())
      .get(`/api/sales/activities/${activity.id}`)
      .set(auth(outsider.token))
      .expect(404);
    await request(server())
      .get('/api/sales/activities?month=2026-10')
      .set(auth(agent.token))
      .expect(403);
    await request(server())
      .get('/api/sales/export?month=2026-10')
      .set(auth(agent.token))
      .expect(403);
    expect(
      (
        await request(server())
          .get('/api/sales/activities/me?month=2026-10')
          .set(auth(outsider.token))
          .expect(200)
      ).body,
    ).toEqual([]);
    expect(
      (
        await request(server())
          .get('/api/sales/activities?month=2026-10')
          .set(auth(manager.token))
          .expect(200)
      ).body,
    ).toHaveLength(1);
    await review(activity, 'verified', agent.token).expect(403);
    await review(activity, 'verified', outsider.token).expect(403);
    await request(server())
      .post('/api/sales/targets')
      .set(auth(manager.token))
      .send(target())
      .expect(403);
    await request(server())
      .post('/api/sales/activities')
      .set(auth(agent.token))
      .send({
        id: randomUUID(),
        activity: meeting(),
        employeeId: outsider.employee.id,
      })
      .expect(400);
  });

  it('reconciles repeated submissions and rejects case-insensitive duplicate contracts', async () => {
    const id = randomUUID();
    const first = (await create(deal(), agent.token, id).expect(201)).body;
    expect((await create(deal(), agent.token, id).expect(201)).body).toEqual(
      first,
    );
    await create(
      deal({ dealReference: 'test-contract-001' }),
      outsider.token,
    ).expect(409);
    await create(meeting(), agent.token, id).expect(409);
    await create(deal(), outsider.token, id).expect(409);
    expect(
      (
        await request(server())
          .get('/api/sales/activities/me?month=2026-10')
          .set(auth(agent.token))
          .expect(200)
      ).body,
    ).toHaveLength(1);
    const audit = (
      await request(server())
        .get(`/api/audit?recordId=${id}`)
        .set(auth(admin))
        .expect(200)
    ).body;
    expect(
      audit.filter(
        (row: { action: string }) => row.action === 'sales.activity.created',
      ),
    ).toHaveLength(1);
  });

  it('counts only verified activities, separates currencies and measures independent targets', async () => {
    await request(server())
      .post('/api/sales/targets')
      .set(auth(admin))
      .send(target())
      .expect(201);
    const pending = (await create().expect(201)).body;
    const viewing = (
      await create(
        meeting({ kind: 'viewing', propertyReference: 'A-12' }),
      ).expect(201)
    ).body;
    const sale = (await create(deal()).expect(201)).body;
    const lease = (
      await create(
        deal({
          dealReference: 'LEASE-002',
          transactionType: 'lease',
          value: 12000,
          currency: 'USD',
        }),
      ).expect(201)
    ).body;
    const returned = (
      await create(meeting({ clientName: 'Unconfirmed client' })).expect(201)
    ).body;
    await review(viewing).expect(200);
    await review(sale).expect(200);
    await review(lease).expect(200);
    await review(returned, 'returned').expect(200);
    const row = (await performance()).find(
      (row: { employeeId: string }) => row.employeeId === agent.employee.id,
    );
    expect(row).toMatchObject({
      meetings: 0,
      viewings: 1,
      meetingTotal: 1,
      deals: 2,
      sales: 1,
      leases: 1,
      transactionValues: { EGP: 2500000.25, USD: 12000 },
      pending: 1,
      returned: 1,
      achievement: { meetings: 50, deals: 100, transactionValue: 50 },
    });
    expect((await performance(agent.token, true))[0]).toEqual(row);
    await review(pending).expect(200);
    expect((await performance(agent.token, true))[0].achievement.meetings).toBe(
      100,
    );
    const november = await request(server())
      .get('/api/sales/performance/me?month=2026-11')
      .set(auth(agent.token))
      .expect(200);
    expect(november.body[0]).toMatchObject({
      meetingTotal: 0,
      deals: 0,
      target: null,
      achievement: { meetings: null, deals: null, transactionValue: null },
    });
  });

  it('supports returned corrections, protects verified entries and rejects stale reviews', async () => {
    const created = (await create(deal()).expect(201)).body;
    const verified = (await review(created).expect(200)).body;
    await request(server())
      .patch(`/api/sales/activities/${created.id}`)
      .set(auth(agent.token))
      .send({
        expectedRevision: verified.revision,
        activity: deal({ value: 3000000 }),
      })
      .expect(409);
    await review(created, 'returned').expect(409);
    const returned = (await review(verified, 'returned', admin).expect(200))
      .body;
    expect((await performance(agent.token, true))[0].deals).toBe(0);
    const corrected = (
      await request(server())
        .patch(`/api/sales/activities/${created.id}`)
        .set(auth(agent.token))
        .send({
          expectedRevision: returned.revision,
          activity: deal({ value: 3000000 }),
        })
        .expect(200)
    ).body;
    expect(corrected).toMatchObject({
      status: 'pending',
      revision: 4,
      review: { status: 'returned' },
    });
    await review(returned).expect(409);
    await review(corrected).expect(200);
    expect((await performance(agent.token, true))[0]).toMatchObject({
      deals: 1,
      transactionValues: { EGP: 3000000 },
    });
    await request(server())
      .patch(`/api/sales/activities/${created.id}`)
      .set(auth(outsider.token))
      .send({ expectedRevision: 5, activity: deal() })
      .expect(404);
  });

  it('enforces current manager assignment and forbids self-verification even for managers', async () => {
    const { id: _id, employeeNumber: _number, ...fields } = manager.employee;
    await request(server())
      .patch(`/api/employees/${manager.employee.id}`)
      .set(auth(admin))
      .send({ ...fields, salesEnabled: true })
      .expect(200);
    const own = (await create(meeting(), manager.token).expect(201)).body;
    await review(own, 'verified', manager.token).expect(403);
    const agentEntry = (await create().expect(201)).body;
    const {
      id: _agentId,
      employeeNumber: _agentNumber,
      ...agentFields
    } = agent.employee;
    await request(server())
      .patch(`/api/employees/${agent.employee.id}`)
      .set(auth(admin))
      .send({ ...agentFields, managerId: null })
      .expect(200);
    agent.employee.managerId = null;
    await review(agentEntry, 'verified', manager.token).expect(403);
    await review(agentEntry, 'verified', admin).expect(200);
    await review(own, 'verified', admin).expect(200);
    const {
      id: _idAgent,
      employeeNumber: _numberAgent,
      ...updatedAgentFields
    } = agent.employee;
    await request(server())
      .patch(`/api/employees/${agent.employee.id}`)
      .set(auth(admin))
      .send({ ...updatedAgentFields, salesEnabled: false })
      .expect(200);
    await create().expect(403);
    expect((await performance(agent.token, true))[0].meetingTotal).toBe(1);
  });

  it('validates dates, real estate fields, money and target revisions', async () => {
    for (const input of [
      meeting({ activityDate: '2026-10-08' }),
      meeting({ activityDate: '2026-09-30' }),
      meeting({ activityDate: '2026-02-30' }),
      meeting({ kind: 'viewing' }),
      meeting({ followUpDate: '2026-10-06' }),
      deal({ value: -1 }),
      deal({ value: 1.001 }),
      deal({ currency: 'egp' }),
      deal({ propertyReference: '' }),
      deal({ transactionType: 'reservation' }),
    ])
      await create(input).expect(400);
    await request(server())
      .get('/api/sales/performance?month=2026-13')
      .set(auth(admin))
      .expect(400);
    await request(server())
      .get('/api/sales/performance?month=2026-10&status=verified')
      .set(auth(admin))
      .expect(400);
    await request(server())
      .post('/api/sales/targets')
      .set(auth(admin))
      .send(target({ currency: null }))
      .expect(400);
    await request(server())
      .post('/api/sales/targets')
      .set(auth(admin))
      .send(target())
      .expect(201);
    await request(server())
      .post('/api/sales/targets')
      .set(auth(admin))
      .send(target())
      .expect(409);
    await request(server())
      .post('/api/sales/targets')
      .set(auth(admin))
      .send(target({ expectedRevision: 1, meetings: 4 }))
      .expect(201);
    expect((await performance(agent.token, true))[0].target).toMatchObject({
      meetings: 4,
      revision: 2,
    });
    // Company date, rather than UTC date, controls whether an activity is in the future.
    vi.setSystemTime(new Date('2026-10-07T22:00:00Z'));
    agent.token = await login(agent.employee.email);
    await create(
      meeting({ activityDate: '2026-10-08', followUpDate: null }),
    ).expect(201);
  });

  it('rolls back activity, verification and target writes when audit fails', async () => {
    const entry = (await create(deal()).expect(201)).body;
    const spy = vi
      .spyOn(app.get(AuditService), 'record')
      .mockImplementation(() => {
        throw new Error('Audit unavailable');
      });
    const id = randomUUID();
    await create(meeting(), agent.token, id).expect(500);
    await review(entry).expect(500);
    await request(server())
      .post('/api/sales/targets')
      .set(auth(admin))
      .send(target())
      .expect(500);
    spy.mockRestore();
    await request(server())
      .get(`/api/sales/activities/${id}`)
      .set(auth(agent.token))
      .expect(404);
    expect(
      (
        await request(server())
          .get(`/api/sales/activities/${entry.id}`)
          .set(auth(agent.token))
          .expect(200)
      ).body,
    ).toMatchObject({ status: 'pending', revision: 1 });
    expect((await performance(agent.token, true))[0].target).toBeNull();
  });

  it('persists activities and targets across restart and exports only authorized performance safely', async () => {
    const { id: _id, employeeNumber: _number, ...fields } = agent.employee;
    await request(server())
      .patch(`/api/employees/${agent.employee.id}`)
      .set(auth(admin))
      .send({ ...fields, name: '=Unsafe formula' })
      .expect(200);
    const entry = (await create(deal()).expect(201)).body;
    await review(entry).expect(200);
    await request(server())
      .post('/api/sales/targets')
      .set(auth(admin))
      .send(target())
      .expect(201);
    const other = (
      await create(
        deal({ dealReference: 'OTHER-CONTRACT', currency: 'USD', value: 500 }),
        outsider.token,
      ).expect(201)
    ).body;
    await review(other, 'verified', admin).expect(200);
    await app.close();
    await start();
    expect((await performance(agent.token, true))[0]).toMatchObject({
      deals: 1,
      target: { revision: 1 },
    });
    const csv = await request(server())
      .get('/api/sales/export?month=2026-10')
      .set(auth(manager.token))
      .expect(200);
    expect(csv.text).toContain("'=Unsafe formula");
    expect(csv.text).toContain('EGP 2500000.25');
    expect(csv.text).not.toContain('USD 500');
    expect(csv.headers['cache-control']).toBe('private, no-store');
    const filtered = await request(server())
      .get('/api/sales/performance?month=2026-10&department=Operations')
      .set(auth(admin))
      .expect(200);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].employeeId).toBe(outsider.employee.id);
    const audit = await request(server())
      .get(`/api/audit?recordId=${entry.id}`)
      .set(auth(admin))
      .expect(200);
    expect(audit.body.map((row: { action: string }) => row.action)).toEqual([
      'sales.activity.verified',
      'sales.activity.created',
    ]);
  });
});
