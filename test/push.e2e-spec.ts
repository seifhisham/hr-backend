import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import sharp from 'sharp';
import { AttendanceLocationService } from '../src/attendance/attendance-location.service.js';
import { AppModule } from '../src/app.module.js';
import { tokenHash } from '../src/common/security/credentials.js';
import { RATE_LIMITS } from '../src/common/security/rate-limit.guard.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  NotificationsService,
  type Notification,
} from '../src/notifications/notifications.service.js';
import {
  FirebaseSender,
  deliveryFailure,
} from '../src/push/firebase-sender.js';
import { PushWorker } from '../src/push/push.worker.js';
import { provisionTestCompany, testCompanyId } from './postgres.setup.js';

let app: INestApplication;
let store: DatabaseService;
let worker: PushWorker;
const deviceId = randomUUID();
const token = 'test-fcm-registration-token-device-one';
const body = (changes = {}) => ({
  deviceId,
  token,
  platform: 'android',
  ...changes,
});
const auth = (session = 'session-a') => ({
  Authorization: `Bearer ${session}`,
});
const http = () => app.getHttpServer();
const register = (session = 'session-a', changes = {}) =>
  request(http())
    .post('/api/push/devices')
    .set(auth(session))
    .send(body(changes));
const rows = (table = 'push_devices') =>
  store.prepare(`SELECT * FROM ${table}`).all();
const event: Notification = {
  id: 'test-durable-audit-event',
  type: 'request-decided',
  title: 'Private title',
  message: 'Private HR details',
  createdAt: new Date().toISOString(),
  readAt: null,
};

async function session(
  companyId: string,
  id: string,
  value: string,
  role = 'admin',
) {
  await store.withCompany(companyId, async () => {
    await store
      .prepare(
        `INSERT INTO users(id,email,name,role,active,password_hash)
      VALUES(?,?,?,?,1,'test-only') ON CONFLICT DO NOTHING`,
      )
      .run(id, `${id}@test.local`, id, role);
    await store
      .prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)')
      .run(tokenHash(value), id, '2099-01-01T00:00:00.000Z');
  });
}

beforeEach(async () => {
  vi.stubEnv('HR_ADMIN_EMAIL', 'push-admin@test.local');
  vi.stubEnv('HR_ADMIN_PASSWORD', 'Push-test-password-2026');
  vi.stubEnv('HR_PUSH_ENABLED', 'false');
  app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication();
  await app.init();
  store = app.get(DatabaseService);
  worker = app.get(PushWorker);
  await session(testCompanyId, 'user-a', 'session-a');
  await session(testCompanyId, 'user-a', 'session-a-new');
  await session(testCompanyId, 'user-b', 'session-b');
});

afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('requires a live session, validates the exact Android schema, and rate limits registration', async () => {
  await request(http()).post('/api/push/devices').send(body()).expect(401);
  await request(http()).delete(`/api/push/devices/${deviceId}`).expect(401);
  for (const changes of [
    { userId: 'user-b' },
    { companyId: testCompanyId },
    { platform: 'ios' },
    { deviceId: 'firebase-fid' },
    { token: 'bad token' },
  ])
    await register('session-a', changes).expect(400);
  await request(http())
    .delete('/api/push/devices/not-a-uuid')
    .set(auth())
    .expect(400);
  for (let i = 5; i < RATE_LIMITS.push.requests - 1; i++)
    await register().expect(200);
  const denied = await register().expect(429);
  expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
  expect(await rows()).toHaveLength(1);
});

