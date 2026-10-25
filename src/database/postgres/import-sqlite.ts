import { createHash } from 'node:crypto';
import { closeSync, openSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { LEGACY_TABLES, TRANSIENT_TABLES } from './schema.js';

const optionsSchema = z
  .object({
    source: z.string().refine(isAbsolute, 'Source must be an absolute path'),
    backup: z.string().refine(isAbsolute, 'Backup must be an absolute path'),
    companyId: z.uuid(),
    branchId: z.uuid(),
    workspace: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    companyName: z.string().trim().min(1).max(200),
    branchName: z.string().trim().min(1).max(200),
  })
  .strict();

type ImportOptions = z.infer<typeof optionsSchema>;
type Row = Record<string, string | number | bigint | Uint8Array | null>;

function json(value: unknown): Record<string, unknown> {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(z.string().parse(value)));
}

function digest(rows: Row[], columns: string[]) {
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(
      JSON.stringify(
        columns.map((column) => {
          const value = row[column];
          return value instanceof Uint8Array
            ? { bytes: Buffer.from(value).toString('base64') }
            : value === null
              ? null
              : String(value);
        }),
      ),
    );
    hash.update('\n');
  }
  return hash.digest('hex');
}

export async function importSqlite(pool: Pool, rawOptions: ImportOptions) {
  const options = optionsSchema.parse(rawOptions);
  if (
    resolve(options.source).toLowerCase() ===
    resolve(options.backup).toLowerCase()
  )
    throw new Error('Source and backup must be different files');
  if (!statSync(options.source).isFile())
    throw new Error('Source is not a file');
  // Reserve exclusively: never overwrite an existing backup, even on a failed retry.
  closeSync(openSync(options.backup, 'wx', 0o600));
  const source = new DatabaseSync(options.source, { readOnly: true });
  try {
    await backup(source, options.backup);
  } finally {
    source.close();
  }
  const snapshot = new DatabaseSync(options.backup, { readOnly: true });
  try {
    const check = snapshot.prepare('PRAGMA integrity_check').all();
    if (
      check.length !== 1 ||
      Object.values(check[0])[0] !== 'ok' ||
      snapshot.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error(
        'SQLite backup failed integrity or foreign key verification',
      );
    const tables = snapshot
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((row) => String(row.name));
    const known = [...LEGACY_TABLES, ...TRANSIENT_TABLES];
    if (
      tables.some((name) => !known.includes(name as (typeof known)[number])) ||
      known.some((name) => !tables.includes(name))
    )
      throw new Error(
        'Source schema is not the supported current SQLite schema; upgrade an isolated copy first',
      );
    const companyRow = snapshot
      .prepare("SELECT value FROM settings WHERE key = 'company'")
      .get();
    const settings = json(companyRow?.value);
    const timezone = z.string().parse(settings.timezone);
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    const policy = {
      latitude: 30.023092,
      longitude: 31.528179,
      radiusMeters: 50,
      trackingRadiusMeters: 150,
      trackingGraceMinutes: 5,
      ...settings,
    };
    z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radiusMeters: z.number().positive(),
      trackingRadiusMeters: z.number().positive(),
      trackingGraceMinutes: z.number().positive(),
    }).parse(policy);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(715104, 1)');
      await client.query('LOCK TABLE companies IN ACCESS EXCLUSIVE MODE');
      const privileged = await client.query<{ allowed: boolean }>(
        'SELECT rolsuper OR rolbypassrls AS allowed FROM pg_roles WHERE rolname = current_user',
      );
      if (!privileged.rows[0]?.allowed)
        throw new Error(
          'Import requires a dedicated privileged migration connection',
        );
      const existing = await client.query('SELECT 1 FROM companies LIMIT 1');
      if (existing.rowCount)
        throw new Error(
          'Import requires an empty target; existing companies are never overwritten',
        );
      await client.query(
        `INSERT INTO companies(id,workspace_code,name,timezone,status)
        VALUES ($1,$2,$3,$4,'provisioning')`,
        [options.companyId, options.workspace, options.companyName, timezone],
      );
      await client.query(
        `INSERT INTO branches(company_id,id,code,name,policy)
        VALUES ($1,$2,'original',$3,$4)`,
        [
          options.companyId,
          options.branchId,
          options.branchName,
          JSON.stringify(policy),
        ],
      );

      const counts: Record<string, number> = {};
      const checksums: Record<string, string> = {};
      for (const table of LEGACY_TABLES) {
        // shortcut: verification loads one table at a time; stream batches before large customer imports.
        const rows = snapshot
          .prepare(`SELECT rowid AS row_order, * FROM ${table} ORDER BY rowid`)
          .all() as Row[];
        const columns = [
          'row_order',
          ...snapshot
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((r) => String(r.name)),
        ];
        const targetColumns = await client.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
          [table],
        );
        if (
          columns.some(
            (column) =>
              !targetColumns.rows.some((r) => r.column_name === column),
          )
        )
          throw new Error(`Unsupported source columns in ${table}`);
        for (const row of rows) {
          for (const field of [
            'data',
            'policy',
            'schedule',
            'before_data',
            'after_data',
          ])
            if (row[field] != null) JSON.parse(String(row[field]));
          const added: Row = {};
          if (table === 'employees') {
            const employee = json(row.data);
            if (employee.id !== row.id)
              throw new Error('Employee payload identity mismatch');
            added.employee_number = z
              .string()
              .min(1)
              .parse(employee.employeeNumber);
            added.manager_id = z
              .string()
              .nullable()
              .parse(employee.managerId ?? null);
          }
          if (table === 'attendance') {
            const evidence = snapshot
              .prepare(
                "SELECT policy FROM attendance_evidence WHERE attendance_id=? AND event='check-in'",
              )
              .get(row.id);
            added.branch_id = options.branchId;
            added.branch_snapshot = JSON.stringify({
              id: options.branchId,
              name: options.branchName,
              code: 'original',
              provenance: 'legacy-attribution',
              policy: evidence ? json(evidence.policy) : policy,
              policySource: evidence
                ? 'check-in-evidence'
                : 'legacy-current-settings',
            });
          }
          // Coverage cannot be trusted across migration downtime; do not carry a departure penalty forward.
          if (table === 'attendance_location') {
            const state = json(row.data);
            if (state.status !== 'auto-checked-out') {
              row.data = JSON.stringify({
                ...state,
                status: 'unavailable',
                lastCapturedAt: null,
                outsideSince: null,
                returnBy: null,
              });
            }
          }
          const fields = [...columns, ...Object.keys(added), 'company_id'];
          const values = [
            ...columns.map((field) => row[field]),
            ...Object.values(added),
            options.companyId,
          ].map((value) =>
            value instanceof Uint8Array ? Buffer.from(value) : value,
          );
          await client.query(
            `INSERT INTO ${table} (${fields.map((field) => `"${field}"`).join(',')})
            VALUES (${values.map((_, index) => `$${index + 1}`).join(',')})`,
            values,
          );
        }
        const imported = await client.query<Row>(
          `SELECT ${columns.map((field) => `"${field}"`).join(',')} FROM ${table} WHERE company_id=$1 ORDER BY row_order`,
          [options.companyId],
        );
        const checksum = digest(rows, columns);
        if (
          rows.length !== imported.rowCount ||
          checksum !== digest(imported.rows, columns)
        )
          throw new Error(`Import verification failed for ${table}`);
        counts[table] = rows.length;
        checksums[table] = checksum;
        await resetSequence(client, table);
      }
      for (const row of snapshot
        .prepare('SELECT id, data FROM employees')
        .all()) {
        const employee = json(row.data);
        const startDate = z.iso.date().parse(employee.startDate);
        await client.query(
          `INSERT INTO employee_branches(company_id,employee_id,branch_id,effective_from)
          VALUES ($1,$2,$3,$4)`,
          [options.companyId, row.id, options.branchId, startDate],
        );
      }
      await client.query(
        `INSERT INTO hr_branch_grants(company_id,user_id,branch_id)
        SELECT company_id,id,$2 FROM users WHERE company_id=$1 AND role='hr'`,
        [options.companyId, options.branchId],
      );
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query('COMMIT');
      return {
        counts,
        checksums,
        backup: options.backup,
        companyStatus: 'provisioning',
        revokedSessions: Number(
          snapshot.prepare('SELECT count(*) AS n FROM sessions').get()!.n,
        ),
        resetLoginLimits: Number(
          snapshot.prepare('SELECT count(*) AS n FROM login_limits').get()!.n,
        ),
        trackingCoverageReset: true,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    snapshot.close();
  }
}

async function resetSequence(client: PoolClient, table: string) {
  await client.query(
    `SELECT setval(pg_get_serial_sequence($1,'row_order'),
    greatest(coalesce((SELECT max(row_order) FROM ${table}),0),1),
    EXISTS(SELECT 1 FROM ${table}))`,
    [table],
  );
}
