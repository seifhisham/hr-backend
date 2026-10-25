import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { BootstrapService } from '../src/database/bootstrap.service.js';
import {
  DatabaseService,
  companyContext,
} from '../src/database/database.service.js';
import { provisionTestCompany, testCompanyId } from './postgres.setup.js';

describe('PostgreSQL company REST isolation', () => {
  let app: INestApplication;
  const password = 'Isolated-company-password-2026';
  beforeEach(async () => {
    vi.stubEnv('HR_ADMIN_EMAIL', 'same@test.local');
    vi.stubEnv('HR_ADMIN_PASSWORD', password);
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('isolates identical identifiers, caches, foreign references, sessions and failed login counts', async () => {
    const store = app.get(DatabaseService);
    const second = await provisionTestCompany('second-company');
    vi.stubEnv('HR_BOOTSTRAP_COMPANY_ID', second);
    await app.get(BootstrapService).onModuleInit();
    vi.stubEnv('HR_BOOTSTRAP_COMPANY_ID', testCompanyId);
    vi.stubEnv('HR_DEFAULT_WORKSPACE', '');
    const server = app.getHttpServer();
    const login = (workspace: string, secret = password) =>
      request(server)
        .post('/api/auth/login')
        .send({ workspace, email: 'same@test.local', password: secret });
    await request(server)
      .post('/api/auth/login')
      .send({ email: 'same@test.local', password })
      .expect(401);
    const a = (await login('test-company').expect(201)).body;
    const b = (await login('second-company').expect(201)).body;
    expect(a.user.companyId).toBe(testCompanyId);
    expect(b.user.companyId).toBe(second);
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    await store.withCompany(testCompanyId, () =>
      store.prepare('INSERT INTO departments(name) VALUES(?)').run('Only A'),
    );
    await store.withCompany(second, () =>
      store.prepare('INSERT INTO departments(name) VALUES(?)').run('Only B'),
    );
    for (const [token, own, other] of [
      [a.token, 'Only A', 'Only B'],
      [b.token, 'Only B', 'Only A'],
      [a.token, 'Only A', 'Only B'],
    ]) {
      const departments = (
        await request(server)
          .get('/api/departments')
          .set(auth(token))
          .expect(200)
      ).body;
      expect(departments).toContainEqual({ name: own });
      expect(departments).not.toContainEqual({ name: other });
    }
    const schedulesA = (
      await request(server).get('/api/schedules').set(auth(a.token)).expect(200)
    ).body;
    const schedulesB = (
      await request(server).get('/api/schedules').set(auth(b.token)).expect(200)
    ).body;
    const input = {
      nationalId: 'SAME-ID',
      email: 'employee@test.local',
      name: 'Same employee',
      department: 'Shared',
      jobTitle: 'Engineer',
      startDate: '2026-01-01',
      active: true,
      role: 'employee',
      password,
    };
    const employeeA = (
      await request(server)
        .post('/api/employees')
        .set(auth(a.token))
        .send({ ...input, scheduleId: schedulesA[0].id })
        .expect(201)
    ).body;
    await request(server)
      .post('/api/employees')
      .set(auth(b.token))
      .send({ ...input, scheduleId: schedulesA[0].id })
      .expect(400);
    const employeeB = (
      await request(server)
        .post('/api/employees')
        .set(auth(b.token))
        .send({ ...input, scheduleId: schedulesB[0].id })
        .expect(201)
    ).body;
    expect(employeeB.employeeNumber).toBe(employeeA.employeeNumber);
    await request(server)
      .patch(`/api/employees/${employeeB.id}`)
      .set(auth(a.token))
      .send({ ...input, scheduleId: schedulesA[0].id })
      .expect(404);
    const rows = (
      await request(server).get('/api/employees').set(auth(a.token)).expect(200)
    ).body;
    expect(rows.map((row: { id: string }) => row.id)).toEqual([employeeA.id]);
    await request(server)
      .get('/api/auth/me')
      .set({ ...auth(a.token), 'X-Company-Id': second })
      .expect(200)
      .expect((response) =>
        expect(response.body.user.companyId).toBe(testCompanyId),
      );
    for (let index = 0; index < 5; index++)
      await login('test-company', 'incorrect-password').expect(401);
    await login('test-company').expect(429);
    await login('second-company').expect(201);
    await store.withCompany(testCompanyId, () =>
      store.prepare('DELETE FROM sessions').run(),
    );
    await request(server).get('/api/auth/me').set(auth(a.token)).expect(401);
    await request(server).get('/api/auth/me').set(auth(b.token)).expect(200);
    await store.withCompany(second, () =>
      store.prepare("UPDATE companies SET status='suspended'").run(),
    );
    await request(server).get('/api/auth/me').set(auth(b.token)).expect(401);
  });

  it('fails closed without context and rolls back failed writes without leaking pooled scope', async () => {
    const store = app.get(DatabaseService);
    await expect(
      companyContext.exit(() => store.prepare('SELECT * FROM users').all()),
    ).rejects.toThrow('company context');
    await expect(
      store.transaction(async () => {
        await store
          .prepare('INSERT INTO departments(name) VALUES(?)')
          .run('Rolled back');
        throw new Error('Rollback probe');
      }),
    ).rejects.toThrow('Rollback probe');
    expect(
      await store
        .prepare('SELECT name FROM departments WHERE name=?')
        .all('Rolled back'),
    ).toEqual([]);
    await expect(
      store.prepare('SELECT 9007199254740992::bigint AS count').get(),
    ).rejects.toThrow('safe range');
  });
});