it('is idempotent, supports multiple devices, rotates tokens, and unregisters only one device', async () => {
  expect((await register().expect(200)).body).toEqual({
    deviceId,
    platform: 'android',
  });
  const original = (await rows())[0];
  await register().expect(200);
  expect((await rows())[0].binding_id).toBe(original.binding_id);
  expect((await rows())[0].registered_at).toEqual(original.registered_at);
  const second = randomUUID();
  await register('session-a', {
    deviceId: second,
    token: token + '-second',
  }).expect(200);
  await register('session-a', { token: token + '-rotated' }).expect(200);
  expect(await rows()).toHaveLength(2);
  expect((await rows()).find((row) => row.device_id === deviceId)?.token).toBe(
    token + '-rotated',
  );
  await request(http())
    .delete(`/api/push/devices/${deviceId}`)
    .set(auth())
    .expect(204);
  await request(http())
    .delete(`/api/push/devices/${deviceId}`)
    .set(auth())
    .expect(204);
  expect((await rows()).map((row) => row.device_id)).toEqual([second]);
});

it('transfers token ownership safely on account/company switches and fences stale delete and logout', async () => {
  await register().expect(200);
  await register('session-b').expect(200);
  await request(http())
    .delete(`/api/push/devices/${deviceId}`)
    .set(auth())
    .expect(204);
  expect((await rows())[0].user_id).toBe('user-b');
  const otherCompany = await provisionTestCompany('push-other');
  await session(otherCompany, 'user-c', 'session-c');
  await register('session-c').expect(200);
  expect(await rows()).toHaveLength(0);
  await request(http())
    .delete(`/api/push/devices/${deviceId}`)
    .set(auth('session-b'))
    .expect(204);
  await request(http())
    .post('/api/auth/logout')
    .set(auth('session-b'))
    .expect(201);
  await store.withCompany(otherCompany, async () => {
    expect((await rows())[0].user_id).toBe('user-c');
  });
  await register('session-a-new').expect(200);
  await request(http()).post('/api/auth/logout').set(auth()).expect(201);
  expect((await rows())[0].session_hash).toBe(tokenHash('session-a-new'));
  await request(http())
    .post('/api/auth/logout')
    .set(auth('session-a-new'))
    .expect(201);
  expect(await rows()).toHaveLength(0);
});

it('allows a token on only one installation and preserves devices from other sessions on revocation', async () => {
  await register().expect(200);
  const second = randomUUID();
  await register('session-a-new', { deviceId: second }).expect(200);
  expect((await rows()).map((row) => row.device_id)).toEqual([second]);
  await register('session-a', { token: token + '-other' }).expect(200);
  await request(http()).post('/api/auth/logout').set(auth()).expect(201);
  expect((await rows()).map((row) => row.device_id)).toEqual([second]);
  await store.prepare('DELETE FROM sessions WHERE user_id=?').run('user-a');
  expect(await rows()).toHaveLength(0);
});

function inbox() {
  return vi
    .spyOn(app.get(NotificationsService), 'list')
    .mockResolvedValue({ items: [event], unreadCount: 1 });
}

