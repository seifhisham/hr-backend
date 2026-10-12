# HR REST API

Confirmed policy: standard hours are 10:00-18:00 and sales hours are 11:00-19:00, Sunday-Thursday with a 15-minute grace period; check-out is mandatory. Both employee attendance endpoints enforce location and photo evidence at latitude 30.023092, longitude 31.528179, within 50 metres. Employee request APIs and HR dashboard review are implemented; Flutter screens are deferred.

Base URL for this workspace: `http://127.0.0.1:3002/api`.

### Attendance location monitoring

`POST /attendance/:id/location` accepts authenticated JSON for an owned open record: `{ "available": true, "latitude": 30.026, "longitude": 31.528179, "accuracyMeters": 10, "capturedAt": "2026-10-12T08:00:00Z" }`, or `{ "available": false }`. Success returns HTTP 201 with location state. `GET /attendance/policy` includes `tracking` (150-metre departure radius, 300-second grace, 30-second reporting target, 90-second staleness limit). Own records and authorized report rows include `location`; CSV exports include status/deadline. Fresh, accurate outside readings confirm departure before a persisted return timer begins. Return or unavailable/stale/uncertain location cancels it. A ten-second backend worker closes attendance at the deadline only with fresh outside evidence, records `attendance.auto_checked_out`, and creates no payroll deduction/photo. Manual capture remains within 50 metres. See [the complete REST contract and mobile acceptance cases](../MOBILE-LOCATION.md).

Requests and responses use JSON except multipart attendance uploads, JPEG photo responses, and CSV export. Protected endpoints accept `Authorization: Bearer <token>` for native clients or the `hr_session` cookie for the dashboard. Browser mutations must originate from an origin listed in `HR_ALLOWED_ORIGINS`; the production cookie requires HTTPS. Browser requests pass through the dashboard's same-origin HTTP proxy, so the API does not enable cross-origin browser access.

## Authentication

`POST /auth/login` (public):

```json
{ "email": "employee@company.example", "password": "a-unique-account-password" }
```

Returns `{ "user": { "id", "name", "email", "role", "employeeId" }, "token": "..." }` and sets an HttpOnly cookie. The Flutter app should retain the token in its platform's secure storage and send it as a bearer token. Browser code uses the cookie and does not persist the token in local storage. Tokens expire after 12 hours; no refresh endpoint is provided in this phase.

- `GET /auth/me`: user, own employee profile (or null for the bootstrap admin), company settings, and today's date in the company timezone.
- `POST /auth/logout`: revokes the supplied session.
- `POST /auth/password`: `{ "currentPassword": "...", "newPassword": "..." }`; requires at least 8 characters for the new password and revokes all sessions. Sign in again afterward.
- `GET /health`: public health response `{ "status": "ok" }`.

## Employee Management

HR/admin access is required.

- `GET /employees`: employee list; excludes credential information.
- `GET /payroll?month=YYYY-MM`: HR/admin monthly payroll preview. Returns employee identity, currency, gross salary, displayed daily rate, deduction days, deduction amount, net salary, and request breakdown. Daily rate is monthly salary / 30; total deduction is rounded once to two decimal places. Only recorded deductions decided in the selected month (company timezone) are counted. Pending requests, historical decisions without deductions, and forgotten check-out requests are excluded. Employees cannot access this report. All profiles employed by the month end are included, including inactive employees with deductions.
- `POST /payroll/deductions`: HR/admin records a salary deduction with required `employeeId` (UUID), `month` (`YYYY-MM`), `days` (positive integer, maximum 365), `reason` (5–500 trimmed characters), and `approvedBy` (approver name, 1–120 trimmed characters). The approver is a name supplied by HR; this does not initiate a separate approval workflow. The server records `id`, `recordedAt`, `recordedBy`, and `recordedById`. Creation and the `payroll.deduction.created` audit are atomic. Invalid inputs return 400, unknown employee 404, employee access 403. Months before employment are rejected. Each submission creates a new deduction; existing deductions cannot be edited through the API. Payroll includes `manualDeductions` with reasons, approvers, and recorder details and adds their days to vacation deduction days in the selected payroll month.
  Set optional `monthlySalary` (nonnegative number with at most two decimal places; `null` means not configured) and `salaryCurrency` (three uppercase letters, default `EGP`) through the employee API. Omitted salary fields retain existing values on edits. Existing employees have no salary configured; missing salary produces null monetary results, while zero salary is valid. Draft payroll uses current salaries and settings. Approved months retain a fixed snapshot. Payroll does not transfer payments, prorate partial months, or calculate taxes/overtime/other attendance deductions. Net salary is gross minus deductions and may be negative if deductions exceed gross.
