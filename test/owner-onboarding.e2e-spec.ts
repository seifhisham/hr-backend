import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { AttendanceLocationService } from '../src/attendance/attendance-location.service.js';
import { tokenHash } from '../src/common/security/credentials.js';
import { totp, seal } from '../src/owner/owner-crypto.js';
import { platformTestQuery, testCompanyId } from './postgres.setup.js';

describe('Platform owner and company onboarding', () => {
  let app: INestApplication,
    setupToken: string,
    ownerToken: string,
    adminToken: string,
    secret: string,
    recoveryCodes: string[];
  const password = 'Owner123',
    email = 'owner@test.local';
  const headers = (token: string) => ({ Authorization: 'Bearer ' + token });
  const http = () => app.getHttpServer();
  const policy = {
    address: 'First office',
    latitude: 30,
    longitude: 31,
    radiusMeters: 50,
    trackingRadiusMeters: 150,
    trackingGraceMinutes: 5,
  };
  const companyInput = (workspace = 'new-customer') => ({
    requestId: randomUUID(),
    workspace,
    name: 'New Customer',
    timezone: 'Africa/Cairo',
    adminEmail: 'customer-admin@test.local',
    adminName: 'Customer Admin',
  });
  async function createCompany(workspace?: string) {
    return (
      await request(http())
        .post('/api/owner/companies')
        .set(headers(ownerToken))
        .send(companyInput(workspace))
        .expect(201)
    ).body.id as string;
  }
  async function invite(id: string, key = randomUUID()) {
    return (
      await request(http())
        .post(`/api/owner/companies/${id}/invitation`)
        .set(headers(ownerToken))
        .send({ requestId: key })
        .expect(201)
    ).body;
  }
  const invitationToken = (path: string) =>
    new URLSearchParams(path.split('#')[1]).get('token')!;
  async function accept(id: string) {
    const link = await invite(id);
    return request(http())
      .post('/api/onboarding/accept')
      .send({
        token: invitationToken(link.path),
        password,
        name: 'Customer Admin',
        branchName: 'Actual office',
        policy,
      })
      .expect(201);
  }
  const status = (id: string, to: string, from: string) =>
    request(http())
      .post(`/api/owner/companies/${id}/status`)
      .set(headers(ownerToken))
      .send({
        status: to,
        expectedStatus: from,
        reason: 'Owner reviewed lifecycle action',
      });
  function customerLogin(workspace = 'new-customer') {
    return request(http())
      .post('/api/auth/login')
      .send({ workspace, email: 'customer-admin@test.local', password });
  }
  beforeEach(async () => {
    vi.stubEnv('HR_OWNER_ENCRYPTION_KEY', 'a'.repeat(64));
    vi.stubEnv('HR_ADMIN_EMAIL', 'company-admin@test.local');
    vi.stubEnv('HR_ADMIN_PASSWORD', password);
    setupToken = randomBytes(32).toString('base64url');
    await platformTestQuery(
      "INSERT INTO platform_owners(id,email,name,setup_hash,setup_expires) VALUES($1,$2,'Platform Owner',$3,now()+interval '1 hour')",
      [randomUUID(), email, tokenHash(setupToken)],
    );
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
    const prepared = (
      await request(http())
        .post('/api/owner/setup/prepare')
        .send({ token: setupToken })
        .expect(201)
    ).body;
    secret = prepared.secret;
    const completed = (
      await request(http())
        .post('/api/owner/setup/complete')
        .send({
          token: setupToken,
          name: 'Platform Owner',
          password,
          code: totp(secret, Math.floor(Date.now() / 30000)),
        })
        .expect(201)
    ).body;
    recoveryCodes = completed.recoveryCodes;
    ownerToken = (
      await request(http())
        .post('/api/owner/login')
        .send({ email, password, recoveryCode: recoveryCodes[0] })
        .expect(201)
    ).body.token;
    adminToken = (
      await request(http())
        .post('/api/auth/login')
        .send({
          workspace: 'test-company',
          email: 'company-admin@test.local',
          password,
        })
        .expect(201)
    ).body.token;
  });
  afterEach(async () => {
    await app?.close();
  });
  it('owner branch limits are audited, company-specific and enforced for concurrent creation', async () => {
    const setLimit = (branchLimit: number | null, token = ownerToken) =>
      request(http())
        .post(`/api/owner/companies/${testCompanyId}/branch-limit`)
        .set(headers(token))
        .send({ branchLimit, reason: 'Owner updated customer allowance' });
    await setLimit(1, adminToken).expect(401);
    await setLimit(0).expect(400);
    await setLimit(1.5).expect(400);
    await setLimit(1).expect(201);
    const branches = (
      await request(http())
        .get('/api/branches')
        .set(headers(adminToken))
        .expect(200)
    ).body;
    const add = (code: string) =>
      request(http())
        .post('/api/branches')
        .set(headers(adminToken))
        .send({ ...policy, code, name: code, active: false });
    await add('blocked').expect(409);
    await request(http())
      .patch(`/api/branches/${branches[0].id}`)
      .set(headers(adminToken))
      .send({ ...policy, code: 'main', name: 'Updated main', active: true })
      .expect(200);
    await setLimit(2).expect(201);
    const results = await Promise.all([add('second'), add('third')]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    await setLimit(1).expect(409);
    const other = await createCompany('other-branch-limit');
    const registry = (
      await request(http())
        .get('/api/owner/companies')
        .set(headers(ownerToken))
        .expect(200)
    ).body;
    expect(
      registry.find((company: { id: string }) => company.id === testCompanyId),
    ).toMatchObject({ branchLimit: 2, branchCount: 2 });
    expect(
      registry.find((company: { id: string }) => company.id === other),
    ).toMatchObject({ branchLimit: null, branchCount: 1 });
    const audit = (
      await request(http())
        .get('/api/owner/audit')
        .set(headers(ownerToken))
        .expect(200)
    ).body;
    expect(
      audit.some(
        (event: { action: string; companyId: string }) =>
          event.action === 'company.branch_limit_changed' &&
          event.companyId === testCompanyId,
      ),
    ).toBe(true);
    await setLimit(null).expect(201);
    await add('unlimited').expect(201);
  });
  it('reissuing an unenrolled owner link preserves its pending authenticator key', async () => {
    const oldToken = randomBytes(32).toString('base64url');
    await platformTestQuery(
      "UPDATE platform_owners SET password_hash=NULL,setup_hash=$1,setup_expires=now()-interval '1 minute',pending_secret=$2 WHERE email=$3",
      [tokenHash(oldToken), seal(secret), email],
    );
    const database = (
      await platformTestQuery('SELECT current_database() AS name')
    ).rows[0].name as string;
    expect(database).toMatch(/^hr_rest_test_[a-f0-9]+$/);
    const url = new URL(process.env.HR_PG_TEST_ADMIN_URL!);
    url.pathname = '/' + database;
    const directory = mkdtempSync(join(tmpdir(), 'hr-owner-renew-test-')),
      output = join(directory, 'setup.json');
    try {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/owner-bootstrap.mjs',
          '--email',
          email,
          '--output',
          output,
          '--base-url',
          'http://localhost:3003',
        ],
        {
          env: { ...process.env, HR_PG_MIGRATION_URL: url.href },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(0);
      const info = JSON.parse(readFileSync(output, 'utf8')) as {
        setupUrl: string;
      };
      const token = invitationToken(info.setupUrl);
      await request(http())
        .post('/api/owner/setup/prepare')
        .send({ token: oldToken })
        .expect(401);
      const prepared = (
        await request(http())
          .post('/api/owner/setup/prepare')
          .send({ token })
          .expect(201)
      ).body;
      expect(prepared.secret === secret).toBe(true);
    } finally {
      try {
        unlinkSync(output);
      } finally {
        rmdirSync(directory);
      }
    }
  });

  it('keeps owner credentials, cookies, data and company privileges separate', async () => {
    const owner = await request(http())
      .get('/api/owner/me')
      .set(headers(ownerToken))
      .expect(200);
    expect(owner.body.email).toBe(email);
    expect(owner.body.companyId).toBeUndefined();
    await request(http())
      .get('/api/employees')
      .set(headers(ownerToken))
      .expect(401);
    await request(http())
      .get('/api/owner/companies')
      .set(headers(adminToken))
      .expect(401);
    await request(http())
      .get('/api/employees')
      .set('Cookie', 'hr_owner_session=' + ownerToken)
      .expect(401);
    await request(http())
      .get('/api/owner/companies')
      .set('Cookie', 'hr_owner_session=' + ownerToken)
      .expect(200);
    await request(http())
      .post('/api/owner/companies')
      .set(headers(ownerToken))
      .set('Origin', 'https://untrusted.example')
      .send(companyInput())
      .expect(403);
    const companies = (
      await request(http())
        .get('/api/owner/companies')
        .set(headers(ownerToken))
        .expect(200)
    ).body;
    expect(companies).toHaveLength(1);
    expect(companies[0].id).toBe(testCompanyId);
    expect(companies[0].employees).toBeUndefined();
    const store = app.get(DatabaseService);
    for (const table of [
      'platform_owners',
      'platform_sessions',
      'platform_audit',
      'platform_invitations',
    ])
      await expect(
        store.prepare('SELECT * FROM ' + table).all(),
      ).rejects.toMatchObject({ code: '42501' });
    await expect(
      store.transaction(() =>
        store
          .prepare("SELECT hr_owner_command(?, 'companies', '{}')")
          .get('invalid'),
      ),
    ).rejects.toMatchObject({ code: 'HR401' });
  });
  it('enforces MFA, prevents code replay, consumes recovery codes once and revokes owner sessions', async () => {
    await request(http())
      .post('/api/owner/setup/prepare')
      .send({ token: setupToken })
      .expect(401);
    const code = totp(secret, Math.floor(Date.now() / 30000) + 1);
    const signed = await request(http())
      .post('/api/owner/login')
      .send({ email, password, code })
      .expect(201);
    expect(signed.headers['set-cookie'][0]).toContain('hr_owner_session=');
    expect(signed.headers['set-cookie'][0]).toContain('Path=/api/owner');
    expect(signed.headers['set-cookie'][0]).toContain('HttpOnly');
    await request(http())
      .post('/api/owner/login')
      .send({ email, password, code })
      .expect(401);
    await request(http())
      .post('/api/owner/login')
      .send({ email, password, recoveryCode: recoveryCodes[0] })
      .expect(401);
    await request(http())
      .post('/api/owner/login')
      .send({ email, password })
      .expect(400);
    await request(http())
      .post('/api/owner/logout')
      .set(headers(signed.body.token))
      .expect(201);
    await request(http())
      .get('/api/owner/me')
      .set(headers(signed.body.token))
      .expect(401);
    const audit = (
      await request(http())
        .get('/api/owner/audit')
        .set(headers(ownerToken))
        .expect(200)
    ).body;
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain(recoveryCodes[0]);
    expect(JSON.stringify(audit)).not.toContain(ownerToken);
  });
  it('persists login throttling and permits separately keyed unknown-account limits', async () => {
    for (let i = 0; i < 5; i++)
      await request(http())
        .post('/api/owner/login')
        .send({ email, password: 'wrong password', code: '000000' })
        .expect(401);
    await request(http())
      .post('/api/owner/login')
      .send({ email, password, recoveryCode: recoveryCodes[1] })
      .expect(429);
    await request(http())
      .post('/api/owner/login')
      .send({ email: 'absent@test.local', password, code: '000000' })
      .expect(401);
    await platformTestQuery(
      "UPDATE platform_login_limits SET reset_at=now()-interval '1 minute'",
    );
    await request(http())
      .post('/api/owner/login')
      .send({ email, password, recoveryCode: recoveryCodes[1] })
      .expect(201);
  });
  it('recovers MFA through an authenticated, expiring setup link and revokes all old sessions', async () => {
    await request(http())
      .post('/api/owner/recovery')
      .set(headers(ownerToken))
      .send({})
      .expect(400);
    const link = (
      await request(http())
        .post('/api/owner/recovery')
        .set(headers(ownerToken))
        .send({ password, recoveryCode: recoveryCodes[1] })
        .expect(201)
    ).body;
    const token = invitationToken(link.path),
      prepared = (
        await request(http())
          .post('/api/owner/setup/prepare')
          .send({ token })
          .expect(201)
      ).body;
    expect(prepared.secret).not.toBe(secret);
    await request(http())
      .post('/api/owner/setup/complete')
      .send({
        token,
        name: 'Recovered Owner',
        password: password + 'new',
        code: totp(prepared.secret, Math.floor(Date.now() / 30000)),
      })
      .expect(201);
    await request(http())
      .get('/api/owner/companies')
      .set(headers(ownerToken))
      .expect(401);
    await request(http())
      .post('/api/owner/login')
      .send({
        email,
        password: password + 'new',
        recoveryCode: recoveryCodes[1],
      })
      .expect(401);
    await request(http())
      .post('/api/owner/setup/prepare')
      .send({ token })
      .expect(401);
  });
  it('provisions two companies with idempotent retries and administrator-first activation', async () => {
    const input = companyInput(),
      first = (
        await request(http())
          .post('/api/owner/companies')
          .set(headers(ownerToken))
          .send(input)
          .expect(201)
      ).body;
    const retry = (
      await request(http())
        .post('/api/owner/companies')
        .set(headers(ownerToken))
        .send(input)
        .expect(201)
    ).body;
    expect(retry).toEqual(first);
    await request(http())
      .post('/api/owner/companies')
      .set(headers(ownerToken))
      .send({ ...input, name: 'Different' })
      .expect(409);
    await request(http())
      .post('/api/owner/companies')
      .set(headers(ownerToken))
      .send(companyInput())
      .expect(409);
    await status(first.id, 'active', 'provisioning').expect(409);
    await customerLogin().expect(401);
    await accept(first.id);
    await status(first.id, 'active', 'provisioning').expect(201);
    const firstSession = await customerLogin().expect(201);
    const second = await createCompany('other-customer');
    await accept(second);
    await status(second, 'active', 'provisioning').expect(201);
    const secondSession = await customerLogin('other-customer').expect(201);
    const branchesA = (
      await request(http())
        .get('/api/branches')
        .set(headers(firstSession.body.token))
        .expect(200)
    ).body;
    const branchesB = (
      await request(http())
        .get('/api/branches')
        .set(headers(secondSession.body.token))
        .expect(200)
    ).body;
    expect(branchesA).toHaveLength(1);
    expect(branchesA[0].latitude).toBe(30);
    expect(branchesA[0].id).not.toBe(branchesB[0].id);
    expect(
      (
        await request(http())
          .get('/api/schedules')
          .set(headers(firstSession.body.token))
          .expect(200)
      ).body,
    ).toHaveLength(2);
    await request(http())
      .patch('/api/branches/' + branchesB[0].id)
      .set(headers(firstSession.body.token))
      .send({ ...policy, code: 'main', name: 'Not allowed', active: true })
      .expect(404);
    await request(http())
      .get('/api/owner/audit')
      .set(headers(firstSession.body.token))
      .expect(401);
    expect(
      (
        await request(http())
          .get('/api/employees')
          .set(headers(firstSession.body.token))
          .expect(200)
      ).body,
    ).toEqual([]);
  });
  it('reuses invitation requests, revokes replacements and consumes invitations atomically', async () => {
    const id = await createCompany(),
      key = randomUUID(),
      link = await invite(id, key),
      retried = await invite(id, key);
    expect(retried.path).toBe(link.path);
    const replacement = await invite(id),
      oldToken = invitationToken(link.path),
      token = invitationToken(replacement.path);
    await request(http())
      .post('/api/onboarding/preview')
      .send({ token: oldToken })
      .expect(401);
    const preview = await request(http())
      .post('/api/onboarding/preview')
      .send({ token })
      .expect(201);
    expect(preview.body.email).toBe('customer-admin@test.local');
    const body = {
      token,
      password,
      name: 'Customer Admin',
      branchName: 'Main',
      policy,
    };
    const responses = await Promise.all([
      request(http()).post('/api/onboarding/accept').send(body),
      request(http()).post('/api/onboarding/accept').send(body),
    ]);
    expect(
      responses.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([201, 401]);
    await request(http())
      .post('/api/onboarding/preview')
      .send({ token })
      .expect(401);
    expect(
      (
        await platformTestQuery(
          'SELECT count(*) n FROM users WHERE company_id=$1',
          [id],
        )
      ).rows[0].n,
    ).toBe('1');
  });
  it('rejects expired, revoked and malformed invitations without creating administrator accounts', async () => {
    const id = await createCompany(),
      link = await invite(id),
      token = invitationToken(link.path);
    await platformTestQuery(
      "UPDATE platform_invitations SET expires=now()-interval '1 minute' WHERE company_id=$1",
      [id],
    );
    await request(http())
      .post('/api/onboarding/preview')
      .send({ token })
      .expect(401);
    const next = await invite(id);
    await request(http())
      .post(`/api/owner/companies/${id}/revoke-invitation`)
      .set(headers(ownerToken))
      .send({ reason: 'Invitation recipient changed' })
      .expect(201);
    await request(http())
      .post('/api/onboarding/accept')
      .send({
        token: invitationToken(next.path),
        password,
        name: 'Admin',
        branchName: 'Main',
        policy,
      })
      .expect(401);
    await request(http())
      .post('/api/owner/companies')
      .set(headers(ownerToken))
      .send({ ...companyInput('bad-zone'), timezone: 'Not/AZone' })
      .expect(400);
    expect(
      (
        await platformTestQuery(
          'SELECT count(*) n FROM users WHERE company_id=$1',
          [id],
        )
      ).rows[0].n,
    ).toBe('0');
  });
  it('rolls back provisioning when platform audit fails and supports a clean retry', async () => {
    const input = companyInput('rollback-company');
    await platformTestQuery(
      "CREATE FUNCTION fail_owner_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='company.created' THEN RAISE EXCEPTION 'Test audit failure'; END IF; RETURN NEW; END $$",
    );
    await platformTestQuery(
      'CREATE TRIGGER fail_owner_audit BEFORE INSERT ON platform_audit FOR EACH ROW EXECUTE FUNCTION fail_owner_audit()',
    );
    try {
      await request(http())
        .post('/api/owner/companies')
        .set(headers(ownerToken))
        .send(input)
        .expect(503);
      expect(
        (
          await platformTestQuery(
            'SELECT id FROM companies WHERE workspace_code=$1',
            [input.workspace],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await platformTestQuery(
        'DROP TRIGGER fail_owner_audit ON platform_audit',
      );
      await platformTestQuery('DROP FUNCTION fail_owner_audit()');
    }
    await request(http())
      .post('/api/owner/companies')
      .set(headers(ownerToken))
      .send(input)
      .expect(201);
  });
  it('suspends and resumes without changing attendance or charging for missing coverage', async () => {
    const id = await createCompany();
    await accept(id);
    await status(id, 'active', 'provisioning').expect(201);
    const signed = await customerLogin().expect(201),
      token = signed.body.token;
    const schedule = (
      await request(http())
        .get('/api/schedules')
        .set(headers(token))
        .expect(200)
    ).body[0];
    const employee = (
      await request(http())
        .post('/api/employees')
        .set(headers(token))
        .send({
          nationalId: 'LIFECYCLE',
          name: 'Customer Employee',
          email: 'employee@test.local',
          department: 'Operations',
          jobTitle: 'Engineer',
          startDate: '2026-01-01',
          scheduleId: schedule.id,
          active: true,
          role: 'employee',
          password,
        })
        .expect(201)
    ).body;
    const record = (
      await request(http())
        .post('/api/attendance')
        .set(headers(token))
        .send({
          employeeId: employee.id,
          workDate: '2026-10-01',
          checkIn: '2026-10-01T07:00:00Z',
          checkOut: null,
          reason: 'Verified manual attendance',
        })
        .expect(201)
    ).body;
    const tracking = {
      status: 'outside',
      outsideSince: '2026-10-01T07:00:00Z',
      returnBy: '2026-10-01T07:05:00Z',
      lastCapturedAt: '2026-10-01T07:01:00Z',
      actor: signed.body.user,
    };
    await platformTestQuery(
      'INSERT INTO attendance_location(company_id,attendance_id,data) VALUES($1,$2,$3) ON CONFLICT(company_id,attendance_id) DO UPDATE SET data=excluded.data',
      [id, record.id, JSON.stringify(tracking)],
    );
    const before = (
      await platformTestQuery('SELECT * FROM attendance WHERE company_id=$1', [
        id,
      ])
    ).rows;
    await status(id, 'suspended', 'active').expect(201);
    await request(http()).get('/api/employees').set(headers(token)).expect(401);
    await customerLogin().expect(401);
    const state = JSON.parse(
      (
        await platformTestQuery(
          'SELECT data FROM attendance_location WHERE company_id=$1',
          [id],
        )
      ).rows[0].data,
    );
    expect(state.status).toBe('unavailable');
    expect(state.returnBy).toBeNull();
    expect(await app.get(DatabaseService).activeCompanyIds()).not.toContain(id);
    await status(id, 'active', 'suspended').expect(201);
    await request(http()).get('/api/employees').set(headers(token)).expect(401);
    await customerLogin().expect(201);
    expect(
      (
        await platformTestQuery(
          'SELECT * FROM attendance WHERE company_id=$1',
          [id],
        )
      ).rows,
    ).toEqual(before);
    await status(id, 'archived', 'active').expect(201);
    await customerLogin().expect(401);
    await status(id, 'active', 'archived').expect(409);
    await request(http())
      .post(`/api/owner/companies/${id}/invitation`)
      .set(headers(ownerToken))
      .send({ requestId: randomUUID() })
      .expect(409);
  });
  it('rejects a stale status action and blocks a queued response when suspension commits', async () => {
    const id = await createCompany();
    await accept(id);
    await status(id, 'active', 'provisioning').expect(201);
    const login = await customerLogin().expect(201);
    const location = app.get(AttendanceLocationService),
      original = location.views.bind(location);
    let release!: () => void, reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        reached = resolve;
      });
    const spy = vi
      .spyOn(location, 'views')
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        reached();
        await waiting;
        return result;
      });
    const response = request(http())
      .get('/api/attendance?from=2026-10-01&to=2026-10-01')
      .set(headers(login.body.token))
      .then((value) => value);
    try {
      await started;
      await status(id, 'suspended', 'active').expect(201);
      await status(id, 'archived', 'active').expect(409);
      release();
      expect((await response).status).toBeGreaterThanOrEqual(400);
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it('limits incorrect enrollment codes and rejects expired setup links', async () => {
    const pending = randomBytes(32).toString('base64url');
    await platformTestQuery(
      "INSERT INTO platform_owners(id,email,name,setup_hash,setup_expires) VALUES($1,'pending@test.local','Pending',$2,now()+interval '1 hour')",
      [randomUUID(), tokenHash(pending)],
    );
    const prepared = (
      await request(http())
        .post('/api/owner/setup/prepare')
        .send({ token: pending })
        .expect(201)
    ).body;
    const valid = totp(prepared.secret, Math.floor(Date.now() / 30000));
    const wrong = String((Number(valid) + 1000) % 1000000).padStart(6, '0');
    for (let i = 0; i < 10; i++)
      await request(http())
        .post('/api/owner/setup/complete')
        .send({ token: pending, password, name: 'Pending', code: wrong })
        .expect(401);
    await request(http())
      .post('/api/owner/setup/complete')
      .send({ token: pending, password, name: 'Pending', code: valid })
      .expect(401);
    await platformTestQuery(
      "UPDATE platform_owners SET setup_failures=0,setup_expires=now()-interval '1 minute' WHERE email='pending@test.local'",
    );
    await request(http())
      .post('/api/owner/setup/prepare')
      .send({ token: pending })
      .expect(401);
  });
  it('rolls back session revocation and company status together when lifecycle audit fails', async () => {
    await platformTestQuery(
      "CREATE FUNCTION fail_owner_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='company.status_changed' THEN RAISE EXCEPTION 'Test lifecycle audit failure'; END IF; RETURN NEW; END $$",
    );
    await platformTestQuery(
      'CREATE TRIGGER fail_owner_status BEFORE INSERT ON platform_audit FOR EACH ROW EXECUTE FUNCTION fail_owner_status()',
    );
    try {
      await status(testCompanyId, 'suspended', 'active').expect(503);
      expect(
        (
          await platformTestQuery('SELECT status FROM companies WHERE id=$1', [
            testCompanyId,
          ])
        ).rows[0].status,
      ).toBe('active');
      await request(http())
        .get('/api/employees')
        .set(headers(adminToken))
        .expect(200);
    } finally {
      await platformTestQuery(
        'DROP TRIGGER fail_owner_status ON platform_audit',
      );
      await platformTestQuery('DROP FUNCTION fail_owner_status()');
    }
  });
});
