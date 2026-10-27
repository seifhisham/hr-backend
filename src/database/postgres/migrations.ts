import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { INITIAL_SCHEMA } from './schema.js';
import { RUNTIME_SCHEMA } from './runtime-schema.js';
import { BRANCH_SCHEMA } from './branch-schema.js';
import { OWNER_SCHEMA } from './owner-schema.js';
import { BRANCH_LIMIT_SCHEMA } from './branch-limits-schema.js';
import { PUSH_SCHEMA } from './push-schema.js';

export const MIGRATIONS = [
  { version: 1, name: 'company_foundation', sql: INITIAL_SCHEMA },
  { version: 2, name: 'runtime_company_context', sql: RUNTIME_SCHEMA },
  { version: 3, name: 'branch_permissions', sql: BRANCH_SCHEMA },
  { version: 4, name: 'platform_owner_onboarding', sql: OWNER_SCHEMA },
  { version: 5, name: 'owner_company_branch_limits', sql: BRANCH_LIMIT_SCHEMA },
  { version: 6, name: 'android_push_delivery', sql: PUSH_SCHEMA },
];

export async function migrate(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(715104, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    if (
      applied.rows.some(
        (row) => !MIGRATIONS.some((m) => m.version === row.version),
      )
    )
      throw new Error('Database schema is newer than this migration runner');
    const versions: number[] = [];
    for (const migration of MIGRATIONS) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const existing = applied.rows.find(
        (row) => row.version === migration.version,
      );
      if (existing) {
        if (existing.checksum !== checksum)
          throw new Error(`Migration ${migration.version} checksum changed`);
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations(version,name,checksum) VALUES ($1,$2,$3)',
        [migration.version, migration.name, checksum],
      );
      versions.push(migration.version);
    }
    await client.query('COMMIT');
    return versions;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
