# HR Backend

NestJS REST API for the HR dashboard and the later Flutter application. Uses PostgreSQL, Zod request validation, and session authentication. See [API.md](API.md) for endpoint contracts and [the project BRD](../docs/requirements/BRD.md) for business requirements.

## Backend read cache

Company settings, department lists, and schedule definitions (including date-specific versions) use a process-local JSON cache in `DatabaseService`. It holds at most 256 entries for up to 60 seconds and returns independent objects. Set `HR_READ_CACHE=false` and restart the backend to bypass it.

Cache keys include company identity. Database revision triggers detect committed changes from every connection before cached reads. Reads inside a transaction bypass the cache so uncommitted values are never cached. Failed loads are not cached; invalidation is broad within each company.

Authentication, authorization, employee relationships, schedule assignments, attendance status, notifications, payroll, requests, and sales results remain fresh database reads or calculations. Current dates and workdays are recalculated using the current clock and company timezone. HTTP responses retain their existing `no-store` policy, and clients continue using REST exclusively.

Tests use isolated databases. Run `npm test -- src/database/read-cache.spec.ts` for cache regression checks, including external connection updates, rollback, permissions, expiration, eviction, and mutable results. Do not replace or restore the live database file while the backend is running; restart the backend after an offline restore.

## Report performance and consistency

Employee lists resolve current assignments in bulk. Attendance reports load scoped attendance, location states, effective schedule history, and overlapping approved leave in batches. Sales summaries group raw activities and targets once; payroll groups eligible deductions once without expanding unrelated request workflows. Existing ordering, currency rounding, approved payroll snapshots, and revision checks are retained.

Attendance report construction runs one report at a time per backend process to bound memory. It yields between batches of 1,000 employee/day slots so socket handling and attendance writes can progress. Data is loaded when a report reaches the head of the queue and stays fixed within that report; requests admitted after an update read the new state. Failed reports release the queue. Sessions and role/profile identity are checked again before delivering JSON reports or CSV exports.

Attendance JSON reports of at least 64 KiB use gzip level 1 when the client prefers gzip. Decoded JSON and full CSV exports retain their contracts. Responses remain `no-store`, vary by encoding/client, and fall back to identity if compression fails. A tested Node 24 fetch incompatibility requires identity for its `User-Agent: node` requests with `Connection: close`; persistent connections and the installed Next.js rewrite proxy were tested with gzip. Re-test that workaround after a Node runtime upgrade.

## REST performance benchmark

Run `npm run test:performance` from `hr-backend`. It builds the backend and measures authenticated employee, attendance (one and three months), payroll preview, sales performance, and schedule reads over HTTP with caching off and on. The client and backend run in separate processes. Each endpoint has 30 measured requests with one reader and another 30 with 10 concurrent readers; response download and JSON parsing are included. Fresh HTTP connections avoid keep-alive reuse affecting comparisons; failed requests are recorded without retries.

The benchmark seeds synthetic workloads of 100 and 500 employees into disposable PostgreSQL databases, using July–September 2026 history, four requests and one payroll deduction per employee, and 20 monthly activities per sales employee (25% of employees). Fixture generation is outside timing. Attendance fixtures are closed intervals without photo uploads; this benchmark measures read APIs, not check-in/photo processing or write contention. Localhost results exclude deployment networking, the frontend proxy, and production hardware.

Results are saved as JSON and CSV in `../artifacts/api-performance.*`, with latency percentiles, throughput, decoded and wire response sizes, row counts, failures, backend CPU, event-loop delay, end-of-phase RSS, query plans, and separately profiled SQL counts. SQL profiling includes already-prepared cache change-counter statements and counts `get/all/run` executions; transaction `exec` calls are not included. Partial JSON results are saved as endpoints finish. Every request validates its response, and the run verifies fixture counts and selected business totals. Existing database files and credentials are never used; only the temporary directory created by this run is removed.

For persistent-connection diagnostics, set `HR_PERF_KEEP_ALIVE=true` and run `node test/api-performance.mjs ../artifacts/api-performance-keepalive.json` after building. The default fresh-connection run uses identity for the Node compatibility case above; persistent runs exercise gzip and report its wire size.

Run `npm run test:mixed` to exercise one quarterly-report reader alongside 10 attendance workers on a database with 500 historical employees and 30 new authenticated employees. It also verifies live manager/salary changes, request routing/decisions, and rejection of stale payroll approval. Results and backend resource measurements are saved to `../artifacts/api-mixed-performance.json`.