- `POST /employees`: creates the profile and account together.
  Responses include a server-generated `employeeNumber` (`EMP-000001`, `EMP-000002`, etc.). It is unique, read-only, and retained on edits. Existing employees receive numbers automatically at database initialization. Do not include it in POST or PATCH bodies. The internal UUID `id` and the required `nationalId` remain separate identifiers.
- `PATCH /employees/:id`: replaces editable profile fields; an optional password resets account access. Omit password to retain it.

Employee body:

```json
{
  "nationalId": "00123456789012",
  "name": "Employee Name",
  "email": "employee@company.example",
  "department": "Engineering",
  "jobTitle": "Engineer",
  "startDate": "2026-10-01",
  "scheduleId": "an-existing-schedule-uuid",
  "role": "employee",
  "active": true,
  "password": "a-unique-initial-password"
}
```

Roles: `employee`, `hr`, `admin`. Only administrators can create or edit HR/admin accounts or assign privileged roles. National ID and account email are unique, ignoring case. Deactivation keeps historical attendance and immediately invalidates active sessions. Users cannot change their own role or deactivate their own employee account.

`nationalId` is a required, trimmed string (maximum 120 characters), not a number; leading zeros are preserved. Country-specific ID validation is not configured. This replaces the previous `employeeCode` request/response field, including attendance reports and employee request responses. Existing employee/request JSON is upgraded automatically at database initialization without changing identifier values. HR must review legacy codes and replace them with actual national IDs. Historical audit payloads remain unchanged. The internal SQLite `code` column retains its unique constraint and now stores the national ID.

## Work Schedules and Settings

- `GET /schedules`: authenticated schedule list.
- `POST /schedules` and `PATCH /schedules/:id`: administrator only.
- `PATCH /settings`: administrator only; `{ "name": "Company name", "timezone": "Africa/Cairo" }`. The timezone must be an IANA timezone supported by the server.

Schedule body:

```json
{
  "name": "Standard workweek",
  "start": "10:00",
  "end": "18:00",
  "days": [0, 1, 2, 3, 4],
  "graceMinutes": 15
}
```

Days are Sunday=0 through Saturday=6. Start/end use 24-hour local company time. End before start represents an overnight shift. Existing attendance keeps its original schedule and timezone snapshot.

## Employee Attendance (Future Flutter Client)

The signed-in account must be associated with an active employee. The employee identity comes from the session, never from an employee ID supplied by the client.

- `GET /attendance/me`: `{ "employee": {...}, "schedule": {...}, "workDate": "YYYY-MM-DD", "records": [...] }`. Returns the latest 93 recorded intervals, newest first. Records include their calculated status.
- `GET /attendance/policy`: authenticated office coordinates, radius, capture age, accuracy limit, and photo limits.
- `POST /attendance/check-in`: multipart evidence described below. Returns the created or existing attendance record. The backend supplies its timestamp.
- `POST /attendance/:id/check-out`: multipart evidence. Closes an owned record; repeats return the original check-out without replacing evidence.
- `GET /attendance/:id/evidence`: evidence metadata and authenticated relative photo URLs. Available to the record owner and HR/admin.
- `GET /attendance/:id/photos/:event`: private JPEG; event is `check-in` or `check-out`. Same access rules; missing evidence and other employees' records return 404.

Both POST endpoints require `multipart/form-data` with exactly four text fields: `latitude`, `longitude`, `accuracyMeters`, and `capturedAt` (ISO 8601 with UTC or an explicit offset), plus one binary `photo` file. Do not set the multipart Content-Type manually; let the client supply the boundary.

