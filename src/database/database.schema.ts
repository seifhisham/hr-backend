export const DATABASE_SCHEMA = `
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL, role TEXT NOT NULL, employee_id TEXT REFERENCES employees(id),
        active INTEGER NOT NULL, password_hash TEXT NOT NULL
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
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_interval ON attendance(employee_id) WHERE check_out IS NULL;
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
      CREATE TABLE IF NOT EXISTS employee_requests (
        id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id),
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_by_employee ON employee_requests(employee_id, status);
    `;