it('persists events before send, deduplicates per event/recipient/device, and processes devices independently', async () => {
  await register().expect(200);
  await register('session-a-new', {
    deviceId: randomUUID(),
    token: token + '-second',
  }).expect(200);
  inbox();
  const send = vi
    .spyOn(app.get(FirebaseSender), 'send')
    .mockImplementation(async (value) => {
      expect(await rows('push_events')).toHaveLength(1);
      expect(await rows('push_deliveries')).toHaveLength(2);
      if (value === token)
        throw { code: 'messaging/registration-token-not-registered' };
    });
  await worker.sweep();
  expect(send).toHaveBeenCalledTimes(2);
  expect((await rows())[0].token).toBe(token + '-second');
  expect(
    (await rows('push_deliveries'))
      .map((row) => row.state)
      .sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual(['failed', 'sent']);
  await worker.sweep();
  expect(send).toHaveBeenCalledTimes(2);
});

it('rechecks eligibility and read state before each send', async () => {
  await register().expect(200);
  const list = inbox();
  list
    .mockResolvedValueOnce({ items: [event], unreadCount: 1 })
    .mockResolvedValue({ items: [], unreadCount: 0 });
  const send = vi.spyOn(app.get(FirebaseSender), 'send');
  await worker.sweep();
  expect(send).not.toHaveBeenCalled();
  expect((await rows('push_deliveries'))[0].state).toBe('cancelled');
});

it('persists bounded transient retries across worker restarts and honors Retry-After', async () => {
  await register().expect(200);
  inbox();
  const send = vi.spyOn(app.get(FirebaseSender), 'send').mockRejectedValue({
    code: 'messaging/server-unavailable',
    httpResponse: { headers: { 'retry-after': '600' } },
  });
  const before = Date.now();
  await worker.sweep();
  let delivery = (await rows('push_deliveries'))[0];
  expect(delivery.state).toBe('pending');
  expect(
    new Date(delivery.next_attempt as string).getTime(),
  ).toBeGreaterThanOrEqual(before + 600000);
  await worker.sweep();
  expect(send).toHaveBeenCalledTimes(1);
  for (let i = 2; i <= 6; i++) {
    await store
      .prepare(
        "UPDATE push_deliveries SET next_attempt=now()-interval '1 second'",
      )
      .run();
    const restarted = new PushWorker(
      store,
      app.get(NotificationsService),
      app.get(FirebaseSender),
    );
    await restarted.sweep();
    delivery = (await rows('push_deliveries'))[0];
    expect(delivery.attempts).toBe(i);
  }
  expect(delivery.state).toBe('failed');
  expect(await rows()).toHaveLength(1);
});

it('does not delete a rotated binding when an older in-flight token is reported invalid', async () => {
  await register().expect(200);
  inbox();
  vi.spyOn(app.get(FirebaseSender), 'send').mockImplementation(async () => {
    await register('session-a-new', { token: token + '-rotated' }).expect(200);
    throw { code: 'messaging/registration-token-not-registered' };
  });
  await worker.sweep();
  expect((await rows())[0].token).toBe(token + '-rotated');
});

it('retries a pending delivery with the rotated token and cancels delivery after an account transfer', async () => {
  await register().expect(200);
  const list = inbox();
  const send = vi
    .spyOn(app.get(FirebaseSender), 'send')
    .mockRejectedValueOnce({ code: 'messaging/server-unavailable' })
    .mockResolvedValue();
  await worker.sweep();
  await register('session-a-new', { token: token + '-rotated' }).expect(200);
  await store
    .prepare(
      "UPDATE push_deliveries SET next_attempt=now()-interval '1 second'",
    )
    .run();
  await worker.sweep();
  expect(send.mock.calls.map((call) => call[0])).toEqual([
    token,
    token + '-rotated',
  ]);
  await store
    .prepare(
      "UPDATE push_deliveries SET state='pending',next_attempt=now()-interval '1 second'",
    )
    .run();
  await register('session-b', { token: token + '-rotated' }).expect(200);
  // Only the original user is eligible; the new account must never receive its queued alert.
  list.mockImplementation(async (actor) => ({
    items: actor.id === 'user-a' ? [event] : [],
    unreadCount: 0,
  }));
  await worker.sweep();
  expect(send).toHaveBeenCalledTimes(2);
  expect((await rows('push_deliveries'))[0].state).toBe('cancelled');
});

it('does not send a queued delivery after its session expires', async () => {
  await register().expect(200);
  inbox();
  const send = vi
    .spyOn(app.get(FirebaseSender), 'send')
    .mockRejectedValue({ code: 'messaging/server-unavailable' });
  await worker.sweep();
  await store
    .prepare('UPDATE sessions SET expires=? WHERE hash=?')
    .run('2000-01-01T00:00:00.000Z', tokenHash('session-a'));
  await store
    .prepare(
      "UPDATE push_deliveries SET next_attempt=now()-interval '1 second'",
    )
    .run();
  await worker.sweep();
  expect(send).toHaveBeenCalledTimes(1);
  expect((await rows('push_deliveries'))[0].state).toBe('cancelled');
});

it.each([
  'messaging/authentication-error',
  'messaging/mismatched-credential',
  'messaging/invalid-argument',
  'messaging/invalid-payload',
])('retains tokens on configuration/payload failure: %s', async (code) => {
  await register().expect(200);
  inbox();
  vi.spyOn(app.get(FirebaseSender), 'send').mockRejectedValue({ code });
  await worker.sweep();
  expect(await rows()).toHaveLength(1);
  expect((await rows('push_deliveries'))[0].state).toBe('failed');
});

it('recovers an expired crash lease and prevents parallel workers from claiming the same delivery', async () => {
  await register().expect(200);
  inbox();
  const send = vi.spyOn(app.get(FirebaseSender), 'send').mockResolvedValue();
  await store
    .prepare(
      'INSERT INTO push_events(user_id,notification_id,type) VALUES(?,?,?)',
    )
    .run('user-a', event.id, event.type);
  await store
    .prepare(
      `INSERT INTO push_deliveries(user_id,notification_id,device_id,lease_id,lease_until,attempts)
    SELECT user_id,?,device_id,?,now()-interval '1 second',1 FROM push_devices`,
    )
    .run(event.id, randomUUID());
  await Promise.all([
    worker.sweep(),
    new PushWorker(
      store,
      app.get(NotificationsService),
      app.get(FirebaseSender),
    ).sweep(),
  ]);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await rows('push_deliveries'))[0].attempts).toBe(2);
});