Technical defaults: GPS accuracy must be positive and at most 50 metres; capture age must be at most 120 seconds, with 10 seconds allowed for future clock skew. The measured position must be within 50 metres; accuracy does not expand the radius. Photos must be non-animated JPEG/PNG, at most 5 MiB and 20 megapixels. The server decodes and normalizes them to JPEG at most 1280 pixels per dimension, removing EXIF. Invalid or missing evidence returns 400, an outside-office position returns 403, and oversized multipart uploads return 413. Failed submissions do not change attendance.

Evidence and photos are stored privately in SQLite with the attendance transaction. HR's reason-required, audited manual entries and corrections remain an explicit exception; historical/manual records may have no evidence. Retention duration still needs company approval. The later Flutter app must capture current GPS and a fresh camera image for each event. Client coordinates and capture time are not proof against spoofing; the backend checks image validity, not whether its scene actually depicts the office.

Attendance record:

```json
{
  "id": "attendance-uuid",
  "employeeId": "employee-uuid",
  "workDate": "2026-10-04",
  "checkIn": "2026-10-04T06:00:00.000Z",
  "checkOut": null,
  "schedule": { "id": "schedule-uuid", "name": "Standard workweek", "start": "10:00", "end": "18:00", "days": [0, 1, 2, 3, 4], "graceMinutes": 15 },
  "timezone": "Africa/Cairo"
}
```

Do not display a success state before the API responds successfully. If a response is lost, repeat with valid recent evidence or fetch `/attendance/me` to reconcile. Retries preserve the original timestamp and evidence. A previous workday left open causes check-in to return 409 and needs HR review. Network failures do not queue offline submissions in this phase.

## Employee Requests and HR Decisions

### Request list pagination

`GET /requests`, `GET /requests/me`, and `GET /requests/managed` return arrays ordered newest first. Each response defaults to 50 items. Use `limit` (integer 1–100), optional `status` (`pending`, `approved`, `rejected`, `withdrawn`), and optional `before` (the last request UUID from the previous page). Example: `/requests/me?limit=50&status=pending&before=<last-id>`. Keep the same filters while paging. A page shorter than `limit` ends the list; a full page may require one more read to determine the end. An unknown or deleted cursor returns an empty page. Unknown query fields and invalid values return 400.

Filters and authorization are applied before the limit. Managed lists contain only current direct reports' pending requests; other status filters return an empty array. Refresh from the first page after mutations or assignment changes. New submissions do not shift existing cursors, but live status/assignment changes can alter later pages; this is not a frozen snapshot. Clients must follow cursors to retrieve complete history. Dashboard reports fetch all pages; page-level counts and deduction sums are labeled accordingly. Internal payroll calculation still uses the complete request set.


- `POST /requests`: submits a pending request for the authenticated active employee. Employee identity is always session-derived.
  Vacation requests use `type: "leave"`. New leave and personal holiday decisions record `salaryDeductionDays`: 1 for approval or 3 for rejection, once per request regardless of its date range. Pending requests, historical decisions, and forgotten check-out requests have `null`. This field is server-managed and stored atomically with the final decision and audit; repeated decisions return 409. The payroll preview converts these days into monetary deductions. Existing decided requests are not charged retroactively.
- `GET /requests/me`: only the employee's own requests, newest first, including HR decisions.
- `GET /requests`: HR/admin queue, newest first, including all statuses.
- `PATCH /requests/:id/decision`: HR/admin only; `{ "status": "approved", "reason": "Departure confirmed by HR" }`. Status may also be `rejected`.

Time-off body (holiday means personal time off, not a company-wide holiday):

```json
{ "type": "leave", "from": "2026-10-04", "to": "2026-10-05", "reason": "Family appointment" }
```

Use `type: "holiday"` for a personal holiday. Date ranges are inclusive, ordered, at most 93 days, and cannot begin before employment. Pending/approved time-off ranges cannot overlap, including across request types. Rejected requests allow resubmission.

Forgotten check-out body:

```json
{ "type": "forgotten-check-out", "attendanceId": "attendance-uuid", "proposedCheckOut": "2026-10-04T15:00:00Z", "reason": "Forgot to check out when leaving" }
```

