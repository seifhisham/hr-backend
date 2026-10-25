# Company and branch access

Migration 3 preserves existing row payloads and adds branch metadata, assignment profile snapshots and restrictive PostgreSQL policies. Company scope is derived from the authenticated session. Client-supplied company IDs or branch filters never grant access.

## REST API

All paths use the existing cookie or bearer authentication. GET/PATCH return 200; POST returns 201. Request objects reject unknown fields.

| Method | Path | Access / body |
| --- | --- | --- |
| GET | `/api/branches` | Administrator: all company branches; HR: explicitly granted branches, including inactive history |
| POST | `/api/branches` | Administrator; branch definition |
| PATCH | `/api/branches/:id` | Administrator; complete branch definition |
| GET | `/api/hr-accounts` | Administrator; HR account IDs, names and emails |
| GET | `/api/hr-accounts/:id/branches` | Administrator; array of granted branch IDs |
| PATCH | `/api/hr-accounts/:id/branches` | Administrator; `{ "branchIds": ["uuid"], "reason": "Approved responsibility" }`; atomically replaces grants |
| GET | `/api/employees/:id/branches` | Administrator or granted HR; permitted assignment history |
| POST | `/api/employees/:id/branches` | Administrator; `{ "branchId": "uuid", "effectiveFrom": "2026-10-16", "reason": "Branch transfer" }` |

A branch definition contains `code`, `name`, `address`, `active`, `latitude`, `longitude`, `radiusMeters`, `trackingRadiusMeters`, `trackingGraceMinutes`. Code uses lowercase letters, digits and hyphens (1–63 characters). Coordinates and positive radii are validated. Address defaults to empty and active defaults to true. Branches share the company timezone. Deactivation requires moving current/future active staff and closing attendance. History is retained.

Employee creation accepts `branchId`; omission is supported only when exactly one permitted active branch exists. Existing employee edits cannot change branch; use the dated transfer API. Transfers cannot precede today/employment, conflict with a later scheduled assignment, leave open attendance, or cross pending/approved request ranges. A request spanning a transfer must be split. Transfer scheduling snapshots the outgoing profile; it does not rewrite historical business records.

`GET /api/auth/me` additionally returns `workspace`, `companyStatus`, `companyId` and `hrBranchIds`. Its employee contains resolved `branchId`; location settings for a linked employee use that employee's assigned branch. The company catalog/location administration remains administrator-only.

## Permission behavior

- HR has explicit grants, independent of its own home branch. No-grant HR can use personal employee functions but cannot use HR administration.
- Current directory changes require current-branch access. Attendance, evidence, requests, sales, audit, notifications and exports follow their dated/saved branch. Transferred employees remain in authorized historical reports without exposing their new profile.
- Attendance policy and tracking use the attendance record's saved branch coordinates/policy. Location changes and overnight transfers cannot rewrite the open workday. Employees do not submit an authoritative branch ID.
- HR cannot approve company-wide payroll or edit shared company settings/schedules. Approved payroll is filtered before delivery; approval identity/reason is hidden from HR. Monthly payroll rows, deductions and sales targets spanning an ungranted branch are omitted, rather than exposing another branch's salary data. Payroll locks still apply even when its full snapshot is hidden.
- Company-wide audit events remain administrator-visible. Branch HR sees authorized branch events. Grant/transfer audit events do not expose another branch's history.
- Grants, account role/status, company status and sessions are rechecked in transactions and before delivering queued reports, CSV, gzip or photo data. Changing grants can return 403 for an in-flight HR request; refresh session data before retrying. Logout/password changes intentionally end their own sessions.
- Invalid cross-company references are rejected. Searches, cursor lookups, files and mutations use the same company boundary as normal lists.
- Expensive attendance reports allow at most two outstanding requests per company; additional requests receive 429. Clients should wait before retrying.

The dashboard's **Branches & access** page manages branches, HR grants and employee transfers. Attendance has a branch filter. An existing single active branch continues to synchronize the legacy company location fields; with multiple active branches, edit locations on the branch page.

## Safe upgrade

1. Back up PostgreSQL and the application source; retain the original SQLite files separately. Rehearse migration 3 against a restored database and compare all original columns and row hashes.
2. Stop backend writers. Make a fresh PostgreSQL backup and original-row manifest immediately before migration. Do not import the rehearsal database over the real company.
3. Run the existing explicit migration command with `HR_PG_MIGRATION_URL`, then start the backend with restricted `HR_PG_URL`. Migration 3 grants new narrow functions to standard `hr_runtime`. For a custom runtime role, grant `BRANCH_FUNCTIONS` alongside the existing runtime functions using the runtime-role provisioning procedure.
4. Reconcile original rows and evidence bytes, verify existing-account REST login, and check company/branch reads. Retain both backups. Startup refuses a schema/application version mismatch.

Rollback after new target writes requires reconciling those writes first. Do not restore an older dump over current company data as a routine retry. Platform-owner identity, customer onboarding/MFA, production deployment, capacity and hosting remain separate plan gates.