## Structure

```text
src/
  app.module.ts                 Application composition and global auth guard
  main.ts                       Server startup and HTTP security headers
  auth/                         Login, sessions, passwords, guard, request types
  employees/                    Employee profiles and account provisioning
  schedules/                    Working days, shifts, and grace periods
  company/                      Company name and timezone settings
  attendance/                   Attendance, reports, corrections, GPS/photo evidence
  requests/                     Time-off and forgotten-check-out approval workflows
  audit/                        Audited business changes and activity history
  health/                       Public health endpoint
  database/                     PostgreSQL pool, migrations, scoped transactions, bootstrap
  common/
    decorators/                 Public-route metadata
    security/                   Shared credential and role-check helpers
    types/                      Authenticated actor contract
    validation/                 Shared schemas, parsing, and Zod validation pipe
test/
  hr.e2e-spec.ts                Cross-feature REST and transaction regression tests
  app.e2e-spec.ts               Root endpoint compatibility test
```

Each business feature owns its `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/`, and applicable `types/`. Unit tests live beside the implementation they exercise. Helpers such as attendance time calculations stay with their feature rather than becoming miscellaneous global utilities.

## Conventions

- Controllers handle HTTP transport and delegate business rules to services. DTO schemas and inferred TypeScript types define request contracts; `ZodValidationPipe` validates JSON bodies before handler execution. Multipart attendance evidence has its own location/image validation.
- Modules declare explicit imports and export only shared services. Providers are not registered repeatedly, and the module graph does not use circular `forwardRef` dependencies.
- `AuthGuard` is registered through `APP_GUARD`: routes are protected by default. `@Public()` is reserved for intentional public endpoints. Role and ownership checks remain in services, including cross-feature operations.
- `DatabaseModule` owns the PostgreSQL pool and awaited transaction helper. Bootstrap initializes missing settings/schedules/admin only for an explicitly selected active company. Follow [POSTGRES.md](POSTGRES.md); no automatic SQLite import or company creation occurs.
- Services execute parameterized PostgreSQL queries through the scoped database service. An ORM or generic repository layer is not required for this small system. Do not duplicate the connection or introduce another persistence implementation without a separate migration plan.
- Request approval calls the attendance service's transaction-aware correction method inside the same transaction. Request decision, correction, and audit must commit or roll back together. Nested `DatabaseService.transaction()` calls reuse the active scoped client.
- Attendance reports read an approved-request projection from the shared database, avoiding a runtime circular dependency between attendance and requests. Cross-feature writes go through the responsible service.
- Keep feature-specific DTOs and types local. Add to `common/` only when multiple features genuinely share the contract or behavior. Preserve `.js` import extensions for the project's Node ESM configuration.
- The dashboard and Flutter app consume the REST API only; neither may import backend services or access database files.

The `/` starter response is retained for compatibility; application health is `GET /api/health`.

## Run Locally

Use Node.js 24 or newer, from this directory:

```powershell
npm install
Copy-Item .env.example .env
npm run start:dev
```

