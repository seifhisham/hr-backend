# Platform owner and company onboarding

Migration 4 adds separate platform accounts, sessions, audit, setup state and invitations. Existing company users and records are unchanged. The owner is not a company administrator and cannot use employee, evidence, attendance, payroll or other company-content APIs with an owner session. Customer administrators cannot use owner APIs.

## Initial owner setup

The first owner is bootstrapped explicitly with migration credentials, never by starting the application. Configure `HR_OWNER_ENCRYPTION_KEY` in the backend environment: 32 cryptographically random bytes encoded as 64 hexadecimal characters. Keep this key stable and back it up privately with the database. It encrypts authenticator secrets and recoverable invitation retry tokens; changing or losing it prevents decrypting existing secrets. No key is sent to the frontend.

For the production Docker stack, complete the database/server setup in the [deployment guide](../docs/operations/PRODUCTION_DEPLOYMENT.md), then run this from the project root in an interactive SSH terminal:

```bash
bash scripts/create-owner.sh
```

This asks for the owner email, confirms the website address, and shows a private setup link. Choose the password and enroll the authenticator in the existing browser setup screen. The owner email/password never go into `.env`; only database credentials and the owner encryption key are configured there. The setup link is deliberately shown only in interactive mode and also saved privately under `.secrets/`. Keep the terminal private.

For scripted/local use, the existing non-interactive CLI remains available. From `hr-backend`, with `HR_PG_MIGRATION_URL` exported and migration 4 already applied:

```powershell
npm run owner:bootstrap -- --email 'owner@example.com' --base-url 'http://localhost:3003' --output 'C:/private/new-owner-setup.json'
```

Use HTTPS except for loopback development. The output directory must be private and the output file must be new. The non-interactive CLI prints no token or password. It writes a setup URL to the private JSON file, expiring in one hour. Open that URL, click **Begin secure setup**, choose a password of at least 8 characters, and scan the displayed QR code with your authenticator. The QR is generated locally in the browser from the server-provided authenticator URI; the manual time-based setup key remains available as a fallback. Confirm its six-digit code and save the ten single-use recovery codes privately. Then wait for the next authenticator code before logging in at `/owner`. No email is sent.

An already enrolled owner cannot be replaced by rerunning bootstrap. Before enrollment, rerunning it for the same email with a new output file replaces the pending link and invalidates the previous link while preserving an already prepared authenticator key. WSC's company administrator remains separate. `HR_BOOTSTRAP_COMPANY_ID` retains its explicit legacy fixture/initialization behavior; it is not the customer onboarding mechanism.

Owner login uses password plus an authenticator code or an unused recovery code. Authenticator codes use [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238) with SHA1, six digits, 30-second steps and at most one adjacent step of clock tolerance. Accepted counters cannot be replayed. Login failures are persisted and limited to five attempts per email per 15 minutes. Setup permits at most ten incorrect codes. Recovery codes are stored as hashes and consumed atomically.

The owner cookie is `hr_owner_session`, HttpOnly, SameSite Strict, scoped to `/api/owner`, Secure in production, with a four-hour session. Existing company authentication keeps its separate cookie/session boundary. All mutations retain the existing origin and cross-site request checks.

## Customer onboarding

1. Open `/owner` and create a company with name, unique company code, shared timezone, first administrator name and email. The request ID makes a network retry safe. The registry entry, company defaults, two standard schedules and an unconfigured first branch are created atomically in `provisioning`. Codes remain reserved after archive.
2. Generate an administrator invitation. Copy and share the private link manually; there is no email integration. It expires after 24 hours. Repeating a request with the same request ID returns the same link; generating a new invitation revokes the previous one. The owner can revoke an unused invitation.
3. The administrator opens the link, chooses a password and confirms their name, then configures the actual first-branch coordinates, attendance/tracking radii, return grace and address. The token determines company, administrator email and role; clients cannot choose them. Acceptance is atomic and single-use, including concurrent submissions.
4. Refresh the owner registry and activate the company. Activation requires a configured branch and active administrator. The customer can now use ordinary company-code login. An existing company that already has an administrator cannot receive this initial-setup invitation.

Setup and invitation tokens are random 256-bit capabilities. Their URLs use fragments; the frontend removes the fragment when starting setup and sends the token in a POST body. Tokens/passwords/secrets do not enter platform audit. Treat invitation links as credentials and close their dialog after sharing. The owner sees company metadata and the latest 100 platform events, not customer employee data.

