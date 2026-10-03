# HR REST API

Confirmed policy: standard hours are 10:00-18:00 and sales hours are 11:00-19:00, Sunday-Thursday with a 15-minute grace period; check-out is mandatory. Both employee attendance endpoints enforce location and photo evidence at latitude 30.023092, longitude 31.528179, within 100 metres. Employee request APIs and HR dashboard review are implemented; Flutter screens are deferred.

Base URL for this workspace: `http://127.0.0.1:3002/api`.

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
- `POST /employees`: creates the profile and account together.
- `PATCH /employees/:id`: replaces editable profile fields; an optional password resets account access. Omit password to retain it.

Employee body:

```json
{
  "employeeCode": "EMP-001",
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

Roles: `employee`, `hr`, `admin`. Only administrators can create or edit HR/admin accounts or assign privileged roles. Employee code and account email are unique, ignoring case. Deactivation keeps historical attendance and immediately invalidates active sessions. Users cannot change their own role or deactivate their own employee account.

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

Technical defaults: GPS accuracy must be positive and at most 50 metres; capture age must be at most 120 seconds, with 10 seconds allowed for future clock skew. The measured position must be within 100 metres; accuracy does not expand the radius. Photos must be non-animated JPEG/PNG, at most 5 MiB and 20 megapixels. The server decodes and normalizes them to JPEG at most 1600 pixels per dimension, removing EXIF. Invalid or missing evidence returns 400, an outside-office position returns 403, and oversized multipart uploads return 413. Failed submissions do not change attendance.

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

- `POST /requests`: submits a pending request for the authenticated active employee. Employee identity is always session-derived.
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

- `GET /attendance`: report rows with employee code/name/department, workday, times, hours, status, and record timezone. Missing scheduled records have `id: null` and status No record.
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
