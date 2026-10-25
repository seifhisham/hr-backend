# PostgreSQL foundation

For the current production procedure, start with the [production deployment guide](../docs/operations/PRODUCTION_DEPLOYMENT.md). It recommends a fresh production database when local data is disposable and separately documents PostgreSQL/key transfer.

Platform-owner login/MFA, company onboarding and migration 4: see [owner API and runbook](OWNER.md).

Company/branch permissions, migration 3 and dashboard administration: see [branch API and safe upgrade](BRANCHES.md).

This tooling supports the [multi-tenancy implementation plan](../docs/plans/MULTI_TENANCY_PLAN.md). The source application now runs on PostgreSQL only and requires explicit HR_PG_URL configuration. Feature services and REST fixtures have been ported. Existing deployed SQLite instances and their data have not been changed; nothing imports data or switches live traffic automatically. Owner administration and branch permissions are implemented; production cutover remains a separate release gate.

## Local database

Requires Node 24 and running Docker Desktop. From the workspace root, use `hr-backend/.env.postgres.example` as a reference for local environment variables. Store actual values in ignored configuration and export them to the current shell; do not commit credentials. Generated development credentials for this workspace are in `.tmp/postgres-foundation.env`.

On a fresh checkout, create `.tmp/postgres-foundation.env` from the example with new unique passwords and matching URLs before running these commands. Never overwrite an existing local configuration just to repeat setup.

```powershell
# Load only the generated local foundation configuration, never an untrusted env file.
Get-Content .tmp/postgres-foundation.env | ForEach-Object {
  $pgSetting = $_ -split '=', 2
  [Environment]::SetEnvironmentVariable($pgSetting[0], $pgSetting[1], 'Process')
}
docker compose --env-file .tmp/postgres-foundation.env -f compose.postgres.yaml up -d --wait
npm --prefix hr-backend run pg:migrate
npm --prefix hr-backend run pg:runtime-role
npm --prefix hr-backend run test:postgres
```

The Compose project uses PostgreSQL 18, loopback port 55432, and a dedicated volume. It does not reference the SQLite volume. Its migration user is a privileged local development account. Production requires separate migration/administration and restricted runtime credentials with appropriate TLS/network restrictions.

`pg:migrate` applies each migration once and rejects edited checksums or unsupported future versions. Keep applied migration content immutable; add a new version for subsequent changes. `pg:runtime-role` creates `hr_runtime` with a separate password of at least 24 characters; it deliberately refuses to alter an existing role or rotate credentials implicitly. Run it once after initial migration. Later migrations must explicitly update grants for new tables.

Tests require `HR_PG_TEST_ADMIN_URL` to a development cluster account allowed to create databases and roles. They create an isolated randomly named test database and runtime role and remove them afterward. They do not truncate the supplied development database. Forced termination can leave `hr_foundation_test_*` databases or `hr_test_*` roles; inspect and identify them before manually removing them. Never point tests at production infrastructure.

## Transactions and isolation

`PostgresStore.companyTransaction(companyId, async client => ...)` runs awaited queries on the same checked-out client and sets company context locally for that transaction. Use parameterized queries, never client-supplied authoritative company IDs. The application DatabaseService uses the same transaction-local company scope. Login resolves an explicit workspace code; sessions carry the verified company identity. The request interceptor supplies that identity, and transactions recheck active company/session/role. Optional HR_DEFAULT_WORKSPACE supports an explicitly configured legacy client workspace; no implicit first-company fallback exists. Migration and import use separate privileged connections and must never be used to serve company API requests.

All company tables have RLS enabled and forced. No company context means no rows/denied inserts. Composite foreign keys guard modeled same-company references. Existing role permissions, active-company checks, and same-company references are enforced by the port. The agreed HR branch restrictions, transfer/history rules, owner authentication and full multi-company lifecycle still require implementation; this is not the complete SaaS security release. Do not expose the new runtime database directly to clients.

## Import rehearsal and eventual cutover

The importer requires an explicit absolute SQLite source, a new absolute backup path, UUIDs for the original company/branch, a workspace code, and company/branch names. The source is opened read-only. A consistent SQLite backup captures committed WAL changes before source data is read. Existing backup paths are never overwritten. Use a backup directory protected for employee data and with sufficient space; Windows file permissions inherit from that directory.