The record must be owned and open. Proposed departure must be in the past and at or after recorded check-in. Only one pending/approved request per attendance record is allowed. The response includes an attendance snapshot for HR review; approval validates the current record again. If another process already closed it, approval returns 409 and the request stays pending for HR to reject.

Request and decision reasons require 5-500 characters. Responses include `id`, employee identity/name/code snapshot, submitted fields, `status`, `submittedAt`, `decidedAt`, `decidedBy` (reviewer name), `decisionReason`, and `attendance` (snapshot or null). HR/admin cannot decide their own request. Decisions are final; repeats return 409. Approval for inactive employees returns 409. Invalid bodies return 400; missing/non-owned attendance returns 404; access violations return 403.

Approved leave/holiday affects missing scheduled report rows (`Approved leave`, `Approved holiday`), not weekends or existing attendance. Forgotten check-out approval closes attendance through an audited HR correction, with no fabricated GPS/photo. Approval, correction, and audit are one transaction. Rejection changes no attendance. Editing/cancellation, leave balances, notifications, and company-wide holiday calendars are outside this release.

## HR Attendance Review

HR/admin access is required.

- `GET /attendance`: report rows with national ID/name/department, workday, times, hours, status, and record timezone. Missing scheduled records have `id: null` and status No record.
- `GET /attendance/export`: CSV using the same filters. Export timestamps are UTC, and a separate timezone column is included. Potential spreadsheet formula prefixes in text fields are escaped.

Query parameters: `from`, `to` (YYYY-MM-DD), optional `employeeId`, `department`, and `status`. Dates default to today in the company timezone. Range limit: 93 calendar days. Status values: `On time`, `Late`, `Missing check-out`, `No record`, `Not scheduled`, `Approved leave`, `Approved holiday`.

Report rows also include a `late` boolean independent of their status, so a missing check-out does not hide a late arrival from dashboard totals.

- `PATCH /attendance/:id`: corrects an existing attendance record.
- `POST /attendance`: manually records missing attendance. Requires the correction fields plus `employeeId` and `workDate`. Returns 409 if that workday already has a record.

Correction body:

```json
{
  "checkIn": "2026-10-04T06:00:00Z",
  "checkOut": "2026-10-04T14:00:00Z",
  "reason": "Confirmed departure time with employee"
}
```

Timestamps must be ISO 8601 with UTC or an explicit offset, must not be in the future, and must keep check-out at or after check-in. Check-in must belong to the original scheduled workday. Set checkOut to null to leave the interval open, subject to the one-open-interval rule. Reasons require 5-500 characters.

- `GET /audit`: latest 100 administrative changes. Optional `recordId` restricts results to a specific UUID. Entries include actor, action, timestamp, reason, and before/after values. Credentials and tokens are not recorded in audit payloads.

## Errors

Errors follow NestJS JSON responses with `statusCode`, `message`, and where applicable `error`.

| Status | Meaning |
| --- | --- |
| 400 | Invalid input, schedule, time, or missing employee association |
| 401 | Invalid credentials, missing/expired session, or inactive account |
| 403 | Role or browser-origin restriction |
| 404 | Record not found or attendance record not owned by the caller |
| 409 | Duplicate employee, existing attendance, or another open interval |
| 429 | Five failed logins; wait for the 15-minute lockout to expire |

POST responses use status 201; GET and PATCH responses use status 200. UUID values shown in examples are descriptive placeholders; use actual IDs returned by the API.

## Departments

HR/admin can use `GET /api/departments` to list `{ name }` objects and `POST /api/departments` with `{ "name": "Operations" }` to create a department before assigning employees. Names are trimmed, required, 1-120 characters, and unique without regard to case. Creation returns 201 and records an audit event; duplicates return 409, invalid bodies 400, employee access 403.

Existing employee departments are imported at startup. Assign or move an employee through the existing employee POST/PATCH `department` string field. The dashboard uses the saved department list as a selector. Existing API integrations may still submit a new department name through employee saving; it is registered atomically and capitalization is normalized to the saved name. Departments remain available after all employees move away. No department rename/delete endpoint is provided.