it('uses actual pending-request recipients and branch grants; Firebase failure cannot undo a committed HR request', async () => {
  const admin = (await store
    .prepare('SELECT id FROM users WHERE email=?')
    .get('push-admin@test.local'))!;
  await store
    .prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)')
    .run(tokenHash('bootstrap-admin'), admin.id, '2099-01-01T00:00:00.000Z');
  const schedule = (await store
    .prepare('SELECT id FROM schedules LIMIT 1')
    .get())!;
  const employee = (
    await request(http())
      .post('/api/employees')
      .set(auth('bootstrap-admin'))
      .send({
        nationalId: 'push-employee',
        name: 'Push Employee',
        email: 'employee@push.local',
        department: 'Engineering',
        jobTitle: 'Engineer',
        startDate: '2026-01-01',
        scheduleId: schedule.id,
        active: true,
        role: 'employee',
        password: 'Employee-push-password-2026',
      })
      .expect(201)
  ).body;
  const user = (await store
    .prepare('SELECT id FROM users WHERE employee_id=?')
    .get(employee.id))!;
  await store
    .prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)')
    .run(tokenHash('employee-session'), user.id, '2099-01-01T00:00:00.000Z');
  await register('session-a').expect(200);
  await session(testCompanyId, 'scoped-hr', 'hr-session', 'hr');
  await register('hr-session', {
    deviceId: randomUUID(),
    token: token + '-hr',
  }).expect(200);
  await register('employee-session', {
    deviceId: randomUUID(),
    token: token + '-employee',
  }).expect(200);
  const otherCompany = await provisionTestCompany('push-delivery-other');
  await session(otherCompany, 'other-admin', 'other-session');
  await register('other-session', {
    deviceId: randomUUID(),
    token: token + '-other-company',
  }).expect(200);
  const send = vi
    .spyOn(app.get(FirebaseSender), 'send')
    .mockRejectedValue({ code: 'messaging/server-unavailable' });
  const submitted = (
    await request(http())
      .post('/api/requests')
      .set(auth('employee-session'))
      .send({
        type: 'leave',
        from: '2026-11-02',
        to: '2026-11-02',
        reason: 'Sensitive private reason',
      })
      .expect(201)
  ).body;
  expect(send).not.toHaveBeenCalled();
  await worker.tick();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBe(token);
  expect(
    await store
      .prepare('SELECT status FROM employee_requests WHERE id=?')
      .get(submitted.id),
  ).toMatchObject({ status: 'pending' });
  const branch = (await store
    .prepare('SELECT id FROM branches LIMIT 1')
    .get())!;
  await store
    .prepare('INSERT INTO hr_branch_grants(user_id,branch_id) VALUES(?,?)')
    .run('scoped-hr', branch.id);
  await worker.sweep();
  expect(send.mock.calls[1][0]).toBe(token + '-hr');
  await store
    .prepare('DELETE FROM hr_branch_grants WHERE user_id=?')
    .run('scoped-hr');
  await store
    .prepare(
      "UPDATE push_deliveries SET next_attempt=now()-interval '1 second'",
    )
    .run();
  await worker.sweep();
  expect(
    (await rows('push_deliveries')).find((row) => row.user_id === 'scoped-hr')
      ?.state,
  ).toBe('cancelled');
  expect(send.mock.calls.every((call) => call[0] !== token + '-employee')).toBe(
    true,
  );
  expect(
    await store
      .prepare('SELECT 1 FROM audit WHERE record_id=? AND action=?')
      .get(submitted.id, 'request.submitted'),
  ).toBeDefined();
});