Do not put account emails or passwords in `.env`. Create the first platform owner with the [terminal setup](OWNER.md#initial-owner-setup); company administrators use owner-generated invitations. Keep existing accounts in PostgreSQL. Default API address: `http://127.0.0.1:3002/api`; HR_PG_URL must explicitly select the restricted PostgreSQL runtime database. Set up migrations using [POSTGRES.md](POSTGRES.md) before startup. Starting the backend does not create an account.

If port 3002 is already serving this backend, use that running instance instead of starting a second copy. Environment variables and deployment requirements are described in [the workspace README](../README.md).

## Verify

```powershell
npm test
npm run test:e2e
npm run lint
npm run build
```

Production startup after building: `npm run start:prod`. The tests use in-memory or generated temporary databases, never the company's development database.

## Attendance Load Test

```powershell
npm run test:load
```

Builds the backend and runs an isolated loopback HTTP server on an automatically assigned port in a separate process from the client. Provisions 160 test employees through REST, then measures fresh check-ins and check-outs with one client (30 employees), 10 concurrent clients (30 employees), and a 100-client burst (100 employees). Each request uploads a generated 1600x1200 JPEG with valid office coordinates. Caching is enabled, HTTP connections are fresh, and requests are not retried. Provisioning and login are outside attendance timings. Results include success/failure counts, requests per second, median, p95, and maximum response times, saved to `../artifacts/attendance-performance.json`.

All test records, credentials, sessions, audit entries, and photos live in a newly created OS temporary directory, not the company database or Docker volume. The server closes and that entire directory (including temporary files) is removed and its absence verified on success or failure. SIGINT/SIGTERM trigger cleanup where the host delivers those signals. Forced process termination, power loss, or an OS crash cannot guarantee cleanup; any leftover directory is prefixed `hr-attendance-load-` under the OS temporary folder.

The test also checks missing photos, out-of-office GPS, unauthenticated requests, another employee attempting checkout, duplicate submissions, and immediate reads after writes. It verifies one closed attendance record and two non-empty photo-evidence records per employee, removal of location tracking after checkout, foreign keys, and normalization of one stored image. Any unexpected response or incorrect persistence makes the command fail. Partial results are saved with `complete: false` if the run stops early.

After building, pass a JSON path to `node test/attendance-load.mjs` to preserve earlier results. Set `HR_ATTENDANCE_DIAGNOSTICS=true` for a separate instrumented run that records elapsed metadata decode, image normalization (including processing queue wait), and attendance write transaction time. `HR_PERF_SHARP_CONCURRENCY` changes Sharp concurrency only in this benchmark's child server, allowing hardware comparisons without changing production defaults. Diagnostic timings include instrumentation overhead and should not replace the uninstrumented baseline. Set `HR_PERF_PHOTO_WORKLOAD` to `standard-jpeg`, `large-jpeg`, or `png` to compare synthetic upload workloads.

This is a local backend benchmark with fresh employees and no pre-existing attendance/photo history, not a production capacity guarantee or a test of mobile network speeds. It measures attendance writes separately from reports; mixed read/write contention is not tested. Run it on the intended server before choosing a response-time target. Photos are synthetic noise images, not real location proof, and their sizes/processing characteristics may differ from actual camera photos.

This structure follows [Nest's feature-module conventions](https://docs.nestjs.com/modules). HTTPS hosting, backups, retention policy, and pilot acceptance remain deployment work, not part of this structural refactor.


## Expensive endpoint limits

Authenticated accounts share fixed-window budgets across routes in each category:

| Category | Requests | Window | Routes |
| --- | --- | --- | --- |
| Reports | 60 | 1 minute | Attendance report, sales activity lists/performance (team and personal), payroll preview/run/deductions |
| Exports | 10 | 1 minute | Attendance and sales CSV exports |
| Photos | 10 | 1 minute | Attendance check-in and check-out, combined |
| Passwords | 5 | 15 minutes | Password change |

Limits run after authentication and before multipart parsing, image processing, validation, or service work. Invalid attempts consume budget too. Rejected attempts receive HTTP 429 and a `Retry-After` header in seconds. Categories and accounts are independent; new sessions and query/record-ID changes do not reset a budget. Routine profile, policy, location updates, login, and logout are unaffected. Existing account-based login throttling remains separate.

Counters are process-local, expire on demand, and reset on restart. Deploy with one backend instance; replace counters with shared atomic storage before adding replicas. These account limits supplement, rather than replace, perimeter/IP limits and per-request workload bounds. Tune the constants in `src/common/security/rate-limit.guard.ts` using real deployment traffic.


## Searchable activity log

HR/admin can query `GET /api/audit` with `search`, exact `action`, exact `recordId` (including department names and payroll months), exact `actorId`, `from`, `to`, `limit` (1–100, default 50), and `before` (an audit event UUID). Dates include the selected UTC days; displayed times use the company timezone. Search matches actor identity, action, record ID, reason, and saved before/after values. Results remain an array in newest insertion order for compatibility with existing record-history consumers.

The activity-log page uses 50 rows plus one lookahead row to enable Next only when an older matching entry exists. Cursor navigation remains stable as new events are inserted. Filters reset navigation; details display the actor account ID, event ID, reason, and snapshots. The endpoint uses the shared report rate limit.

Successful sign-in/sign-out and actual employee check-in/check-out transitions are now audited. Duplicate attendance retries do not create duplicate transition events. Passwords, tokens, and raw photo data are not added to these events. Existing employee, request, payroll, sales, schedule, department, company, password, and automatic checkout events remain unchanged. Historical actions that were never logged are not backfilled. Failed authentication and read access are not newly logged by this change.
