import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AttendanceService } from '../src/attendance/attendance.service.js';
import { AttendanceEvidence } from '../src/attendance/attendance-evidence.service.js';
import { SalesService } from '../src/sales/sales.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { tokenHash } from '../src/common/security/credentials.js';
import { RATE_LIMITS } from '../src/common/security/rate-limit.guard.js';
it('limits real routes by account before expensive work and keeps ordinary routes available', async () => {
  vi.stubEnv('HR_DATABASE_PATH', ':memory:');
  vi.stubEnv('HR_ADMIN_EMAIL', 'limits@test.local');
  vi.stubEnv('HR_ADMIN_PASSWORD', 'Unique-test-password-2026');
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication();
  await app.init();
  try {
    const db = app.get(DatabaseService).db;
    const user = (await db.prepare('SELECT id FROM users LIMIT 1').get())!;
    for (const token of ['first-session', 'second-session']) {
      await db
        .prepare('INSERT INTO sessions (hash,user_id,expires) VALUES (?, ?, ?)')
        .run(tokenHash(token), user.id, '2099-01-01T00:00:00.000Z');
    }
    const http = app.getHttpServer();
    const auth = { Authorization: 'Bearer first-session' };
    const report = vi
      .spyOn(app.get(AttendanceService), 'report')
      .mockResolvedValue([]);
    const sales = vi
      .spyOn(app.get(SalesService), 'performance')
      .mockResolvedValue([]);
    for (let i = 0; i < RATE_LIMITS.reports.requests; i++) {
      const path =
        i % 2
          ? '/api/sales/performance?month=2026-10'
          : '/api/attendance?from=2026-10-01&to=2026-10-01';
      await request(http).get(path).set(auth).expect(200);
    }
    const denied = await request(http)
      .get('/api/attendance?from=2026-09-01&to=2026-09-02')
      .set('Cookie', 'hr_session=second-session')
      .expect(429);
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
    expect(report).toHaveBeenCalledTimes(30);
    expect(sales).toHaveBeenCalledTimes(30);
    // Export has its own budget, shared between both export routes.
    for (let i = 0; i < RATE_LIMITS.exports.requests; i++) {
      await request(http)
        .get('/api/sales/export?month=2026-10')
        .set(auth)
        .expect(200);
    }
    await request(http)
      .get('/api/attendance/export?from=2026-10-01&to=2026-10-01')
      .set(auth)
      .expect(429);
    expect(report).toHaveBeenCalledTimes(30);
    const prepare = vi
      .spyOn(app.get(AttendanceEvidence), 'prepare')
      .mockRejectedValue(new BadRequestException('Invalid evidence'));
    for (let i = 0; i < RATE_LIMITS.photos.requests; i++) {
      const path =
        i % 2
          ? '/api/attendance/00000000-0000-4000-8000-000000000001/check-out'
          : '/api/attendance/check-in';
      await request(http)
        .post(path)
        .set(auth)
        .field('latitude', '30')
        .expect(400);
    }
    // The guard rejects an unexpected file field before Multer can return 400.
    await request(http)
      .post('/api/attendance/check-in')
      .set(auth)
      .attach('unexpected', Buffer.from('invalid photo'), 'photo.jpg')
      .expect(429);
    expect(prepare).toHaveBeenCalledTimes(10);
    const password = vi
      .spyOn(app.get(AuthService), 'changePassword')
      .mockResolvedValue({ message: 'Password changed. Sign in again.' });
    for (let i = 0; i < RATE_LIMITS.passwords.requests; i++) {
      await request(http)
        .post('/api/auth/password')
        .set(auth)
        .send({
          currentPassword: 'old-password',
          newPassword: 'new-password-2026',
        })
        .expect(201);
    }
    await request(http)
      .post('/api/auth/password')
      .set(auth)
      .send({
        currentPassword: 'old-password',
        newPassword: 'new-password-2026',
      })
      .expect(429);
    expect(password).toHaveBeenCalledTimes(5);
    await request(http).get('/api/attendance').expect(401);
    await request(http).get('/api/health').expect(200);
    await request(http).get('/api/attendance/policy').set(auth).expect(200);
    await request(http).post('/api/auth/logout').set(auth).expect(201);
  } finally {
    vi.restoreAllMocks();
    await app.close();
    vi.unstubAllEnvs();
  }
});