### Manual deduction report feed

`GET /api/payroll/deductions?from=YYYY-MM-DD&to=YYYY-MM-DD` is HR/admin only. Both dates are required, inclusive, ordered, and limited to 93 calendar days. Returns manual deduction objects (including days, employeeId, approvedBy, recordedAt and payroll month) recorded during that date range in company timezone. Filtering uses recording date regardless of the assigned payroll month. Invalid ranges return 400; employee access returns 403. Management reports combine this feed with request decision deductions.

### Monthly Excuse allowance

Each employee may reserve/use at most **240 minutes (4 hours)** through at most **3 Excuse requests per calendar month**. Pending and approved requests count together; rejected requests release the allowance. Months are determined by requested dates, not submission or decision dates. `durationMinutes` is charged for every calendar date in the inclusive range. A request spanning months counts once toward each affected month's request limit, with minutes split by dates. Exactly 240 minutes and 3 requests are permitted; attempts to exceed either return 409 without creating a request. Approval rechecks the limits while excluding the request itself. All excuse subtypes share one allowance; other request types are unaffected. Existing stored requests are preserved, but further submissions/approvals must meet the limits. The existing salary deduction policy is unchanged.


### Request withdrawal and correction

- `PATCH /api/requests/:id/withdraw`: an authenticated employee can withdraw their own pending request. Body: `{ "reason": "No longer needed" }`.
- `PATCH /api/requests/:id/reopen`: HR/admin can reopen another employee's approved time-off request for correction. Body: `{ "reason": "Dates need correction" }`. Approved forgotten check-outs must use the attendance correction API instead.
- Both require a UUID request ID and a trimmed reason of 5–500 characters; extra body fields are rejected. Invalid input returns 400, forbidden actions 403, missing requests 404, and invalid state transitions 409.
- Withdrawal sets `status` to `withdrawn`, carries no salary deduction, and releases date overlap and monthly Excuse reservations. Withdrawn requests remain visible in history and cannot be decided or reopened.
- Reopening returns a request to `pending`, clears its decision and deduction, and removes its approved attendance-report effect. Its Excuse reservation remains. HR can make a new decision; the employee can withdraw and submit a replacement to correct its details. Rejected requests remain final.
- Responses may include `lastChange` with `action` (`withdraw` or `reopen`), `reason`, `at` (ISO timestamp), and `by` (actor name). Both actions record before/after values in the audit trail. Preserve all four statuses in mobile filters and history; show withdrawal only on the employee's pending requests.
- Draft payroll and newly generated management reports reflect the current request state. Approved payroll stays frozen, and requests included in it cannot be reopened. Previously exported files or bank transfers are not reversed by reopening.


### In-app notifications

- `GET /api/notifications` (authenticated): returns `{ "items": [...], "unreadCount": 2 }`. Each item has `id`, `type`, `title`, `message`, `createdAt`, `readAt` (null when unread), and either `requestId` or `attendanceId`.
- `PATCH /api/notifications/:id/read` (authenticated, no payload required): marks an accessible notification read and returns that item. URL-encode the notification ID because IDs are opaque strings, not always UUIDs. Marking read again preserves its original read timestamp. IDs must be 1–200 characters; unavailable or another user's notification returns 404. Unauthenticated calls return 401.
- Employees see their own request approvals, rejections, and reopenings, including the decision reason and deciding HR name. The inbox retains the latest 100 such events. HR users linked to an employee also receive their own decision notifications.
- HR/admin also see every currently pending request they can review (their own requests excluded) and every open attendance record whose recorded shift has ended. Missing check-out timing uses the attendance record's saved shift and timezone, including overnight shifts. The timestamp on a missing check-out item is its original check-in; its message includes the workday.
- Pending and missing check-out alerts disappear when resolved. Reopening creates a new pending notification, even if an earlier alert was read. Read state is saved per user and survives sign-out/restart; one HR user's read action does not mark another HR user's notification read.
- The web app has a notification bell, unread counter, unread filter, and per-item mark-as-read controls. HR can open the Requests or Attendance section from an alert. It refreshes every 30 seconds while visible and on returning to the app.
- Mobile: fetch after sign-in and on returning to the foreground, refresh periodically while active, display unreadCount on the bell, and route by requestId/attendanceId after checking the current record. Preserve opaque IDs and refresh after decisions or corrections. Handle 404 on read gracefully when a live HR alert has already been resolved.
- These are in-app/API notifications. Background mobile push, email, and SMS delivery are not configured.


