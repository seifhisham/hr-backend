import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import type { Actor } from '../src/common/types/actor.type.js';

it('searches and pages all audit history with exact actors, dates, details, and access controls', async () => {
  vi.stubEnv('HR_DATABASE_PATH', ':memory:');
  vi.stubEnv('HR_ADMIN_EMAIL', 'audit@test.local');
  vi.stubEnv('HR_ADMIN_PASSWORD', 'Unique-audit-password-2026');
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication();
  await app.init();
  try {
    const http = app.getHttpServer();
    const login = await request(http)
      .post('/api/auth/login')
      .send({
        email: 'audit@test.local',
        password: 'Unique-audit-password-2026',
      })
      .expect(201);
    const headers = { Authorization: `Bearer ${login.body.token}` };
    const audit = app.get(AuditService);
    const actor = app.get(AuthService).authenticate(login.body.token);
    const other: Actor = { ...actor, id: randomUUID() };
    app
      .get(DatabaseService)
      .db.prepare(
        'INSERT INTO users SELECT ?, ?, name, role, employee_id, active, password_hash FROM users WHERE id = ?',
      )
      .run(other.id, 'other-audit@test.local', actor.id);
    const ids: string[] = [];
    for (let i = 0; i < 121; i++) {
      audit.record(
        i % 2 ? other : actor,
        'employee.updated',
        'department Sales',
        { value: i },
        { value: i + 1, name: 'Trackable employee' },
        'Correction',
      );
      ids.unshift(
        audit.auditHistory(actor, 'department Sales')[0].id as string,
      );
    }
    // A new insertion after page one must not shift subsequent cursor pages.
    const found: string[] = [];
    let before = '';
    for (let page = 0; page < 3; page++) {
      const response = await request(http)
        .get(
          `/api/audit?recordId=department%20Sales&limit=50${before ? `&before=${before}` : ''}`,
        )
        .set(headers)
        .expect(200);
      found.push(...response.body.map((row: { id: string }) => row.id));
      before = response.body.at(-1).id;
      if (page === 0)
        audit.record(actor, 'employee.updated', 'department Sales', null, null);
    }
    expect(found).toEqual(ids);
    expect(new Set(found).size).toBe(121);
    const filtered = await request(http)
      .get(
        `/api/audit?actorId=${other.id}&action=employee.updated&search=trackable&limit=100`,
      )
      .set(headers)
      .expect(200);
    expect(filtered.body).toHaveLength(60);
    expect(
      filtered.body.every(
        (row: { actorId: string }) => row.actorId === other.id,
      ),
    ).toBe(true);
    expect(filtered.body[0].before).toHaveProperty('value');
    expect(filtered.body[0].reason).toBe('Correction');
    const db = app.get(DatabaseService).db;
    db.prepare('UPDATE audit SET at = ? WHERE id = ?').run(
      '2026-10-14T23:59:59.999Z',
      ids[0],
    );
    db.prepare('UPDATE audit SET at = ? WHERE id = ?').run(
      '2026-10-15T00:00:00.000Z',
      ids[1],
    );
    const dated = await request(http)
      .get('/api/audit?from=2026-10-14&to=2026-10-14&limit=100')
      .set(headers)
      .expect(200);
    expect(dated.body.map((row: { id: string }) => row.id)).toContain(ids[0]);
    expect(dated.body.map((row: { id: string }) => row.id)).not.toContain(
      ids[1],
    );
    for (const query of [
      'limit=101',
      'before=bad',
      'actorId=bad',
      'from=2026-10-15&to=2026-10-14',
      'from=2026-02-30',
      'unexpected=true',
    ]) {
      await request(http).get(`/api/audit?${query}`).set(headers).expect(400);
    }
    await request(http).get('/api/audit').expect(401);
    db.prepare("UPDATE users SET role = 'employee' WHERE id = ?").run(actor.id);
    await request(http).get('/api/audit').set(headers).expect(403);
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(actor.id);
    expect(
      audit
        .auditHistory(actor, actor.id)
        .some((row) => row.action === 'account.signed_in'),
    ).toBe(true);
    await request(http).post('/api/auth/logout').set(headers).expect(201);
    const authLogs = audit.auditHistory(actor, actor.id);
    expect(authLogs[0].action).toBe('account.signed_out');
    expect(JSON.stringify(authLogs)).not.toContain(login.body.token);
    expect(JSON.stringify(authLogs)).not.toContain(
      'Unique-audit-password-2026',
    );
  } finally {
    await app.close();
    vi.unstubAllEnvs();
  }
});
