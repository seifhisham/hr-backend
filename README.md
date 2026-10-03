# HR Backend

NestJS REST API for the HR dashboard and the later Flutter application. Uses SQLite, Zod request validation, and session authentication. See [API.md](API.md) for endpoint contracts and [the project BRD](../BRD.md) for business requirements.

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
  database/                     SQLite connection, schema, transactions, bootstrap
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
- `DatabaseModule` owns the single SQLite connection and synchronous transaction helper. Bootstrap creates initial settings, schedules, and the administrator only when missing. The existing schema, database path, credentials, and REST contracts are unchanged.
- Services currently execute prepared SQLite statements directly. An ORM or generic repository layer is not required for this small system. Do not duplicate the connection or introduce another persistence implementation without a separate migration plan.
- Request approval calls the attendance service's transaction-aware correction method inside the same transaction. Request decision, correction, and audit must commit or roll back together. Do not nest separate `DatabaseService.transaction()` calls.
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

Set `HR_ADMIN_EMAIL` and a unique `HR_ADMIN_PASSWORD` in `.env` before the first start. Do not overwrite an existing `.env`. Default API address: `http://127.0.0.1:3002/api`; default database: `data/hr.sqlite`. Existing administrators are not overwritten by bootstrap environment values.

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

Builds the backend and runs an isolated loopback HTTP server on an automatically assigned port. Provisions 100 test employees, then sends separate bursts of 100 concurrent check-ins and 100 concurrent check-outs with generated 1600x1200 JPEG photos and valid office coordinates. Provisioning is not included in attendance timings. Output includes success/failure counts, requests per second, median, p95, and maximum response times. Any HTTP failure or incorrect stored record/photo count makes the command fail.

All test records, credentials, sessions, audit entries, and photos live in a newly created OS temporary directory, not the company database or Docker volume. The server closes and that entire directory (including SQLite WAL files) is removed and its absence verified on success or failure. SIGINT/SIGTERM trigger cleanup where the host delivers those signals. Forced process termination, power loss, or an OS crash cannot guarantee cleanup; any leftover directory is prefixed `hr-attendance-load-` under the OS temporary folder.

This is a local backend burst benchmark, not a production capacity guarantee or a test of mobile network speeds. Run it on the intended server before choosing a response-time target. It generates synthetic photos, not real location proof, and prints results without saving a report file.

This structure follows [Nest's feature-module conventions](https://docs.nestjs.com/modules). HTTPS hosting, backups, retention policy, and pilot acceptance remain deployment work, not part of this structural refactor.