### Direct manager review before HR

HR/admin creates an employee with role `manager`, then assigns each employee one `managerId` in the Employees section. A department can have multiple managers. Managers can view direct reports' attendance and sales performance without HR or payroll access. `GET /api/employees/reports` returns basic details for the signed-in manager's direct reports.

On first startup after upgrading, existing department assignments are converted to direct assignments for currently unassigned employees in that department. Assigned employee-role managers become manager-role accounts and their sessions are revoked; existing HR/admin roles are preserved. The legacy department manager table is removed after conversion.

- `POST /api/employees` and `PATCH /api/employees/:id` accept `role: "manager"` and optional `managerId: UUID | null`. The assigned manager must be active and have the manager role. Self-assignment is rejected. Deactivating or demoting a manager clears direct-report assignments.
- `GET /api/requests/managed` (authenticated): returns pending requests from current direct reports, including recommendations already awaiting HR. A manager's own requests are excluded, and final or withdrawn requests leave this queue.
- `PATCH /api/requests/:id/manager-review` (assigned manager): UUID request ID and strict body `{ "status": "approved", "reason": "Coverage is arranged" }`. Status is `approved` or `rejected`; trimmed reason must be 5–500 characters. Only the current direct manager may review another employee's request. Wrong manager/self-review returns 403; a repeated review or non-pending request returns 409.
- Responses expose `managerStage` (`not-required`, `pending`, `approved`, or `rejected`), `managerEmployeeId`, and `managerDepartment` on pending requests. `managerReview` is null or an object containing `status`, `employeeId` (reviewer), `department`, `reviewedBy`, `reviewedAt`, and `reason`. Final decisions preserve the review recorded at that time; older historical records may omit these fields.
- Manager approval/rejection is a recommendation. The overall request remains `pending`, with no salary deduction or attendance changes. HR must wait for manager review before either final approval or final rejection (`PATCH /api/requests/:id/decision` returns 409 while managerStage is pending). HR gives the final decision with its own reason and may disagree with the recommendation. A user who supplied the manager recommendation cannot also give that request's final HR decision.
- Requests without a direct manager, and a manager's own requests, go directly to HR. This applies to all request types, including Excuse and forgotten check-out. Existing pending requests use the current assignment; existing final decisions remain unchanged.
- Reopening an approval clears its manager recommendation and requires a fresh review if a manager is assigned. Changing the direct manager or the requester's department invalidates a pending request's old recommendation; previous reviews remain in audit history. Removing the assignment routes pending requests directly to HR.
- Pending Excuse requests still reserve their monthly hours/request count while waiting for either stage. A manager rejection does not release the allowance; employee withdrawal or final HR rejection does. Only final HR approval/rejection applies the existing 1-day/3-day salary rule.
- Notifications route `manager-review-required` alerts to the assigned manager, `pending-request` alerts to HR after review (or directly when no review is required), and `manager-reviewed` history events to the requesting employee. Mobile must distinguish these review stages from the overall request status, route manager alerts to the managed queue, and show final-decision controls only to HR after review.
- The web manager workspace includes direct report requests, attendance, and sales performance. Request details show the recommendation, reason, reviewer, and time. All assignments, manager reviews, and final decisions are audited.


### Payroll approval and locking

HR/admin can approve and permanently lock a current or past month's payroll from the Payroll section. The approval saves the reviewed employee roster, names/numbers, departments, active flags, currencies, gross salaries, daily rates, deduction days and amounts, net salaries, request deduction breakdowns, and manual deductions with their reasons/approvers/recorders. Company name and timezone are also saved. Employee or company edits after approval affect draft months and do not recalculate approved payroll.

