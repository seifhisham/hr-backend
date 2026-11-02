import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

describe('Employee CSV import over REST and PostgreSQL', () => {
  let app: INestApplication;
  const password = 'Csv-import-test-password-2026!';
  beforeEach(async () => {
    vi.stubEnv('HR_ADMIN_EMAIL', 'csv-admin@example.com');
    vi.stubEnv('HR_ADMIN_PASSWORD', password);
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('previews without writes, imports valid responses, authenticates accounts, protects passwords and skips reimports', async () => {
    const server = app.getHttpServer();
    const login = async (email: string, secret: string) =>
      (
        await request(server)
          .post('/api/auth/login')
          .send({ workspace: 'test-company', email, password: secret })
          .expect(201)
      ).body;
    const admin = await login('csv-admin@example.com', password);
    const auth = { Authorization: `Bearer ${admin.token}` };
    const schedules = (
      await request(server).get('/api/schedules').set(auth).expect(200)
    ).body;
    const branches = (
      await request(server).get('/api/branches').set(auth).expect(200)
    ).body;
    const csv = [
      'Timestamp,Full Name,National ID,Email,Job Title,Date Joined,Monthly Salary,Iphone or android',
      'now,"Employee, One",00123456789012,one@example.com,Agent,2026-01-01,"14,000",Android',
      'now,موظف تجريبي,٣٠٦٠٤١٨٠١٠٣٨٦١,two@example.com,Agent,2026-01-02,7000,Iphone',
      'now,Invalid A,003,three@example.com,Agent,2026-01-01,7.000,Android',
      'now,Invalid B,004,four@example.com,Agent,2026-01-01,10k,Android',
      'now,Invalid C,005,five@example.com,Agent,2026-01-01,NA,Android',
    ].join('\r\n');
    const body = {
      csv,
      branchId: branches[0].id,
      scheduleId: schedules[0].id,
      department: 'CSV test',
      salaryCurrency: 'EGP',
      dateFormat: 'ISO',
      preview: true,
    };
    await request(server).post('/api/employees/import').send(body).expect(401);
    const preview = (
      await request(server)
        .post('/api/employees/import')
        .set(auth)
        .send(body)
        .expect(201)
    ).body;
    expect(preview.map((r: { status: string }) => r.status)).toEqual([
      'ready',
      'ready',
      'ready',
      'ready',
      'invalid',
    ]);
    expect(
      (await request(server).get('/api/employees').set(auth).expect(200)).body,
    ).toHaveLength(0);
    expect(preview.every((r: { password?: string }) => !r.password)).toBe(true);
    const corrected = {
      ...body,
      salaryOverrides: { '6': 8000 },
      rowOverrides: {
        '2': {
          name: 'Edited employee',
          nationalId: '00923456789012',
          jobTitle: 'Supervisor',
          startDate: '2026-02-01',
          department: 'Operations',
          scheduleId: schedules[1].id,
          salaryCurrency: 'USD',
          role: 'manager',
          salesEnabled: true,
        },
      },
    };
    const correctedPreview = (
      await request(server)
        .post('/api/employees/import')
        .set(auth)
        .send(corrected)
        .expect(201)
    ).body;
    expect(
      correctedPreview.every((r: { status: string }) => r.status === 'ready'),
    ).toBe(true);
    await request(server)
      .post('/api/employees/import')
      .set(auth)
      .send({ ...corrected, salaryOverrides: { '6': -1 } })
      .expect(400);
    const imported = (
      await request(server)
        .post('/api/employees/import')
        .set(auth)
        .send({ ...corrected, preview: false })
        .expect(201)
    ).body;
    expect(imported.map((r: { status: string }) => r.status)).toEqual([
      'created',
      'created',
      'created',
      'created',
      'created',
    ]);
    const employees = (
      await request(server).get('/api/employees').set(auth).expect(200)
    ).body;
    expect(employees).toHaveLength(5);
    for (const [email, monthlySalary] of [
      ['three@example.com', 7000],
      ['four@example.com', 10000],
      ['five@example.com', 8000],
    ]) {
      expect(
        employees.find((e: { email: string }) => e.email === email),
      ).toMatchObject({ monthlySalary });
    }
    expect(
      employees.find((e: { email: string }) => e.email === 'one@example.com'),
    ).toMatchObject({
      nationalId: '00923456789012',
      name: 'Edited employee',
      monthlySalary: 14000,
      startDate: '2026-02-01',
      role: 'manager',
      active: true,
      department: 'Operations',
      jobTitle: 'Supervisor',
      scheduleId: schedules[1].id,
      salaryCurrency: 'USD',
      salesEnabled: true,
    });
    expect(
      employees.find((e: { email: string }) => e.email === 'two@example.com'),
    ).toMatchObject({ nationalId: '٣٠٦٠٤١٨٠١٠٣٨٦١', monthlySalary: 7000 });
    expect(imported[0].password).toMatch(/^(?:[a-z]+-){4}\d{4}$/);
    expect(imported[0].password).not.toBe(imported[1].password);
    for (const row of imported.filter(
      (r: { status: string }) => r.status === 'created',
    )) {
      expect(row.employee.password).toBeUndefined();
      const employee = await login(row.email, row.password);
      expect(employee.user.role).toBe(row.employee.role);
      await request(server)
        .post('/api/employees/import')
        .set({ Authorization: `Bearer ${employee.token}` })
        .send({ ...body, preview: false })
        .expect(403);
    }
    const audit = (
      await request(server).get('/api/audit').set(auth).expect(200)
    ).text;
    expect(audit).not.toContain(imported[0].password);
    expect(audit).not.toContain(imported[1].password);
    const again = (
      await request(server)
        .post('/api/employees/import')
        .set(auth)
        .send({ ...corrected, preview: false })
        .expect(201)
    ).body;
    expect(again.map((r: { status: string }) => r.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(again.every((r: { password?: string }) => !r.password)).toBe(true);
    expect(
      (await request(server).get('/api/employees').set(auth).expect(200)).body,
    ).toEqual(employees);
  });
});
