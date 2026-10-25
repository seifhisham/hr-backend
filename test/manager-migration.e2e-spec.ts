import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LegacySqliteStore as DatabaseService } from '../src/database/legacy-sqlite.js';
import { DATABASE_SCHEMA } from '../src/database/database.schema.js';

it('converts existing department manager assignments to direct reports once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hr-manager-migration-'));
  const path = join(directory, 'test.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(DATABASE_SCHEMA);
    legacy.exec(
      'CREATE TABLE department_managers (department TEXT PRIMARY KEY, employee_id TEXT NOT NULL)',
    );
    legacy.prepare('INSERT INTO departments VALUES (?)').run('Sales');
    for (const [id, role] of [
      ['manager', 'employee'],
      ['report', 'employee'],
    ]) {
      legacy
        .prepare('INSERT INTO employees VALUES (?, ?, ?, ?)')
        .run(
          id,
          id,
          `${id}@test.local`,
          JSON.stringify({ id, role, active: true, department: 'Sales' }),
        );
    }
    legacy
      .prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        'user',
        'manager@test.local',
        'Manager',
        'employee',
        'manager',
        1,
        'hash',
      );
    legacy
      .prepare('INSERT INTO department_managers VALUES (?, ?)')
      .run('Sales', 'manager');
    legacy.close();
    vi.stubEnv('HR_DATABASE_PATH', path);
    const upgraded = new DatabaseService();
    expect(
      JSON.parse(
        upgraded.db
          .prepare("SELECT data FROM employees WHERE id = 'manager'")
          .get()!.data as string,
      ).role,
    ).toBe('manager');
    expect(
      JSON.parse(
        upgraded.db
          .prepare("SELECT data FROM employees WHERE id = 'report'")
          .get()!.data as string,
      ).managerId,
    ).toBe('manager');
    expect(
      upgraded.db.prepare("SELECT role FROM users WHERE id = 'user'").get()!
        .role,
    ).toBe('manager');
    expect(
      upgraded.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name = 'department_managers'",
        )
        .get(),
    ).toBeUndefined();
    upgraded.onModuleDestroy();
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