- `GET /api/payroll/run?month=YYYY-MM` (HR/admin) returns `{ month, status, company, timezone, revision, approvedAt, approvedBy, approvedById, approvalReason, rows }`. Status is `draft` or `approved`. Approval fields are null for a draft. `rows` has the existing payroll row shape. `revision` is an opaque 64-character lowercase hexadecimal value representing the reviewed amounts and context.
- `POST /api/payroll/approve` (HR/admin) takes a strict JSON body containing `month`, `expectedRevision` (the revision returned by the reviewed run), and a trimmed `reason` of 5–500 characters. It returns the approved run with HTTP 201. All employee salaries in the run must be configured, and the run must contain employees. Zero salary is valid. Future months cannot be approved (400); missing salaries, empty payroll, an already locked month, or changed reviewed data return 409. Invalid body/month/revision returns 400; employee access is 403; unauthenticated access is 401.
- Approval recalculates and compares the reviewed revision inside the same database transaction that stores the snapshot and `payroll.approved` audit event. If anything changed, refresh and review the new payroll before submitting again. A failed audit rolls back the approval. A second approval cannot replace an existing snapshot. There is no unlock/reapproval endpoint.
- `GET /api/payroll?month=YYYY-MM` remains compatible: it returns the saved employee rows for an approved month and live rows for a draft month. Consumers that need approval status should use `/api/payroll/run`. Approved snapshots and locks survive application restarts.
- `POST /api/payroll/deductions` rejects a locked target month with 409. Final HR decisions that would create a salary deduction in an already locked decision month also return 409; the request stays pending. Manager review, employee withdrawal of pending requests, and attendance corrections without salary deductions remain available.
- Reopening a request whose deduction is included in any approved snapshot returns 409, even if company timezone/settings later change. Apply payroll adjustments to an unlocked month using the existing manual deduction flow. A later final request decision can be made once its decision month is unlocked; decisions are not silently redirected to another month.
- `GET /api/audit?recordId=YYYY-MM` can retrieve the payroll approval audit; UUID record filters remain supported. Approval records include the approver, reason, time, reviewed draft, and saved snapshot.
- Mobile/admin clients should show draft/approved state, approval metadata, and locked monetary values from the saved rows. Hide or disable deduction actions on locked runs. Send the exact reviewed revision for approval, and refresh on 409. Future bank salary-file generation must use the approved snapshot instead of calculating salaries from current employee records.
- Approval freezes the payroll calculation; it does not send a bank file or transfer money. The existing salary/30 calculation and request deduction rules are unchanged.

## Effective-dated schedule assignments

- Employee create/update accepts optional `scheduleEffectiveFrom` (`YYYY-MM-DD`). Creation assigns `scheduleId` from `startDate`; an explicit effective date on creation must equal `startDate`.
- On update, a changed `scheduleId` without an effective date starts today in company timezone. An explicit date writes an assignment even if the schedule ID matches today's assignment. Dates before today or employment return 400. The same employee/date replaces that assignment, preserving the change in audit history. Later assignments remain in place; unrelated employee edits leave the timeline unchanged.
- `GET /api/employees/:id/schedules` (HR/admin) returns ascending `{ effectiveFrom, schedule }[]`, where `schedule` is the definition effective at that assignment's start. Invalid UUID returns 400, missing employee 404, employee access 403. Later shared-definition edits can occur within an assignment; those are recorded in the schedule audit history.
- Employee responses return the schedule ID effective on today's company calendar date (or the initial assignment for a not-yet-started employee), not a future scheduled ID. `/attendance/me` returns the schedule effective on its backend `workDate`, which can differ from the calendar-date assignment during overnight transitions.
- Shared `PATCH /api/schedules/:id` edits take effect today in company timezone; prior definitions are retained. Multiple edits on the same date replace that day's definition and remain audited. Attendance already recorded retains its snapshot. Historical missing-record reports and manual entries select the assignment/definition effective on the requested workday.
- Schedule-assignment writes and audits commit atomically; audit failure rolls back the write. Existing employees/schedules are backfilled once from their current stored values, without inventing earlier changes. Moving employment start later than a retained assignment returns 400.
- Excuse submission validates `shiftId` and duration against every requested date's effective assignment/definition. A range crossing different schedule IDs must be split; incorrect shift or excessive duration returns 400.

