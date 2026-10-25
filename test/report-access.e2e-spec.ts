import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AttendanceService } from '../src/attendance/attendance.service.js';
import { DatabaseService } from '../src/database/database.service.js';
it.each([
  ['attendance', 'logout'],
  ['attendance/export', 'logout'],
  ['attendance', 'role-change'],
  ['attendance/export', 'role-change'],
])(
  'does not return %s data after %s during report generation',
  async (path, change) => {
    vi.stubEnv('HR_DATABASE_PATH', ':memory:');
    vi.stubEnv('HR_ADMIN_EMAIL', 'report-access@test.local');
    vi.stubEnv('HR_ADMIN_PASSWORD', 'Isolated-report-access-2026');
    const app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
    let release!: () => void;
    try {
      const db = app.get(DatabaseService).db;
      const schedule = (await db
        .prepare('SELECT id FROM schedules LIMIT 1')
        .get())!.id as string;
      const employee = {
        employeeNumber: 'EMP-000001',
        id: randomUUID(),
        nationalId: 'PRIVATE-TEST',
        name: 'Private employee',
        department: 'Test',
        active: true,
        startDate: '2026-01-01',
        scheduleId: schedule,
      };
      await db
        .prepare(
          'INSERT INTO employees (id,code,email,data) VALUES (?, ?, ?, ?)',
        )
        .run(
          employee.id,
          employee.nationalId,
          'private@test.local',
          JSON.stringify(employee),
        );
      await db
        .prepare(
          'INSERT INTO employee_schedules (employee_id,effective_from,schedule_id) VALUES (?, ?, ?)',
        )
        .run(employee.id, '2026-01-01', schedule);
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({
          email: 'report-access@test.local',
          password: 'Isolated-report-access-2026',
        })
        .expect(201);
      const headers = { Authorization: `Bearer ${login.body.token}` };
      const attendance = app.get(AttendanceService);
      const original = attendance.report.bind(attendance);
      let entered!: () => void;
      const started = new Promise<void>((done) => {
        entered = done;
      });
      const hold = new Promise<void>((done) => {
        release = done;
      });
      vi.spyOn(attendance, 'report').mockImplementationOnce(
        async (actor, filters) => {
          const rows = await original(actor, filters);
          entered();
          await hold;
          return rows;
        },
      );
      const pending = request(app.getHttpServer())
        .get(`/api/${path}?from=2026-09-01&to=2026-09-01`)
        .set(headers)
        .then((response) => response);
      await started;
      if (change === 'logout')
        await request(app.getHttpServer())
          .post('/api/auth/logout')
          .set(headers)
          .expect(201);
      else
        await db
          .prepare("UPDATE users SET role = 'employee' WHERE email = ?")
          .run('report-access@test.local');
      release();
      const response = await pending;
      expect(response.status).toBe(change === 'logout' ? 401 : 403);
      expect(response.text).not.toContain('PRIVATE-TEST');
      expect(response.text).not.toContain('Private employee');
    } finally {
      release?.();
      vi.restoreAllMocks();
      await app.close();
      vi.unstubAllEnvs();
    }
  },
);
