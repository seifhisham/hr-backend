import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AttendanceEvidence } from '../src/attendance/attendance-evidence.service.js';
import { AttendanceService } from '../src/attendance/attendance.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { Employee } from '../src/employees/types/employee.type.js';
import { RequestsService } from '../src/requests/requests.service.js';
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
    const { id: _id, ...values } = employee;
    return values;
  };

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
          employeeCode: 'EMP-001',
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
          employeeCode: 'EMP-002',
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
    ).toEqual([]);
  });

  it('requires authentication, isolates employee access, and permits cookie sessions', async () => {
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
    const record = (
      await submit('/api/attendance/check-in', employeeToken).expect(201)
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
    expect(metadata.exif).toBeUndefined();
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
    expect(evidence[0].policy.radiusMeters).toBe(100);
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
          employeeCode: 'EMP-002',
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
        employeeCode: 'EMP-002',
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
    expect(csv.text).toContain('EMP-001');
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
          employeeCode: 'HR-001',
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
    const { id: _id, ...values } = hr;
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
