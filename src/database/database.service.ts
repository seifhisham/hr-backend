import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE_SCHEMA } from './database.schema.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db: DatabaseSync;

  constructor() {
    const path = process.env.HR_DATABASE_PATH ?? resolve('data/hr.sqlite');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(DATABASE_SCHEMA);
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'department_managers'",
        )
        .get()
    ) {
      this.transaction(() => {
        for (const row of this.db
          .prepare('SELECT department, employee_id FROM department_managers')
          .all()) {
          const manager = this.db
            .prepare('SELECT data FROM employees WHERE id = ?')
            .get(row.employee_id);
          if (!manager) continue;
          const profile = JSON.parse(manager.data as string) as {
            role: string;
            active: boolean;
          };
          if (!profile.active) continue;
          if (profile.role === 'employee') {
            this.db
              .prepare(
                "UPDATE employees SET data = json_set(data, '$.role', 'manager') WHERE id = ?",
              )
              .run(row.employee_id);
            this.db
              .prepare(
                "UPDATE users SET role = 'manager' WHERE employee_id = ?",
              )
              .run(row.employee_id);
            this.db
              .prepare(
                'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE employee_id = ?)',
              )
              .run(row.employee_id);
          }
          this.db
            .prepare(
              "UPDATE employees SET data = json_set(data, '$.managerId', ?) WHERE id != ? AND json_extract(data, '$.department') = ? AND json_extract(data, '$.managerId') IS NULL",
            )
            .run(row.employee_id, row.employee_id, row.department);
        }
        this.db.exec('DROP TABLE department_managers');
      });
    }
    const requestTable = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'employee_requests'",
      )
      .get();
    if (!String(requestTable?.sql ?? '').includes("'withdrawn'")) {
      this.transaction(() =>
        this.db.exec(`
        ALTER TABLE employee_requests RENAME TO employee_requests_legacy;
        CREATE TABLE employee_requests (
          id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id),
          status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'withdrawn')),
          data TEXT NOT NULL
        );
        INSERT INTO employee_requests SELECT * FROM employee_requests_legacy ORDER BY rowid;
        DROP TABLE employee_requests_legacy;
        CREATE INDEX requests_by_employee ON employee_requests(employee_id, status);
        CREATE INDEX requests_history_by_employee ON employee_requests(employee_id);
        CREATE INDEX requests_by_status ON employee_requests(status);
        CREATE INDEX pending_requests_by_employee ON employee_requests(employee_id) WHERE status = 'pending';
      `),
      );
    }
    // Preserve existing identifier values while upgrading the REST field name.
    this.transaction(() => {
      for (const table of ['employees', 'employee_requests']) {
        this.db.exec(`
          UPDATE ${table}
          SET data = json_remove(
            json_set(data, '$.nationalId', json_extract(data, '$.employeeCode')),
            '$.employeeCode'
          )
          WHERE json_type(data, '$.nationalId') IS NULL
            AND json_type(data, '$.employeeCode') = 'text';
        `);
      }
      this.db.exec(`
        UPDATE employees
        SET data = json_set(data, '$.monthlySalary', NULL)
        WHERE json_type(data, '$.monthlySalary') IS NULL;
        UPDATE employees
        SET data = json_set(data, '$.salaryCurrency', 'EGP')
        WHERE json_type(data, '$.salaryCurrency') IS NULL;
        UPDATE employee_requests
        SET data = json_set(data, '$.salaryDeductionDays', NULL)
        WHERE json_type(data, '$.salaryDeductionDays') IS NULL;
      `);
      for (const row of this.db
        .prepare(
          "SELECT id FROM employees WHERE json_extract(data, '$.employeeNumber') IS NULL ORDER BY rowid",
        )
        .all()) {
        this.db
          .prepare(
            "UPDATE employees SET data = json_set(data, '$.employeeNumber', ?) WHERE id = ?",
          )
          .run(this.nextEmployeeNumber(), row.id as string);
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS employee_number_unique ON employees(json_extract(data, '$.employeeNumber'))",
      );
    });
  }

  // Call inside the employee write transaction so allocation and saving are atomic.
  nextEmployeeNumber(): string {
    const row = this.db
      .prepare(
        `
      INSERT INTO settings (key, value) VALUES ('employee_number_sequence', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
      RETURNING value
    `,
      )
      .get() as { value: string };
    return `EMP-${String(row.value).padStart(6, '0')}`;
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  onModuleDestroy() {
    this.db.close();
  }
}
