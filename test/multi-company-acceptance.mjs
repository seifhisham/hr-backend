import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import sharp from 'sharp';
import { NestFactory } from '@nestjs/core';
import { createLoadDatabase } from './postgres-load-fixture.mjs';
import { AppModule } from '../dist/app.module.js';
import {
  passwordHash,
  tokenHash,
} from '../dist/common/security/credentials.js';
import { newTotpSecret, seal } from '../dist/owner/owner-crypto.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = mkdtempSync(join(root, '.tmp', 'multi-company-acceptance-'));
const browser = process.argv.includes('--browser');
const site = 'http://127.0.0.2:3303',
  backend = 'http://127.0.0.1:3302';
const password = 'Acceptance123!',
  ownerEmail = 'owner@acceptance.test';
const report = {
  complete: false,
  startedAt: new Date().toISOString(),
  site,
  checks: [],
};
let fixture,
  admin,
  app,
  nextApp,
  server,
  stage = 'fixture';
const reportPath = join(root, 'artifacts', 'multi-company-acceptance.json');
const record = (name) => {
  report.checks.push({ name, passed: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
};
const tokenFrom = (path) =>
  new URLSearchParams(path.split('#')[1]).get('token');
async function call(
  path,
  {
    token,
    cookie,
    body,
    method = body ? 'POST' : 'GET',
    status = method === 'POST' ? 201 : 200,
    origin = site,
    binary = false,
  } = {},
) {
  const form = body instanceof FormData;
  const response = await fetch(site + '/api' + path, {
    method,
    headers: {
      Origin: origin,
      ...(!form && body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(
    response.status,
    status,
    `${method} ${path.split('?')[0]} returned ${response.status}; expected ${status}`,
  );
  const data = binary
    ? Buffer.from(await response.arrayBuffer())
    : await response.json();
  return { data, cookies: response.headers.getSetCookie() };
}
async function startFrontend() {
  const target = join(directory, 'frontend');
  mkdirSync(target);
  for (const name of [
    'app',
    'lib',
    'public',
    'package.json',
    'package-lock.json',
    'next.config.ts',
    'postcss.config.mjs',
    'tsconfig.json',
    'next-env.d.ts',
  ]) {
    const source = join(root, 'hr-frontend', name);
    if (existsSync(source))
      cpSync(source, join(target, name), { recursive: true });
  }
  symlinkSync(
    join(root, 'hr-frontend', 'node_modules'),
    join(target, 'node_modules'),
    'junction',
  );
  process.env.HR_API_URL = backend;
  process.env.NEXT_TELEMETRY_DISABLED = '1';
  const require = createRequire(join(root, 'hr-frontend', 'package.json'));
  const next = require('next');
  nextApp = next({
    dev: true,
    dir: target,
    hostname: '127.0.0.2',
    port: 3303,
    webpack: true,
  });
  await nextApp.prepare();
  server = createServer(nextApp.getRequestHandler());
  server.on('upgrade', nextApp.getUpgradeHandler());
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(3303, '127.0.0.2', done);
  });
}
async function run() {
  fixture = await createLoadDatabase();
  const target = new URL(fixture.env.HR_PG_URL);
  assert.match(target.pathname, /^\/hr_load_[a-f0-9]{16}$/);
  const migration = new URL(process.env.HR_PG_TEST_ADMIN_URL);
  migration.pathname = target.pathname;
  admin = new Pool({ connectionString: migration.href });
  admin.on('error', () => {});
  // Remove the helper's empty seed company; all acceptance customers use owner provisioning through REST.
  await admin.query('DELETE FROM branches WHERE company_id=$1', [
    fixture.env.HR_BOOTSTRAP_COMPANY_ID,
  ]);
  await admin.query('DELETE FROM company_revisions WHERE company_id=$1', [
    fixture.env.HR_BOOTSTRAP_COMPANY_ID,
  ]);
  await admin.query('DELETE FROM companies WHERE id=$1', [
    fixture.env.HR_BOOTSTRAP_COMPANY_ID,
  ]);
  Object.assign(process.env, fixture.env, {
    NODE_ENV: 'development',
    HR_OWNER_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    HR_ALLOWED_ORIGINS: site,
  });
  delete process.env.HR_BOOTSTRAP_COMPANY_ID;
  delete process.env.HR_DEFAULT_WORKSPACE;
  const secret = newTotpSecret(),
    recovery = randomBytes(12).toString('hex');
  await admin.query(
    'INSERT INTO platform_owners(id,email,name,password_hash,totp_secret,recovery_hashes) VALUES($1,$2,$3,$4,$5,$6)',
    [
      randomUUID(),
      ownerEmail,
      'Acceptance Owner',
      await passwordHash(password),
      seal(secret),
      JSON.stringify([tokenHash(recovery)]),
    ],
  );
  stage = 'backend';
  app = await NestFactory.create(AppModule, { logger: false });
  app.useBodyParser('json', { limit: '3mb' });
  await app.listen(3302, '127.0.0.1');
  stage = 'frontend';
  await startFrontend();
  stage = 'REST acceptance';
  const ownerLogin = await call('/owner/login', {
      body: { email: ownerEmail, password, recoveryCode: recovery },
    }),
    ownerToken = ownerLogin.data.token;
  assert.ok(ownerLogin.cookies[0].includes('HttpOnly'));
  assert.ok(ownerLogin.cookies[0].includes('Path=/api/owner'));
  assert.ok(ownerLogin.cookies[0].includes('SameSite=Strict'));
  const ownerCookie = ownerLogin.cookies[0].split(';')[0];
  await call('/owner/me', { cookie: ownerCookie });
  record('Owner cookie login works through the real Next.js proxy');
  const policy = {
    address: 'Acceptance office',
    latitude: 30,
    longitude: 31,
    radiusMeters: 50,
    trackingRadiusMeters: 150,
    trackingGraceMinutes: 5,
  };
  const companies = [];
  for (const [workspace, name] of [
    ['acceptance-aster', 'Aster Company'],
    ['acceptance-birch', 'Birch Company'],
  ]) {
    const input = {
      requestId: randomUUID(),
      workspace,
      name,
      timezone: 'Africa/Cairo',
      adminEmail: 'admin@acceptance.test',
      adminName: name + ' Admin',
    };
    const created = await call('/owner/companies', {
      token: ownerToken,
      body: input,
    });
    const retry = await call('/owner/companies', {
      token: ownerToken,
      body: input,
    });
    assert.equal(retry.data.id, created.data.id);
    const link = await call(
      '/owner/companies/' + created.data.id + '/invitation',
      { token: ownerToken, body: { requestId: randomUUID() } },
    );
    const token = tokenFrom(link.data.path);
    await call('/onboarding/preview', { body: { token } });
    await call('/onboarding/accept', {
      body: {
        token,
        password,
        name: input.adminName,
        branchName: name + ' Main',
        policy,
      },
    });
    await call('/onboarding/preview', { body: { token }, status: 401 });
    await call('/owner/companies/' + created.data.id + '/status', {
      token: ownerToken,
      body: {
        status: 'active',
        expectedStatus: 'provisioning',
        reason: 'Acceptance setup completed',
      },
    });
    const signed = await call('/auth/login', {
      body: { workspace, email: input.adminEmail, password },
    });
    const branches = await call('/branches', { token: signed.data.token });
    const schedules = await call('/schedules', { token: signed.data.token });
    companies.push({
      id: created.data.id,
      workspace,
      name,
      admin: signed.data,
      adminCookie: signed.cookies[0].split(';')[0],
      branch: branches.data[0],
      schedule: schedules.data[0],
    });
  }
  const [a, b] = companies;
  assert.notEqual(a.admin.user.id, b.admin.user.id);
  assert.notEqual(a.branch.id, b.branch.id);
  record(
    'Two companies provision, accept single-use invitations and activate independently; creation retries are idempotent',
  );
  const second = (
    await call('/branches', {
      token: a.admin.token,
      body: {
        ...policy,
        latitude: 31,
        longitude: 30,
        code: 'north',
        name: 'Aster North',
        active: true,
      },
    })
  ).data;
  const staff = async (
    company,
    name,
    role,
    branch,
    email = 'employee@acceptance.test',
  ) => {
    const input = {
      nationalId:
        role === 'hr'
          ? 'HR-ONE'
          : 'STAFF-ONE' + (branch.id === second.id ? '-N' : ''),
      name,
      email,
      department: 'Operations',
      jobTitle: 'Acceptance role',
      startDate: '2026-01-01',
      scheduleId: company.schedule.id,
      branchId: branch.id,
      active: true,
      salesEnabled: true,
      role,
      monthlySalary: 3000,
      password,
    };
    const employee = (
      await call('/employees', { token: company.admin.token, body: input })
    ).data;
    const login = (
      await call('/auth/login', {
        body: { workspace: company.workspace, email, password },
      })
    ).data;
    return { ...login, employee };
  };
  const employeeA = await staff(a, 'Aster Main Employee', 'employee', a.branch),
    employeeNorth = await staff(
      a,
      'Aster North Employee',
      'employee',
      second,
      'north@acceptance.test',
    );
  const employeeB = await staff(
      b,
      'Birch Private Employee',
      'employee',
      b.branch,
    ),
    hr = await staff(a, 'Aster Branch HR', 'hr', second, 'hr@acceptance.test');
  await call('/hr-accounts/' + hr.user.id + '/branches', {
    token: a.admin.token,
    method: 'PATCH',
    body: { branchIds: [a.branch.id], reason: 'Grant main branch only' },
  });
  assert.equal((await call('/employees', { token: hr.token })).data.length, 1);
  assert.equal(
    (await call('/attendance/policy', { token: hr.token })).data.branchId,
    second.id,
  );
  assert.equal(
    (await call('/employees', { token: b.admin.token })).data[0].name,
    'Birch Private Employee',
  );
  record(
    'Identical admin/employee emails and national IDs remain company-scoped; HR home branch does not imply an administrative grant',
  );
  await call('/employees', { token: ownerToken, status: 401 });
  await call('/owner/companies', { token: a.admin.token, status: 401 });
  assert.equal(
    (await call('/auth/me', { cookie: a.adminCookie + '; ' + ownerCookie }))
      .data.user.companyId,
    a.id,
  );
  assert.equal(
    (await call('/owner/me', { cookie: a.adminCookie + '; ' + ownerCookie }))
      .data.email,
    ownerEmail,
  );
  await call('/departments', {
    cookie: a.adminCookie,
    body: { name: 'Blocked origin' },
    origin: 'https://untrusted.example',
    status: 403,
  });
  await call('/employees/' + employeeB.employee.id, {
    token: a.admin.token,
    method: 'PATCH',
    body: {
      nationalId: 'STAFF-ONE',
      name: 'Forbidden edit',
      email: 'employee@acceptance.test',
      department: 'Operations',
      jobTitle: 'Acceptance role',
      startDate: '2026-01-01',
      scheduleId: a.schedule.id,
      branchId: a.branch.id,
      active: true,
      role: 'employee',
      monthlySalary: 3000,
    },
    status: 404,
  });
  record(
    'Owner/company cookie boundaries, foreign employee mutations and cross-origin writes fail closed',
  );
  const photo = await sharp({
    create: { width: 32, height: 32, channels: 3, background: 'white' },
  })
    .jpeg()
    .toBuffer();
  async function capture(person, point, status = 201) {
    const form = new FormData();
    form.set('latitude', String(point.latitude));
    form.set('longitude', String(point.longitude));
    form.set('accuracyMeters', '5');
    form.set('capturedAt', new Date().toISOString());
    form.set(
      'photo',
      new Blob([photo], { type: 'image/jpeg' }),
      'acceptance.jpg',
    );
    return call('/attendance/check-in', {
      token: person.token,
      body: form,
      status,
    });
  }
  await capture(employeeA, second, 403);
  const attendanceA = (await capture(employeeA, policy)).data,
    attendanceNorth = (await capture(employeeNorth, second)).data,
    attendanceB = (await capture(employeeB, policy)).data;
  const mine = await call(
    '/attendance/' + attendanceA.id + '/photos/check-in',
    { token: a.admin.token, binary: true },
  );
  assert.ok(
    mine.data.equals(
      (
        await call('/attendance/' + attendanceA.id + '/photos/check-in', {
          token: hr.token,
          binary: true,
        })
      ).data,
    ),
  );
  await call('/attendance/' + attendanceA.id + '/photos/check-in', {
    token: b.admin.token,
    status: 404,
  });
  await call('/attendance/' + attendanceNorth.id + '/photos/check-in', {
    token: hr.token,
    status: 404,
  });
  record(
    'Attendance accepts only assigned-branch location; photo bytes are accessible only to authorized company/branch viewers',
  );
  const today = (await call('/auth/me', { token: a.admin.token })).data.today,
    month = today.slice(0, 7);
  const reqA = (
    await call('/requests', {
      token: employeeA.token,
      body: {
        type: 'leave',
        from: today,
        to: today,
        reason: 'Aster main acceptance request',
      },
    })
  ).data;
  const reqB = (
    await call('/requests', {
      token: employeeB.token,
      body: {
        type: 'leave',
        from: today,
        to: today,
        reason: 'Birch private acceptance request',
      },
    })
  ).data;
  const requestA = await call('/requests', { token: a.admin.token }),
    requestB = await call('/requests', { token: b.admin.token });
  assert.ok(JSON.stringify(requestA.data).includes(reqA.id));
  assert.ok(!JSON.stringify(requestA.data).includes(reqB.id));
  assert.ok(!JSON.stringify(requestB.data).includes(reqA.id));
  for (const [path, token, forbidden] of [
    [`/attendance?from=${today}&to=${today}`, a.admin.token, attendanceB.id],
    [`/attendance?from=${today}&to=${today}`, hr.token, attendanceNorth.id],
    [`/payroll/run?month=${month}`, a.admin.token, employeeB.employee.id],
    [`/payroll/run?month=${month}`, hr.token, employeeNorth.employee.id],
    ['/notifications', a.admin.token, 'Birch private acceptance request'],
    ['/audit?search=Birch', a.admin.token, 'Birch Private Employee'],
  ]) {
    const result = await call(path, { token });
    assert.ok(
      !JSON.stringify(result.data).includes(forbidden),
      path + ' leaked an out-of-scope record',
    );
  }
  const csv = await call(`/attendance/export?from=${today}&to=${today}`, {
    token: hr.token,
    binary: true,
  });
  assert.ok(!csv.data.toString().includes('Aster North Employee'));
  assert.ok(csv.data.toString().includes('Aster Main Employee'));
  await call('/settings', {
    token: hr.token,
    method: 'PATCH',
    body: { name: 'Unauthorized setting', timezone: 'Africa/Cairo' },
    status: 403,
  });
  await call('/payroll/approve', {
    token: hr.token,
    body: {
      month,
      expectedRevision: 'a'.repeat(64),
      reason: 'Forbidden company approval',
    },
    status: 403,
  });
  record(
    'Requests, attendance, CSV, payroll, notifications and audit remain scoped; HR cannot edit shared settings or approve company payroll',
  );
  await call('/hr-accounts/' + hr.user.id + '/branches', {
    token: a.admin.token,
    method: 'PATCH',
    body: { branchIds: [], reason: 'Revoke administrative access' },
  });
  await call('/employees', { token: hr.token, status: 403 });
  await call('/attendance/policy', { token: hr.token });
  await call('/hr-accounts/' + hr.user.id + '/branches', {
    token: a.admin.token,
    method: 'PATCH',
    body: {
      branchIds: [a.branch.id],
      reason: 'Restore main branch responsibility',
    },
  });
  record(
    'Grant revocation affects existing HR sessions while personal attendance remains available',
  );
  const change = async (status, expectedStatus) =>
    call('/owner/companies/' + a.id + '/status', {
      token: ownerToken,
      body: { status, expectedStatus, reason: 'Acceptance lifecycle check' },
    });
  await change('suspended', 'active');
  await call('/employees', { token: a.admin.token, status: 401 });
  await call('/employees', { token: b.admin.token });
  await call('/auth/login', {
    body: { workspace: a.workspace, email: 'admin@acceptance.test', password },
    status: 401,
  });
  await change('active', 'suspended');
  await call('/employees', { token: a.admin.token, status: 401 });
  a.admin = (
    await call('/auth/login', {
      body: {
        workspace: a.workspace,
        email: 'admin@acceptance.test',
        password,
      },
    })
  ).data;
  assert.equal(
    (await call('/employees', { token: a.admin.token })).data.length,
    3,
  );
  record(
    'Suspension revokes only the affected company sessions; reactivation preserves data and requires a fresh login',
  );
  const credentials = {
    site,
    password,
    owner: { email: ownerEmail, secret },
    companies: companies.map((company) => ({
      id: company.id,
      workspace: company.workspace,
      name: company.name,
      adminEmail: 'admin@acceptance.test',
    })),
    hrEmail: 'hr@acceptance.test',
    employeeEmail: 'employee@acceptance.test',
  };
  writeFileSync(
    join(directory, 'browser-credentials.json'),
    JSON.stringify(credentials, null, 2),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, '.tmp', 'current-multi-company-acceptance.json'),
    JSON.stringify({ directory, site, stop: join(directory, 'stop') }, null, 2),
  );
  report.complete = true;
  report.completedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      apiAcceptancePassed: true,
      checks: report.checks.length,
      site,
      browserMode: browser,
    }),
  );
  if (browser) {
    console.log(
      'Disposable browser environment ready. Write its stop file to close servers and remove its generated database/role.',
    );
    while (!existsSync(join(directory, 'stop')))
      await new Promise((done) => setTimeout(done, 1000));
  }
}
try {
  await run();
} catch (error) {
  report.failure = {
    name: error.name,
    code: error.code,
    stage,
    message:
      error.name === 'AssertionError'
        ? error.message
        : 'Acceptance environment failed; private connection details omitted',
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
  await nextApp?.close();
  await app?.close();
  await admin?.end();
  await fixture?.close();
  console.log(
    'Disposable acceptance servers/database closed. Main application and WSC were not used.',
  );
  process.exit(process.exitCode ?? 0);
}