it('classifies retries without retaining untrusted error text and supports date Retry-After', () => {
  const now = Date.now();
  expect(
    deliveryFailure(
      {
        code: 'messaging/server-unavailable',
        httpResponse: {
          headers: { 'retry-after': new Date(now + 3600000).toUTCString() },
        },
      },
      1,
      now,
    ).delay,
  ).toBeGreaterThan(3599000);
  expect(deliveryFailure({ code: 'raw-token-or-secret' }, 1).code).toBe(
    'unknown',
  );
  expect(
    deliveryFailure({ code: 'messaging/invalid-argument' }, 1).invalid,
  ).toBe(false);
  expect(
    deliveryFailure({ code: 'messaging/server-unavailable' }, 6).retry,
  ).toBe(false);
});

it('uses the real manager-review, HR-decision and employee inbox events without inventing recipients', async () => {
  const schedule = (await store
    .prepare('SELECT id FROM schedules LIMIT 1')
    .get())!;
  const createEmployee = async (
    name: string,
    role: string,
    managerId: string | null = null,
  ) => {
    const employee = (
      await request(http())
        .post('/api/employees')
        .set(auth())
        .send({
          nationalId: name,
          name,
          email: `${name}@workflow.local`,
          department: 'Engineering',
          jobTitle: 'Engineer',
          startDate: '2026-01-01',
          scheduleId: schedule.id,
          active: true,
          role,
          managerId,
          password: 'Workflow-test-password-2026',
        })
        .expect(201)
    ).body;
    const user = (await store
      .prepare('SELECT id FROM users WHERE employee_id=?')
      .get(employee.id))!;
    await store
      .prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)')
      .run(tokenHash(name), user.id, '2099-01-01T00:00:00.000Z');
    await register(name, {
      deviceId: randomUUID(),
      token: token + '-' + name,
    }).expect(200);
    return employee;
  };
  const manager = await createEmployee('manager', 'manager');
  await createEmployee('report', 'employee', manager.id);
  await register().expect(200);
  const submitted = (
    await request(http())
      .post('/api/requests')
      .set(auth('report'))
      .send({
        type: 'leave',
        from: '2026-11-03',
        to: '2026-11-03',
        reason: 'Private request details',
      })
      .expect(201)
  ).body;
  const send = vi.spyOn(app.get(FirebaseSender), 'send').mockResolvedValue();
  await worker.sweep();
  expect(send.mock.calls.map(([value, , type]) => [value, type])).toEqual([
    [token + '-manager', 'manager-review-required'],
  ]);
  send.mockClear();
  await request(http())
    .patch(`/api/requests/${submitted.id}/manager-review`)
    .set(auth('manager'))
    .send({ status: 'approved', reason: 'Private manager recommendation' })
    .expect(200);
  await worker.sweep();
  expect(send.mock.calls.map(([value, , type]) => [value, type])).toEqual(
    expect.arrayContaining([
      [token + '-report', 'manager-reviewed'],
      [token, 'pending-request'],
    ]),
  );
  expect(send).toHaveBeenCalledTimes(2);
  send.mockClear();
  await request(http())
    .patch(`/api/requests/${submitted.id}/decision`)
    .set(auth())
    .send({ status: 'approved', reason: 'Private HR decision' })
    .expect(200);
  await worker.sweep();
  expect(send.mock.calls.map(([value, , type]) => [value, type])).toEqual([
    [token + '-report', 'request-decided'],
  ]);
  send.mockClear();
  await request(http())
    .patch(`/api/requests/${submitted.id}/reopen`)
    .set(auth())
    .send({ reason: 'Private HR correction' })
    .expect(200);
  await worker.sweep();
  expect(send.mock.calls.map(([value, , type]) => [value, type])).toEqual(
    expect.arrayContaining([
      [token + '-report', 'request-reopened'],
      [token + '-manager', 'manager-review-required'],
    ]),
  );
  expect(send).toHaveBeenCalledTimes(2);
});

