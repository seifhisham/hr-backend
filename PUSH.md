# Hodour Android push

Android application: `com.wsc.hodour`. Firebase target: `wsc-hr-ebe11`.
Push uses **FCM registration tokens**, not Firebase Installation IDs (FIDs).
No mobile code or iOS support is included in this change.

## API contract

All paths below include `/api`. Use the current `Authorization: Bearer <session token>`;
the existing HttpOnly session cookie also works. Authentication, origin checks,
company availability checks and session revalidation are the same as other REST routes.
Company and user come exclusively from the server session. These personal endpoints
are available to employees, managers, HR and company administrators.

`POST /api/push/devices` accepts JSON, with **exactly** these fields:

```json
{
  "deviceId": "9bf3c18f-91f7-4e1a-bb4c-eacb44c9b269",
  "token": "<FCM registration token from FirebaseMessaging.getToken()>",
  "platform": "android"
}
```

| Field | Validation |
| --- | --- |
| `deviceId` | UUID generated randomly by the client once per app installation; persist it across logins and token rotations. Not a FID, account ID or hardware identifier. |
| `token` | String, 20–4096 characters, no whitespace. Send the complete registration token unchanged. |
| `platform` | Literal string `android`. |

Success: **200**, including an identical repeated registration:

```json
{"deviceId":"9bf3c18f-91f7-4e1a-bb4c-eacb44c9b269","platform":"android"}
```

No token or binding belonging to another account is returned. Each installation and
each token has at most one active binding globally. Registering transfers that
installation/token to the authenticated company, account and session. Other devices
remain registered. An identical request preserves its binding and registration time;
token rotation replaces the token and updates `updated_at`. Session/account/company
changes create a new binding generation. Account transfers reset `registered_at`.
Possession of an installation ID alone does not allow reading its token. Clients must
serialize registration for an installation: a delayed old-account **registration** is
still an authenticated transfer and must never be replayed after switching accounts.

`DELETE /api/push/devices/:deviceId`: UUID path parameter, no body.
Success: **204**, empty body, including an unknown installation or a binding that
belongs to another session/account/company. Deletes only a binding matching the current
company, user **and session hash**. A delayed DELETE or logout from an older session
cannot delete the newer binding, including a newer session for the same user.

Both routes share the existing per-process rate limiter: **30 requests/account/company
per 60 seconds**, across sessions and devices. Its existing limitation applies: counters
reset on restart and are not shared across replicas.

| HTTP | Meaning |
| --- | --- |
| 400 | Missing/unknown body fields, invalid UUID/token/platform or invalid DELETE UUID; standard Zod validation message. |
| 401 | Missing, expired, revoked or invalid session; `Please sign in`. |
| 403 | Existing origin/cross-site checks reject the request, or identity/grants changed during the request. |
| 429 | Rate limit exceeded; `Retry-After` response header gives seconds to wait. |
| 503 | Company access became unavailable during a request. A company already unavailable at authentication returns 401. |
| 500 | Unexpected database/server failure; retry later without discarding the FCM token. |

Errors use the existing Nest response shape:
`{"statusCode":400,"message":"platform: Invalid input: expected ...","error":"Bad Request"}`.
Validation message details vary by field; clients should use the HTTP status rather
than parse message text. Registration does not contact Firebase, so Firebase outages
do not change these endpoint responses. There is no public send endpoint.

## Credentials and configuration

| Variable | Value / requirement |
| --- | --- |
| `HR_PUSH_ENABLED` | `true` to initialize the sender and start its ten-second worker; defaults to disabled. Registration remains available while disabled. |
| `HR_FIREBASE_PROJECT_ID` | Required when enabled; must be `wsc-hr-ebe11`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional ADC configuration-file path for local development or a mounted production secret; never the JSON contents. Not needed with an attached workload identity. |
| `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT` | If supplied when enabled, each must match `wsc-hr-ebe11`. |
| `HR_PG_URL` | Existing restricted runtime PostgreSQL connection. |
| `HR_PG_MIGRATION_URL` | Existing privileged migration connection, only in migration tooling. |