## Lifecycle and recovery

Allowed transitions: provisioning → active/archive; active → suspended/archive; suspended → active/archive. Archive is terminal in this UI and retains all data. Every lifecycle action requires an audit reason and the expected current status, so stale actions fail with 409. There is no deletion or impersonation endpoint.

Suspension/archive serializes with company writes, revokes company sessions and blocks login, invitations, reads, writes and background processing. Reactivation requires a fresh company login. Open tracking coverage is reset to unavailable on lifecycle changes; attendance timestamps and saved policies are retained. An audit failure rolls back status/session/tracking changes together. Existing company response checks reject queued sensitive results if access changes before delivery.

To replace owner credentials after losing an authenticator, sign in with password and a recovery code. Choose **Reset password / authenticator**, then verify the current password and another unused recovery code (or a fresh authenticator code). Open the resulting 15-minute private setup link. Completing setup replaces password/MFA/recovery codes and revokes all previous owner sessions. Losing every factor requires controlled infrastructure recovery from protected backups; the public API and bootstrap CLI do not bypass enrolled MFA.

## REST contract

All paths below start with `/api`; GET returns 200 and POST returns 201. Bodies are strict JSON. Owner-protected endpoints accept the owner cookie or owner bearer token; normal company sessions are rejected. Public setup/onboarding endpoints require their specific capability token. 400 means validation failure; 401 invalid/expired/revoked credentials or capability; 404 unknown company; 409 conflicting state/request ID/code; 429 login throttling; 503 an operation could not be completed safely. Retry creation/invitation with the same request ID after an uncertain network response.

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/owner/login` | `{email,password,code}` or `{email,password,recoveryCode}`; returns `{owner,token}` and owner cookie |
| GET | `/owner/me` | Owner identity and session expiry; no company profile |
| POST | `/owner/logout` | Revokes current owner session |
| POST | `/owner/setup/prepare` | Public `{token}`; returns email/name, authenticator key and URI |
| POST | `/owner/setup/complete` | Public `{token,name,password,code}`; returns recovery codes once |
| POST | `/owner/recovery` | Owner plus `{password,code}` or `{password,recoveryCode}`; returns private setup path/expiry |
| GET | `/owner/companies` | Company metadata/status/setup state; no employees or passwords |
| POST | `/owner/companies` | `{requestId,workspace,name,timezone,adminEmail,adminName}`; returns `{id}` |
| POST | `/owner/companies/:id/invitation` | `{requestId}`; returns private invitation path/expiry |
| POST | `/owner/companies/:id/revoke-invitation` | `{reason}` |
| POST | `/owner/companies/:id/status` | `{status,expectedStatus,reason}`; returns ID/status |
| GET | `/owner/audit` | Latest 100 platform events, excluding secrets/customer content |
| POST | `/onboarding/preview` | Public `{token}`; invitation's company/admin metadata |
| POST | `/onboarding/accept` | Public `{token,name,password,branchName,policy}`; returns company code/provisioning status |

`policy` contains `address`, `latitude`, `longitude`, `radiusMeters`, `trackingRadiusMeters`, `trackingGraceMinutes`; it follows the [branch contract](BRANCHES.md). New owner/admin-onboarding passwords require 8–128 characters; existing company passwords remain valid. Request IDs/company IDs are UUIDs. Company codes use lowercase letters/digits/hyphens, 2–63 characters; timezones must be valid IANA/Intl identifiers.

## Database access and upgrade

The restricted company runtime role gets execute privileges for `OWNER_FUNCTIONS`, not direct access to platform tables. Functions use a fixed search path, authenticate owner sessions or specific setup/invitation capabilities, and return only the required fields. Owner operations never set a universal company-data bypass. Infrastructure migration credentials remain separate from runtime credentials. For a custom runtime role, grant `OWNER_FUNCTIONS` along with the existing runtime/branch functions.

Preserve migrations 1–3. Back up source/configuration and PostgreSQL, record original-row hashes, restore a backup to a disposable database, apply migration 4 and reconcile every original column/row. Stop writers, take a fresh backup and manifest, apply the explicit migration, configure the owner encryption key, restart, then verify existing WSC login, reports, payroll, files and original SQLite hashes. Keep the key/config backup private. After new company writes, reconcile those writes before any restore of an older database backup.

Tests and WSC verification are recorded in [owner-phase verification](../artifacts/owner-phase-verification.md). Production TLS, domains, capacity, retention, automated email and customer rollout remain separate release gates.