async function directReportAttendance() {
  const schedule = (await store
    .prepare('SELECT id FROM schedules LIMIT 1')
    .get())!;
  const create = async (
    name: string,
    role: string,
    managerId: string | null = null,
  ) => {
    const employee = (
      await request(http())
        .post('/api/employees')
        .set(auth())
        .send({
          nationalId: name,
          name,
          email: `${name}@attendance.local`,
          department: 'Engineering',
          jobTitle: 'Engineer',
          startDate: '2026-01-01',
          scheduleId: schedule.id,
          active: true,
          role,
          managerId,
          password: 'Attendance-test-password-2026',
        })
        .expect(201)
    ).body;
    const user = (await store
      .prepare('SELECT id FROM users WHERE employee_id=?')
      .get(employee.id))!;
    await store
      .prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)')
      .run(tokenHash(name), user.id, '2099-01-01T00:00:00.000Z');
    await register(name, {
      deviceId: randomUUID(),
      token: token + '-' + name,
    }).expect(200);
    return employee;
  };
  const manager = await create('attendance-manager', 'manager');
  const other = await create('other-manager', 'manager');
  const report = await create('direct-report', 'employee', manager.id);
  await register().expect(200);
  const photo = await sharp({
    create: { width: 10, height: 10, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  const capture = (path: string) =>
    request(http())
      .post(path)
      .set(auth('direct-report'))
      .field('latitude', '30.023092')
      .field('longitude', '31.528179')
      .field('accuracyMeters', '10')
      .field('capturedAt', new Date().toISOString())
      .attach('photo', photo, {
        filename: 'office.png',
        contentType: 'image/png',
      });
  const inboxFor = async (name: string) =>
    (
      await request(http())
        .get('/api/notifications')
        .set(auth(name))
        .expect(200)
    ).body.items as Notification[];
  return { manager, other, report, capture, inboxFor };
}

it('notifies only the direct manager for real check-in/check-out, with stable IDs, read tracking and no duplicate pushes', async () => {
  const { capture, inboxFor } = await directReportAttendance();
  const send = vi.spyOn(app.get(FirebaseSender), 'send').mockResolvedValue();
  const record = (await capture('/api/attendance/check-in').expect(201)).body;
  await capture('/api/attendance/check-in').expect(201);
  const items = await inboxFor('attendance-manager');
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    type: 'employee-checked-in',
    attendanceId: record.id,
    message: 'direct-report checked in',
    readAt: null,
  });
  for (const name of ['other-manager', 'direct-report', 'session-a'])
    expect(await inboxFor(name)).toHaveLength(0);
  await worker.sweep();
  await worker.sweep();
  expect(send.mock.calls).toEqual([
    [token + '-attendance-manager', items[0].id, 'employee-checked-in'],
  ]);
  await request(http())
    .patch(`/api/notifications/${items[0].id}/read`)
    .set(auth('other-manager'))
    .expect(404);
  await request(http())
    .patch(`/api/notifications/${items[0].id}/read`)
    .set(auth('attendance-manager'))
    .expect(200);
  expect((await inboxFor('attendance-manager'))[0].readAt).not.toBeNull();
  await capture(`/api/attendance/${record.id}/check-out`).expect(201);
  await capture(`/api/attendance/${record.id}/check-out`).expect(201);
  await worker.sweep();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0]).toBe(token + '-attendance-manager');
  expect(send.mock.calls[1][2]).toBe('employee-checked-out');
  expect(
    (await inboxFor('attendance-manager')).filter(
      (item) => item.type === 'employee-checked-out',
    ),
  ).toHaveLength(1);
});

