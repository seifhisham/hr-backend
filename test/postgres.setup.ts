import { BRANCH_LIMIT_FUNCTIONS } from '../src/database/postgres/branch-limits-schema.js';
import { OWNER_FUNCTIONS } from '../src/database/postgres/owner-schema.js';
import { BRANCH_FUNCTIONS } from '../src/database/postgres/branch-schema.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  test as baseTest,
  vi,
} from 'vitest';
import { companyContext } from '../src/database/database.service.js';
import { migrate } from '../src/database/postgres/migrations.js';
import { TENANT_TABLES } from '../src/database/postgres/schema.js';
import { RUNTIME_FUNCTIONS } from '../src/database/postgres/runtime-schema.js';

const connectionString = process.env.HR_PG_TEST_ADMIN_URL;
if (!connectionString)
  throw new Error(
    'Set HR_PG_TEST_ADMIN_URL to an isolated development PostgreSQL cluster',
  );
const suffix = randomBytes(8).toString('hex');
const database = `hr_rest_test_${suffix}`;
const role = `hr_rest_${suffix}`;
const password = randomBytes(32).toString('hex');
const companyId = randomUUID();
export const testCompanyId = companyId;
const branchId = randomUUID();
const admin = new Pool({ connectionString });
admin.on('error', () =>
  console.error('PostgreSQL test administration connection failed'),
);
let fixture: Pool;
let runtimeUrl: string;

export async function provisionTestCompany(workspace: string) {
  const id = randomUUID();
  await fixture.query(
    `INSERT INTO companies(id,workspace_code,name,timezone,status)
    VALUES($1,$2,$2,'Africa/Cairo','active')`,
    [id, workspace],
  );
  await fixture.query(
    `INSERT INTO branches(company_id,id,code,name,policy)
    VALUES($1,$2,'main','Main',$3)`,
    [
      id,
      randomUUID(),
      JSON.stringify({
        latitude: 30.023092,
        longitude: 31.528179,
        radiusMeters: 50,
      }),
    ],
  );
  return id;
}

// Run the callbacks themselves in scope; fixture setup alone does not propagate ALS into Vitest's runner.
function scopedRegistration(register: typeof baseTest): typeof baseTest {
  return new Proxy(register, {
    apply(target, receiver, args: unknown[]) {
      const index = args.findIndex(
        (arg, i) => i > 0 && typeof arg === 'function',
      );
      if (index >= 0) {
        const callback = args[index] as (...values: unknown[]) => unknown;
        args[index] = (...values: unknown[]) =>
          companyContext.run({ companyId }, () => callback(...values));
      }
      return Reflect.apply(target, receiver, args);
    },
    get(target, property) {
      if (property === 'each' || property === 'for')
        return (...args: unknown[]) =>
          scopedRegistration(
            Reflect.apply(Reflect.get(target, property), target, args),
          );
      return Reflect.get(target, property);
    },
  });
}
Object.assign(globalThis, {
  it: scopedRegistration(baseTest),
  test: scopedRegistration(baseTest),
});
for (const [name, register] of Object.entries({ beforeEach, afterEach })) {
  Object.assign(globalThis, {
    [name]: (callback: (...args: unknown[]) => unknown, timeout?: number) =>
      register(
        (...args) => companyContext.run({ companyId }, () => callback(...args)),
        timeout,
      ),
  });
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  fixture = new Pool({ connectionString: url.href });
  fixture.on('error', () =>
    console.error('PostgreSQL test fixture connection failed'),
  );
  await migrate(fixture);
  await admin.query(
    `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  // Disposable fixtures do not need crash durability; production retains PostgreSQL defaults.
  await admin.query(`ALTER ROLE ${role} SET synchronous_commit=off`);
  const sql = await admin.query(
    "SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql",
    [role, password],
  );
  await admin.query(sql.rows[0].sql);
  await fixture.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await fixture.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON companies,${TENANT_TABLES.join(',')} TO ${role}`,
  );
  await fixture.query(
    `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
  );
  for (const signature of [
    ...RUNTIME_FUNCTIONS,
    ...BRANCH_FUNCTIONS,
    ...OWNER_FUNCTIONS,
    ...BRANCH_LIMIT_FUNCTIONS,
  ])
    await fixture.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${role}`);
  url.username = role;
  url.password = password;
  runtimeUrl = url.href;
});

beforeEach(async () => {
  await fixture.query(
    `TRUNCATE platform_owners,platform_login_limits,platform_audit,companies,${TENANT_TABLES.join(',')} RESTART IDENTITY CASCADE`,
  );
  await fixture.query(
    `INSERT INTO companies(id,workspace_code,name,timezone,status)
    VALUES($1,'test-company','Company HR','Africa/Cairo','active')`,
    [companyId],
  );
  await fixture.query(
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
  vi.stubEnv('HR_PG_URL', runtimeUrl);
  vi.stubEnv('HR_BOOTSTRAP_COMPANY_ID', companyId);
  vi.stubEnv('HR_DEFAULT_WORKSPACE', 'test-company');
});

afterAll(async () => {
  await fixture?.end();
  try {
    // Only names generated by this setup are ever dropped.
    for (let attempt = 0; attempt < 40; attempt++) {
      const sessions = await admin.query(
        'SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1',
        [database],
      );
      if (Number(sessions.rows[0].n) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
  } finally {
    await admin.end();
  }
});

export async function platformTestQuery(sql: string, values: unknown[] = []) {
  return fixture.query(sql, values);
}
