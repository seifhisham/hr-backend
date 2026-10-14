export const DATABASE_SCHEMA = `
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS departments (name TEXT PRIMARY KEY COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS employees_by_manager ON employees(json_extract(data, '$.managerId'));
      CREATE TABLE IF NOT EXISTS schedule_versions (
        schedule_id TEXT NOT NULL REFERENCES schedules(id), effective_from TEXT NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY(schedule_id, effective_from)
      );
      CREATE TABLE IF NOT EXISTS employee_schedules (
        employee_id TEXT NOT NULL REFERENCES employees(id), effective_from TEXT NOT NULL,
        schedule_id TEXT NOT NULL REFERENCES schedules(id),
        PRIMARY KEY(employee_id, effective_from)
      );
      INSERT OR IGNORE INTO schedule_versions
        SELECT id, '0001-01-01', data FROM schedules;
      INSERT INTO employee_schedules
        SELECT e.id, json_extract(e.data, '$.startDate'), s.id
        FROM employees e JOIN schedules s ON s.id = json_extract(e.data, '$.scheduleId')
        WHERE json_extract(e.data, '$.startDate') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM employee_schedules a WHERE a.employee_id = e.id);
      INSERT OR IGNORE INTO departments (name)
        SELECT trim(json_extract(data, '$.department')) FROM employees
        WHERE trim(json_extract(data, '$.department')) != '';
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL, role TEXT NOT NULL, employee_id TEXT REFERENCES employees(id),
        active INTEGER NOT NULL, password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_reads (
        user_id TEXT NOT NULL REFERENCES users(id), notification_id TEXT NOT NULL,
        read_at TEXT NOT NULL, PRIMARY KEY(user_id, notification_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_limits (
        email TEXT PRIMARY KEY, failures INTEGER NOT NULL, reset_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attendance (
        id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id),
        work_date TEXT NOT NULL, check_in TEXT NOT NULL, check_out TEXT,
        schedule TEXT NOT NULL, timezone TEXT NOT NULL,
        UNIQUE(employee_id, work_date)
      );
      DROP INDEX IF EXISTS one_open_interval;
      CREATE TABLE IF NOT EXISTS attendance_evidence (
        attendance_id TEXT NOT NULL REFERENCES attendance(id),
        event TEXT NOT NULL CHECK(event IN ('check-in', 'check-out')),
        latitude REAL NOT NULL, longitude REAL NOT NULL,
        accuracy_meters REAL NOT NULL, distance_meters REAL NOT NULL,
        captured_at TEXT NOT NULL, submitted_at TEXT NOT NULL,
        policy TEXT NOT NULL, photo BLOB NOT NULL,
        PRIMARY KEY(attendance_id, event)
      );
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL,
        action TEXT NOT NULL, record_id TEXT NOT NULL, at TEXT NOT NULL,
        reason TEXT, before_data TEXT, after_data TEXT
      );
      CREATE TABLE IF NOT EXISTS attendance_location (
        attendance_id TEXT PRIMARY KEY REFERENCES attendance(id), data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS employee_requests (
        id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id),
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'withdrawn')),
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_by_employee ON employee_requests(employee_id, status);
      CREATE INDEX IF NOT EXISTS requests_history_by_employee ON employee_requests(employee_id);
      CREATE INDEX IF NOT EXISTS requests_by_status ON employee_requests(status);
      CREATE INDEX IF NOT EXISTS pending_requests_by_employee ON employee_requests(employee_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS audit_by_record ON audit(record_id);
      CREATE INDEX IF NOT EXISTS audit_by_actor ON audit(actor_id);
      CREATE INDEX IF NOT EXISTS audit_by_action ON audit(action);
      CREATE INDEX IF NOT EXISTS audit_by_date ON audit(at);
      CREATE INDEX IF NOT EXISTS audit_request_notifications ON audit(json_extract(after_data, '$.employeeId'))
        WHERE action IN ('request.approved', 'request.rejected', 'request.reopened', 'request.manager_reviewed');
      CREATE TABLE IF NOT EXISTS payroll_runs (
        month TEXT PRIMARY KEY, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payroll_deductions (
        id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id),
        month TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payroll_deductions_by_month ON payroll_deductions(month, employee_id);
      CREATE TABLE IF NOT EXISTS sales_activities (
        id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id),
        activity_date TEXT NOT NULL, deal_reference TEXT UNIQUE COLLATE NOCASE,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sales_by_employee_date ON sales_activities(employee_id, activity_date);
      CREATE TABLE IF NOT EXISTS sales_targets (
        employee_id TEXT NOT NULL REFERENCES employees(id), month TEXT NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY(employee_id, month)
      );
    `;
