import { BRANCH_LIMIT_FUNCTIONS } from '../dist/database/postgres/branch-limits-schema.js';
import { OWNER_FUNCTIONS } from '../dist/database/postgres/owner-schema.js';
import { BRANCH_FUNCTIONS } from '../dist/database/postgres/branch-schema.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../dist/database/postgres/migrations.js';
import { TENANT_TABLES } from '../dist/database/postgres/schema.js';
import { RUNTIME_FUNCTIONS } from '../dist/database/postgres/runtime-schema.js';
import { PostgresStore } from '../dist/database/postgres/store.js';
import { companyContext } from '../dist/database/database.service.js';

export function inLoadCompany(work) {
  if (!process.env.HR_BOOTSTRAP_COMPANY_ID)
    throw new Error('Missing isolated load-test company');
  return companyContext.run(
    { companyId: process.env.HR_BOOTSTRAP_COMPANY_ID },
    work,
  );
}

export async function createLoadDatabase() {
  if (!process.env.HR_PG_TEST_ADMIN_URL)
    throw new Error('Set HR_PG_TEST_ADMIN_URL to a development cluster');
  const admin = new Pool({
    connectionString: process.env.HR_PG_TEST_ADMIN_URL,
  });
  admin.on('error', () =>
    console.error('PostgreSQL load-test administration connection failed'),
  );
  const suffix = randomBytes(8).toString('hex');
  const database = `hr_load_${suffix}`,
    role = `hr_load_${suffix}`,
    password = randomBytes(32).toString('hex');
  const companyId = randomUUID(),
    branchId = randomUUID();
  let owner, runtime;
  async function close() {
    await runtime?.close();
    await owner?.end();
    try {
      // These identifiers are generated locally; no supplied database is dropped.
      for (let attempt = 0; attempt < 40; attempt++) {
        const result = await admin.query(
          'SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1',
          [database],
        );
        if (Number(result.rows[0].n) === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
    } finally {
      await admin.end();
    }
  }
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(process.env.HR_PG_TEST_ADMIN_URL);
    url.pathname = `/${database}`;
    owner = new Pool({ connectionString: url.href });
    owner.on('error', () =>
      console.error('PostgreSQL load-test fixture connection failed'),
    );
    await migrate(owner);
    await admin.query(
      `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    const sql = await admin.query(
      "SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql",
      [role, password],
    );
    await admin.query(sql.rows[0].sql);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON companies,${TENANT_TABLES.join(',')} TO ${role}`,
    );
    await owner.query(
      `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    );
    for (const signature of [
      ...RUNTIME_FUNCTIONS,
      ...BRANCH_FUNCTIONS,
      ...OWNER_FUNCTIONS,
    ...BRANCH_LIMIT_FUNCTIONS,
    ])
      await owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${role}`);
    await owner.query(
      `INSERT INTO companies(id,workspace_code,name,timezone,status)
      VALUES($1,'load-test','Load test','Africa/Cairo','active')`,
      [companyId],
    );
    await owner.query(
      `INSERT INTO branches(company_id,id,code,name,policy) VALUES($1,$2,'main','Main',$3)`,
      [
        companyId,
        branchId,
        JSON.stringify({
          latitude: 30.023092,
          longitude: 31.528179,
          radiusMeters: 50,
          trackingRadiusMeters: 150,
          trackingGraceMinutes: 5,
        }),
      ],
    );
    url.username = role;
    url.password = password;
    runtime = new PostgresStore({ connectionString: url.href });
    const db = {
      prepare(text) {
        let parameter = 0;
        const sql = text.replace(/\?/g, () => `$${++parameter}`);
        const query = async (values) => {
          const result = await runtime.companyTransaction(companyId, (client) =>
            client.query(sql, values),
          );
          for (const row of result.rows)
            if ('count' in row) row.count = Number(row.count);
          return result;
        };
        return {
          get: async (...values) => (await query(values)).rows[0],
          all: async (...values) => (await query(values)).rows,
          run: async (...values) => ({
            changes: (await query(values)).rowCount,
          }),
        };
      },
      async close() {},
    };
    return {
      db,
      close,
      env: {
        HR_PG_URL: url.href,
        HR_BOOTSTRAP_COMPANY_ID: companyId,
        HR_DEFAULT_WORKSPACE: 'load-test',
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