it('cancels a previous manager retry after reassignment and prevents cross-company attendance access', async () => {
  const { capture, inboxFor, report, other } = await directReportAttendance();
  const send = vi
    .spyOn(app.get(FirebaseSender), 'send')
    .mockRejectedValueOnce({ code: 'messaging/server-unavailable' })
    .mockResolvedValue();
  await capture('/api/attendance/check-in').expect(201);
  const original = (await inboxFor('attendance-manager'))[0];
  await worker.sweep();
  await store
    .prepare(
      "UPDATE employees SET data=jsonb_set(data::jsonb,'{managerId}',to_jsonb(?::text))::text WHERE id=?",
    )
    .run(other.id, report.id);
  await store
    .prepare(
      "UPDATE push_deliveries SET next_attempt=now()-interval '1 second'",
    )
    .run();
  expect(await inboxFor('attendance-manager')).toHaveLength(0);
  await worker.sweep();
  expect(send.mock.calls.map(([value]) => value)).toEqual([
    token + '-attendance-manager',
    token + '-other-manager',
  ]);
  expect(
    (await rows('push_deliveries')).find(
      (row) => row.user_id !== other.id && row.state === 'cancelled',
    ),
  ).toBeDefined();
  const company = await provisionTestCompany('attendance-push-other');
  await session(company, 'foreign-manager', 'foreign-session');
  expect(await inboxFor('foreign-session')).toHaveLength(0);
  await request(http())
    .patch(`/api/notifications/${original.id}/read`)
    .set(auth('foreign-session'))
    .expect(404);
});

it('notifies a manager for automatic checkout without exposing location in the notification', async () => {
  const { capture, inboxFor } = await directReportAttendance();
  const record = (await capture('/api/attendance/check-in').expect(201)).body;
  const now = Date.now();
  const tracking = await store
    .prepare('SELECT data FROM attendance_location WHERE attendance_id=?')
    .get(record.id);
  const state = JSON.parse(tracking!.data as string);
  Object.assign(state, {
    status: 'outside',
    lastCapturedAt: new Date(now).toISOString(),
    outsideSince: new Date(now - 60000).toISOString(),
    returnBy: new Date(now - 1000).toISOString(),
  });
  await store
    .prepare('UPDATE attendance_location SET data=? WHERE attendance_id=?')
    .run(JSON.stringify(state), record.id);
  await app.get(AttendanceLocationService).sweep();
  const items = await inboxFor('attendance-manager');
  expect(items.filter((item) => item.type === 'employee-checked-out')).toEqual([
    expect.objectContaining({
      attendanceId: record.id,
      message: 'direct-report checked out',
    }),
  ]);
  const send = vi.spyOn(app.get(FirebaseSender), 'send').mockResolvedValue();
  await worker.sweep();
  expect(send.mock.calls.map(([, , type]) => type)).toEqual(
    expect.arrayContaining(['employee-checked-in', 'employee-checked-out']),
  );
  expect(send).toHaveBeenCalledTimes(2);
});