## Real estate sales activities

Sales is implemented by `src/sales/` and covered by `test/sales.e2e-spec.ts`. Read [../MOBILE-SALES.md](../MOBILE-SALES.md) for exact employee activity bodies, statuses, responses, concurrency rules and manager mobile integration. All endpoints require authentication.

- Employee create/update accepts optional boolean `salesEnabled`. Omission preserves an existing setting; new/legacy employees default false. Read responses include the current boolean. HR/admin controls this flag; account role/department alone does not enable personal submission.
- `GET /api/sales/access`: `{ canSubmit, canReview, canSetTargets }`. Personal submission requires an active sales-enabled profile. Review access is HR/admin or a manager with direct reports; targets are HR/admin only. Current per-record `canReview` also excludes self-review.
- `GET /api/sales/activities/me?month=YYYY-MM`: own history. `GET /api/sales/activities?month=YYYY-MM`: HR/admin all or direct-report team scope (manager's own entries excluded). Optional `employeeId`, `department`, `kind`, `status` filters; filters never expand scope. `GET /api/sales/activities/:id` returns accessible current detail; missing/inaccessible is 404.
- `POST /api/sales/activities`: strict `{ id: UUID, activity: ActivityInput }`, HTTP 201. ID is generated by the client for safe retries. Kind is `meeting`, `viewing` or `closed-deal`. Activity date is employment start through company today; pending entry owner/server timestamps/revision are generated by the server. Identical ID/payload replay returns the existing record; reused ID with different owner/data or duplicate trimmed case-insensitive contract reference is 409.
- `PATCH /api/sales/activities/:id`: strict `{ expectedRevision: positive integer, activity: ActivityInput }`. Only the owner with current sales submission access may edit pending/returned entries. Complete replacement payload; result becomes pending, revision increments, initial submission time/previous review remain. Verified/stale entries return 409. Inaccessible ownership returns 404.
- `PATCH /api/sales/activities/:id/review`: strict `{ expectedRevision, status: verified|returned, reason: 5–500 trimmed characters }`. Current direct manager or HR/admin, never self. Pending entries can be verified; pending/verified entries can be returned for correction. A return removes verified contributions immediately; owner resubmission requires fresh verification. Wrong reviewer 403; stale/invalid transition 409. Reviews preserve actor/reason/time and full audit history.
- `GET /api/sales/performance/me?month=YYYY-MM`: own summary array; only month query allowed. `GET /api/sales/performance?month=YYYY-MM`: reviewer scope with optional employee/department filter. Rows contain verified meeting/viewing/deal counts, sale/lease counts, per-currency transaction values, pending/returned counts, target and separate achievement percentages. Month follows activity date, not decision date. Missing/zero count targets produce null achievement. Contract value is not company revenue/commission; no combined score or currency conversion is used.
- `POST /api/sales/targets` (HR/admin), strict `{ employeeId, month, meetings, deals, transactionValue, currency, expectedRevision, reason }`, HTTP 201. Employee must be active and sales-enabled; month cannot precede employment month. Count targets are integers 0–10000. Monetary target/currency must both be null or both set; amount positive <= 1,000,000,000 with at most 2 decimals, currency 3 uppercase letters. Expected revision is 0 for a new target, then the returned revision for edits. Stale target 409. Each write increments revision and audits actor/reason/time.
- `GET /api/sales/export?month=YYYY-MM` with optional employee/department filter exports authorized monthly performance CSV. Columns include verified counts, contract values explicitly separated by currency, targets, independent achievement, pending and returned totals. User text is CSV/formula escaped; response is private/no-store. Ordinary employees cannot export team data.

Managers' permissions follow current direct assignments, including removal; verified historical reviews remain recorded. Current employee departments are used for reporting. Summaries are live, and later corrections/target edits affect regenerated reports. Each contract has one activity owner; sharing agent credit, booking/pipeline stages, commissions, contract attachments, and contract-cancellation accounting are outside this addition. Sales records do not alter attendance/payroll. New tables are created automatically on startup; records/targets survive restart. No mobile project exists in this workspace; backend verification does not imply Flutter completion.