The named Firebase Admin app is initialized once with `applicationDefault()` and an
explicit project ID. Conflicting target configuration fails startup. Credentials must
have permission to send to the target project; a service account can live in another
project if granted target-project IAM permissions. Pinning the target does not prove
credentials have those permissions: verify with the controlled delivery test below.
`FIREBASE_CONFIG` is not used for the sender's target or credentials.

Enable the Firebase Cloud Messaging API (HTTP v1) in `wsc-hr-ebe11`. Give the server
identity `cloudmessaging.messages.create`, normally through the Firebase Cloud Messaging
API Admin role (`roles/firebasecloudmessaging.admin`) scoped to that project. Do not
grant project Owner/Editor merely to send notifications.

The supplied service-account JSON is stored locally at
`.secrets/hodour-fcm-adc.json` (relative to the project root). That directory and
Firebase Admin SDK key filenames are Git-ignored. The original root-level JSON was
moved there. Backend/frontend build contexts exclude credentials too. Upload the
file separately through your authenticated server transfer; it is deliberately absent
from GitHub and source releases. Do not paste its contents into environment variables.

Local PowerShell example, from `hr-backend`:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = '../.secrets/hodour-fcm-adc.json'
$env:HR_FIREBASE_PROJECT_ID = 'wsc-hr-ebe11'
$env:HR_PUSH_ENABLED = 'true'
npm run start:dev
```

Prefer `gcloud auth application-default login` (or service-account impersonation)
for local ADC without a long-lived key. With user ADC, unset an obsolete
`GOOGLE_APPLICATION_CREDENTIALS` so it does not override the local ADC file. Keep ADC
files in protected storage such as the ignored `.secrets` directory, outside logs,
image build contexts and mobile assets.

In production on Google Cloud, attach a dedicated service account/workload identity
and use ADC; no embedded key or legacy server key. Off Google Cloud, prefer Workload
Identity Federation with an ADC external-account configuration mounted read-only. If
a service-account key is unavoidable, mount it as a read-only deployment secret outside
the image and rotate it through the platform secret manager.

For this project's production Compose deployment:

1. Upload the credential separately to `/srv/hr-system/.secrets/hodour-fcm-adc.json`.
   Preserve the existing database/encryption secrets in that directory. Keep the
   directory root-owned with mode `700`. Local Compose file-backed secrets retain
   host file permissions: make this one file root-owned with mode `444` so the
   container's unprivileged `node` user can read the mount. The parent directory's
   `700` permissions prevent other host users from accessing it.
2. Complete migration 6 using the normal deployment procedure before starting the backend.
3. Add the supplied `compose.push.yaml` overlay when creating/recreating the backend:

```bash
cd /srv/hr-system
chown root:root .secrets .secrets/hodour-fcm-adc.json
chmod 700 .secrets
chmod 444 .secrets/hodour-fcm-adc.json
dc() { docker compose --env-file production.env -f compose.production.yaml -f compose.push.yaml "$@"; }
dc config --quiet
dc up -d --build --wait backend
```

Use that same `dc` definition for subsequent production commands. The overlay enables
push, pins `wsc-hr-ebe11`, and sets `GOOGLE_APPLICATION_CREDENTIALS` to
`/run/secrets/hodour_firebase_adc`. Only the backend receives the read-only credential
mount. The file is never copied into an image or mounted into the frontend. The
existing privileged maintenance `tools` service mounts `.secrets` and can also access
this file; it is not part of normal application startup.
The base deployment continues to work without a Firebase credential when the overlay
is omitted. Local `.env` paths and server/container paths intentionally differ.

Official references: [Admin SDK / ADC setup](https://firebase.google.com/docs/admin/setup),
[FCM server authorization](https://firebase.google.com/docs/cloud-messaging/auth-server),
[FCM errors and retry guidance](https://firebase.google.com/docs/cloud-messaging/error-codes).

## Deployment and durability

1. Install locked dependencies (`npm ci`) and build (`npm run build`).
2. Back up PostgreSQL using the existing deployment procedure. Stop old backend
   instances for the schema/application upgrade; they enforce the previous schema version.
3. Run `npm run pg:migrate` with **only the intended deployment's** migration URL.
   Migration **6**, `android_push_delivery`, adds `push_devices`, `push_events`,
   `push_deliveries` and the narrow authenticated `hr_register_push` function. Earlier
   migrations/checksums are unchanged. No SQLite migration or automatic startup DDL.
4. Existing `hr_runtime` roles receive the new grants from migration 6. The
   `pg:runtime-role` command includes them for fresh deployments. For a custom runtime
   role, grant SELECT/INSERT/UPDATE/DELETE on the three new tables and EXECUTE on
   `hr_register_push(text,uuid,text)` using privileged migration tooling. Never use a
   privileged role in `HR_PG_URL`. Public execution is revoked; table RLS is forced.
5. Deploy the matching backend. Keep push disabled until credentials are ready, then
   enable it and restart. Registration tokens are not logged. Monitor sanitized
   `Push delivery sent/pending/failed/cancelled` outcomes and pending/failed queue counts.

The existing inbox is computed from committed audit records, pending request state
and attendance records. The worker calls that **same** `NotificationsService.list`
under each recipient's actual live session and branch grants. Request notifications
include manager-review-required, manager-reviewed, request-decided,
request-reopened, pending-request and missing-check-out retain their existing rules.
Direct managers also receive `employee-checked-in` and `employee-checked-out` inbox
events and pushes from committed attendance check-in/check-out audits, including
automatic check-outs. HR corrections and manual entries do not produce these alerts.
The recipient must be the employee's current direct manager, with an active
manager/HR/admin profile; HR branch grants still apply. The latest 100 eligible
attendance audit events are included, with stable audit IDs and normal read tracking.
Reassignment removes the former manager's eligibility and exposes that history to
the new manager. Push text stays generic; employee names appear only in the inbox.
No HR workflow calls Firebase, and an HR commit never depends on successful push.

Every ten seconds, active companies/devices are scanned. Unread currently eligible
inbox items are persisted as minimal `push_events`, and deliveries are inserted in the
same transaction. The key is company + notification ID + recipient + installation ID.
Existing durable inbox sources can be scanned again after a crash before enqueue;
pending deliveries survive a crash after enqueue. The ten-second scan can skip
short-lived pending alerts that have already resolved; they are deliberately ineligible
for delivery then. Decision/review audits remain available according to the inbox's
existing 100-event history window. Enabling push or registering a new installation
also catches up currently unread eligible inbox items. This is a projection-based
outbox, not a new independent HR event/inbox system.

Before **each attempt**, the worker rechecks the current live session, company, user,
installation binding, unread state and the entire canonical inbox eligibility rule.
A rotated token or restored session for the same recipient uses its current binding;
an installation transferred to another recipient cancels the old delivery. Session
deletion cascades device removal, covering logout, password changes, account disabling
and owner-level company session revocation. Expired sessions are never used to send.
Logging out one session preserves devices bound to other sessions. Native installations
should each create their own login session rather than share one bearer token.

Workers atomically lease up to 20 deliveries/company per sweep, one at a time, with
ten-minute recoverable leases and lease-ID fencing. A heartbeat extends a live call's
lease. Multiple backend workers can cooperate through PostgreSQL. No network call
holds the company write transaction open. Six durable attempts maximum; transient
errors use exponential delays of 1, 2, 4, 8, 16 minutes plus up to 30 seconds jitter,
or Firebase's longer `Retry-After` (seconds or HTTP date). The SDK can also perform
its own transport retries within an attempt.

Only explicit invalid/unregistered token codes remove the **matching binding generation**.
Credential, permission, package and payload errors leave the token intact and terminate
that delivery; repair the configuration rather than repeatedly retry the same bad request.
Transient errors retry independently per device. Logs omit raw SDK errors, tokens,
credentials, reasons, names and message contents. `last_code` stores sanitized status.

After repairing a configuration fault, an operator may requeue affected failed rows
using privileged maintenance tooling, scoped to the intended company and failure code:
set `state='pending', attempts=0, next_attempt=now(), lease_id=NULL, lease_until=NULL,
finished_at=NULL`. Do not requeue invalid-token failures. Delivery still rechecks eligibility.
There is no HTTP maintenance/send endpoint. Keep deduplication rows while their inbox
events can be eligible; removing the ledger can resend an unread event. Monitor table
growth and follow the company's database retention/backup policy.

FCM acceptance does **not** guarantee display or exactly-once delivery. A crash after
FCM accepts a message but before the database records success can cause a duplicate.
An account switch/revocation can race an already in-flight send; a submitted alert
cannot be recalled. Generic text and authenticated inbox retrieval limit exposure.
The Android notification tag is the inbox ID, and clients should also deduplicate
foreground local alerts by `notificationId`.

## Mobile integration contract

1. Generate and persist a random UUID `deviceId` for this installation. Obtain the
   FCM **registration token** through the existing flow. Never send a Firebase FID.
2. After successful login **and** after authenticated session restoration, POST the
   current UUID/token/platform with the current bearer token. Repeating POST is safe.
   Registration does not gate login or inbox use. The backend session lasts 12 hours;
   renewed sessions need registration again.
3. On `onTokenRefresh`, persist the latest token and POST it for the authenticated
   account. If signed out, keep it locally and register after the next login.
4. Retry failed registration with bounded exponential backoff and jitter while that
   same session/account is current. Honor 429 `Retry-After`; defer while offline;
   fix 400 inputs; on 401 reauthenticate before registering. Retry on app resume or
   next session restoration if the bounded retry budget is exhausted. Never log tokens
   in release builds. Cancel pending/in-flight old-account registration work before
   an account switch; serialize registrations so a late response cannot restore old state.
5. On logout, DELETE this `deviceId` using the **old current session**, then call the
   existing `/api/auth/logout` with that session. Clear local auth even if offline.
   Session logout revokes its device bindings server-side; if both calls fail offline,
   the server cannot know about local logout until revocation or session expiry.
   Clear any visible private-account alerts locally on logout/account switch.
6. On switching accounts/companies, stop old registration retries, perform old-session
   unregister/logout where possible, authenticate the new account, then POST the same
   installation UUID with the latest registration token. Do not issue old-account POSTs
   afterward. A delayed old DELETE/logout cannot remove the newly registered binding.

Payload: standard `notification: {title, body}` with generic text and string-valued
`data: {notificationId, type}`. Android channel `hodour_push`, restricted package
`com.wsc.hodour`, one-hour FCM TTL. Keep existing foreground local-notification display
and Android background notification display. Request Android notification permission
and create the channel before displaying. Do not display a second background local
alert for the same notification payload. Taps retain the existing authenticate-then-inbox
flow. IDs and type are hints, not authorization or HR detail.

`GET /api/notifications` and `PATCH /api/notifications/:id/read` remain the source of
truth. Fetch after authentication/resume/tap, even if push delivery fails. Console test
pushes still do not create inbox records. No private HR topics are used.

## Safe verification

Automated tests use disposable PostgreSQL databases/roles and mocked Firebase. Set
`HR_PG_TEST_ADMIN_URL` to an **isolated development cluster**, then run:

```powershell
npx vitest run src/push/firebase-sender.spec.ts
npx vitest run --config vitest.config.e2e.ts test/push.e2e-spec.ts
npm run lint
npm run build
```

For a real device test, use an isolated backend database/company with synthetic accounts
and only a consenting test Android device. Enable ADC for the pinned Firebase project.
Register its current token through the authenticated API (avoid putting tokens in shell
history or shared logs). Submit a synthetic request through the normal request API;
confirm the intended manager/HR inbox item exists before expecting its push. Check
foreground local display, background Android display, `hodour_push`, authenticated inbox
navigation, read state, token refresh and logout/account switch. Allow at least one worker
interval. Verify the other company/account gets no alert. Firebase Console alone cannot
exercise inbox/outbox integration. Remove the test binding and sign out afterward.
Do not test by sending to production employee tokens, changing real HR records, logging
credentials, or exposing a send endpoint.