Only run this against an empty, already migrated PostgreSQL target. Identify the correct source/company/branch first. For rehearsal, use an authorized isolated copy. Do not run against your current database just to try the command.

```powershell
npm --prefix hr-backend run pg:import-sqlite -- `
  --source 'C:/absolute/path/authorized-copy.sqlite' `
  --backup 'C:/absolute/path/new-backup.sqlite' `
  --company-id '11111111-1111-4111-8111-111111111111' `
  --branch-id '22222222-2222-4222-8222-222222222222' `
  --workspace 'original-company' `
  --company-name 'Original Company' `
  --branch-name 'Original Branch'
```

The report contains table counts/checksums, backup path, and revoked-session count, not employee records or connection credentials. Failure output is generic to avoid leaking SQL row details. A verified backup survives failed imports. Unsupported/legacy schemas require upgrading an isolated copy through the existing migration path first; the importer does not silently normalize or discard unknown tables/columns.

For an older schema, first make an authorized consistent copy. From `hr-backend`, build the source, set `HR_DATABASE_PATH` to that copy's absolute path, and run the retained offline upgrade code. Never set this path to the live database:

```powershell
$env:HR_DATABASE_PATH = 'C:/absolute/path/isolated-copy.sqlite'
node --input-type=module -e "const { LegacySqliteStore } = await import('./dist/database/legacy-sqlite.js'); const copy = new LegacySqliteStore(); copy.onModuleDestroy();"
```

Use the upgraded copy as the explicit import source. The Nest application does not register this legacy store.

All durable source columns are verified after insertion. Password hashes and JSON text remain exact; binary evidence is verified byte-for-byte. The explicit exception is open tracking state: pending departure coverage is reset to unavailable, so downtime cannot generate a penalty. Existing sessions/login limits are omitted. Frozen payroll, closed attendance, and original backup rows remain unchanged. HR users receive grants to the original branch. The target company stays provisioning.

The importer loads one table at a time; measure memory/time before large data imports. This release has synthetic import and PostgreSQL REST regression coverage only. A real cutover still requires a write freeze, final backup/import reconciliation, PostgreSQL-backed REST regression checks, client contract rollout, and the rollback procedure in the plan. Before new target writes, the original SQLite/app remain available for rollback; after new writes, preserve and reconcile those writes before any rollback.

To stop the separate foundation database without deleting data:

```powershell
docker compose --env-file .tmp/postgres-foundation.env -f compose.postgres.yaml stop
```

Do not remove its volume to retry an import when data needs preserving. No production deployment or automatic activation is part of this foundation stage.

## Running the converted application

Apply migrations with HR_PG_MIGRATION_URL and use a distinct restricted HR_PG_URL for Nest. Startup checks the role and schema version. Migration 2 adds runtime auth/metadata functions, transaction defaults, employee/attendance branch attribution, and company revision triggers for cache invalidation. The CLI grants the narrow functions to a newly created runtime role; migration 2 also updates the standard existing hr_runtime role.

A successful import leaves the original company provisioning. Review reconciliation before explicitly activating it. Do not start the application against a provisioning company or improvise a new empty replacement for existing data. HR_BOOTSTRAP_COMPANY_ID may select an already active company to initialize missing administrator/settings/schedules; it never creates companies or overwrites existing accounts. Clear it after initialization. The dashboard sends company code, email and password. The returned user includes companyId.

Unit/REST/load fixtures create uniquely named disposable databases and restricted roles in HR_PG_TEST_ADMIN_URL's development cluster. They never open the live SQLite file. Unit/REST roles disable synchronous commit only for disposable fixture speed; application/deployment durability defaults remain unchanged. Legacy SQLite schema-upgrade tests use generated temporary files; LegacySqliteStore is not registered in the runtime application.

Reads use read-only transactions; writes serialize per company with a transaction advisory lock. Nested business writes and audit/evidence use the same client. Attendance reports use repeatable-read snapshots and recheck authorization before delivery. Reference caches include company identity and use database revision triggers to detect committed changes, including another connection.

Compose requires an explicit runtime URL before a new image can start. For the separate local foundation database from a container, use host.docker.internal:55432 in that URL. Keep the existing hr-data volume; it remains mounted for preservation, and the new application does not open SQLite. No container serving existing company data has been rebuilt or restarted as part of this conversion.
