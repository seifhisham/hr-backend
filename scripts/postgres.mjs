import {
  PUSH_TABLES,
  PUSH_FUNCTIONS,
} from '../dist/database/postgres/push-schema.js';
import { BRANCH_LIMIT_FUNCTIONS } from '../dist/database/postgres/branch-limits-schema.js';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { migrate } from '../dist/database/postgres/migrations.js';
import { importSqlite } from '../dist/database/postgres/import-sqlite.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(
    [
      'source',
      'backup',
      'company-id',
      'branch-id',
      'workspace',
      'company-name',
      'branch-name',
    ].map((name) => [name, { type: 'string' }]),
  ),
});
if (!process.env.HR_PG_MIGRATION_URL)
  throw new Error('Set HR_PG_MIGRATION_URL explicitly');
const pool = new Pool({
  connectionString: process.env.HR_PG_MIGRATION_URL,
  connectionTimeoutMillis: 5000,
});
try {
  if (positionals.length !== 1)
    throw new Error('Specify migrate, runtime-role, or import-sqlite');
  switch (positionals[0]) {
    case 'migrate':
      console.log(JSON.stringify({ applied: await migrate(pool) }));
      break;
    case 'runtime-role': {
      const password = process.env.HR_PG_RUNTIME_PASSWORD;
      if (!password || password.length < 24)
        throw new Error('Set HR_PG_RUNTIME_PASSWORD (at least 24 characters)');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Refuse to modify an existing role or rotate credentials implicitly.
        await client.query(
          'CREATE ROLE hr_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
        );
        const sql = await client.query(
          "SELECT format('ALTER ROLE hr_runtime PASSWORD %L', $1::text) AS sql",
          [password],
        );
        await client.query(sql.rows[0].sql);
        await client.query('GRANT USAGE ON SCHEMA public TO hr_runtime');
        const { TENANT_TABLES } =
          await import('../dist/database/postgres/schema.js');
        await client.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON companies, ${[...TENANT_TABLES, ...PUSH_TABLES].join(',')} TO hr_runtime`,
        );
        await client.query(
          'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_runtime',
        );
        const { RUNTIME_FUNCTIONS } =
          await import('../dist/database/postgres/runtime-schema.js');
        const { BRANCH_FUNCTIONS } =
          await import('../dist/database/postgres/branch-schema.js');
        const { OWNER_FUNCTIONS } =
          await import('../dist/database/postgres/owner-schema.js');
        for (const signature of [
          ...RUNTIME_FUNCTIONS,
          ...BRANCH_FUNCTIONS,
          ...OWNER_FUNCTIONS,
          ...BRANCH_LIMIT_FUNCTIONS,
          ...PUSH_FUNCTIONS,
        ])
          await client.query(
            `GRANT EXECUTE ON FUNCTION ${signature} TO hr_runtime`,
          );
        await client.query('COMMIT');
        console.log(
          'Created restricted hr_runtime role; company RLS applies. Company/branch policies apply; platform tables have no direct runtime grants.',
        );
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      break;
    }
    case 'import-sqlite':
      console.log(
        JSON.stringify(
          await importSqlite(pool, {
            source: values.source,
            backup: values.backup,
            companyId: values['company-id'],
            branchId: values['branch-id'],
            workspace: values.workspace,
            companyName: values['company-name'],
            branchName: values['branch-name'],
          }),
          null,
          2,
        ),
      );
      break;
    default:
      throw new Error('Specify migrate, runtime-role, or import-sqlite');
  }
} catch (error) {
  // Database errors may include private rows or credentials; keep CLI output generic.
  console.error(
    `PostgreSQL command failed (${error.code ?? error.name ?? 'Error'}). No connection string or row data is printed.`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
