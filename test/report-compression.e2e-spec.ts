import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';

it('negotiates gzip without changing report rows, privacy headers or CSV exports', async () => {
  vi.stubEnv('HR_DATABASE_PATH', ':memory:');
  vi.stubEnv('HR_ADMIN_EMAIL', 'compression@test.local');
  vi.stubEnv('HR_ADMIN_PASSWORD', 'Isolated-compression-2026');
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication();
  await app.init();
  try {
    const db = app.get(DatabaseService).db;
    const schedule = db.prepare('SELECT id FROM schedules LIMIT 1').get()!
      .id as string;
    for (let i = 0; i < 20; i++) {
      const employee = {
        id: randomUUID(),
        nationalId: `COMPRESS-${i}`,
        name: `Private employee ${i}`,
        department: 'Test',
        active: true,
        startDate: '2026-01-01',
        scheduleId: schedule,
      };
      db.prepare('INSERT INTO employees VALUES (?, ?, ?, ?)').run(
        employee.id,
        employee.nationalId,
        `compress-${i}@test.local`,
        JSON.stringify(employee),
      );
      db.prepare('INSERT INTO employee_schedules VALUES (?, ?, ?)').run(
        employee.id,
        '2026-01-01',
        schedule,
      );
    }
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({
        email: 'compression@test.local',
        password: 'Isolated-compression-2026',
      })
      .expect(201);
    const auth = { Authorization: `Bearer ${login.body.token}` };
    const path = '/api/attendance?from=2026-09-01&to=2026-09-30';
    const plain = await request(app.getHttpServer())
      .get(path)
      .set(auth)
      .set('Accept-Encoding', 'identity')
      .expect(200);
    const compressed = await request(app.getHttpServer())
      .get(path)
      .set(auth)
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(compressed.body).toEqual(plain.body);
    expect(compressed.body).toHaveLength(440);
    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(compressed.headers['content-type']).toContain('application/json');
    expect(compressed.headers['cache-control']).toBe('no-store');
    expect(compressed.headers.vary).toContain('Accept-Encoding');
    expect(Number(compressed.headers['content-length'])).toBeLessThan(
      Number(plain.headers['content-length']) / 4,
    );
    const declined = await request(app.getHttpServer())
      .get(path)
      .set(auth)
      .set('Accept-Encoding', 'gzip;q=0, identity')
      .expect(200);
    expect(declined.headers['content-encoding']).toBeUndefined();
    expect(declined.body).toEqual(plain.body);
    const preferredIdentity = await request(app.getHttpServer())
      .get(path)
      .set(auth)
      .set('Accept-Encoding', 'identity;q=1, gzip;q=0.5')
      .expect(200);
    expect(preferredIdentity.headers['content-encoding']).toBeUndefined();
    expect(preferredIdentity.body).toEqual(plain.body);
    const closingNode = await request(app.getHttpServer())
      .get(path)
      .set(auth)
      .set('Accept-Encoding', 'gzip')
      .set('User-Agent', 'node')
      .set('Connection', 'close')
      .expect(200);
    expect(closingNode.headers['content-encoding']).toBeUndefined();
    expect(closingNode.body).toEqual(plain.body);
    const small = await request(app.getHttpServer())
      .get('/api/attendance?from=2026-09-01&to=2026-09-01')
      .set(auth)
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(small.headers['content-encoding']).toBeUndefined();
    const csv = await request(app.getHttpServer())
      .get('/api/attendance/export?from=2026-09-01&to=2026-09-30')
      .set(auth)
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-encoding']).toBeUndefined();
    expect(csv.text).toContain('Private employee');
    await request(app.getHttpServer())
      .get(path)
      .set('Accept-Encoding', 'gzip')
      .expect(401);
  } finally {
    await app.close();
    vi.unstubAllEnvs();
  }
});
