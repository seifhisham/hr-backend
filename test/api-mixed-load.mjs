import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const directory = await mkdtemp(join(tmpdir(), 'hr-mixed-load-'));
const databasePath = join(directory, 'hr.sqlite');
const password = randomBytes(24).toString('hex');
const report = {
  complete: false,
  measuredAt: new Date().toISOString(),
  workload:
    '500 historical employees plus 30 fresh authenticated employees; 10 attendance workers; one continuously reading quarterly-report client; concurrent HR edits, manager reassignment, request decision, and stale payroll approval attempt. Photo uploads are synthetic 1600x1200 JPEGs; fresh connections; no retries.',
  results: [],
};
let child;
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise((done) => child.once('exit', done));
  if (child.connected) child.send('stop');
  else child.kill();
  const timer = setTimeout(() => child.kill(), 10000);
  await stopped;
  clearTimeout(timer);
}
try {
  child = fork(resolve('test/api-performance.mjs'), ['--server'], {
    execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HR_DATABASE_PATH: databasePath,
      HR_ADMIN_EMAIL: 'mixed@test.local',
      HR_ADMIN_PASSWORD: password,
      HR_READ_CACHE: 'true',
      HR_PERF_EMPLOYEES: '500',
    },
  });
  const { base } = await new Promise((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Backend startup timed out')),
      120000,
    );
    child.once('message', (value) => {
      clearTimeout(timer);
      done(value);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Backend exited early: ${code}`));
    });
  });
  async function call(
    path,
    { token, body, method = body ? 'POST' : 'GET', status } = {},
  ) {
    const start = performance.now();
    const multipart = body instanceof FormData;
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        Connection: 'close',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120000),
    });
    const value = await response.json();
    if (status) assert.equal(response.status, status, JSON.stringify(value));
    else
      assert.equal(
        response.ok,
        true,
        `${path}: ${response.status} ${JSON.stringify(value)}`,
      );
    return { value, ms: performance.now() - start };
  }
  const admin = (
    await call('/auth/login', { body: { email: 'mixed@test.local', password } })
  ).value.token;
  const schedule = (await call('/schedules', { token: admin })).value[0];
  const employees = [];
  for (let i = 0; i < 30; i++) {
    const fields = {
      nationalId: `MIXED-${i}`,
      name: `Mixed Employee ${i}`,
      email: `mixed-${i}@test.local`,
      department: 'Mixed load',
      jobTitle: 'Specialist',
      startDate: '2026-01-01',
      scheduleId: schedule.id,
      active: true,
      role: i < 2 ? 'manager' : 'employee',
      managerId: i < 2 ? null : employees[0].id,
      monthlySalary: 12000,
      salaryCurrency: 'EGP',
    };
    const employee = (
      await call('/employees', { token: admin, body: { ...fields, password } })
    ).value;
    const token = (
      await call('/auth/login', { body: { email: fields.email, password } })
    ).value.token;
    employees.push({ ...employee, token, fields });
  }
  const today = (await call('/auth/me', { token: admin })).value.today;
  const future = new Date(`${today}T00:00:00Z`);
  future.setUTCDate(future.getUTCDate() + 2);
  const leaveDate = future.toISOString().slice(0, 10);
  const requester = employees.at(-1);
  const request = (
    await call('/requests', {
      token: requester.token,
      body: {
        type: 'leave',
        from: leaveDate,
        to: leaveDate,
        reason: 'Mixed performance fixture',
      },
    })
  ).value;
  const payrollBefore = (
    await call('/payroll/run?month=2026-09', { token: admin })
  ).value;
  const photo = await sharp(randomBytes(1600 * 1200 * 3), {
    raw: { width: 1600, height: 1200, channels: 3 },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
  report.photoBytes = photo.length;
  function evidence() {
    const form = new FormData();
    for (const [name, value] of Object.entries({
      latitude: '30.023092',
      longitude: '31.528179',
      accuracyMeters: '10',
      capturedAt: new Date().toISOString(),
    }))
      form.set(name, value);
    form.set('photo', new Blob([photo], { type: 'image/jpeg' }), 'mixed.jpg');
    return form;
  }
  const samples = {
    'check-in': [],
    'check-out': [],
    'quarterly-report': [],
    'employee-edit': [],
    'request-decision': [],
  };
  const metricsReady = once(child, 'message');
  child.send('metrics-start');
  await metricsReady;
  let finished = false;
  const background = (async () => {
    do {
      const response = await call('/attendance?from=2026-07-01&to=2026-09-30', {
        token: admin,
      });
      assert.ok(response.value.length > 33000);
      samples['quarterly-report'].push(response.ms);
    } while (!finished && samples['quarterly-report'].length < 20);
  })();
  // Observe errors immediately; the final await still propagates them to the report.
  background.catch(() => {});
  const mutations = (async () => {
    const updated = await call(`/employees/${requester.id}`, {
      token: admin,
      method: 'PATCH',
      body: {
        ...requester.fields,
        managerId: employees[1].id,
        monthlySalary: 12100,
      },
    });
    samples['employee-edit'].push(updated.ms);
    const profiles = (await call('/employees', { token: admin })).value;
    assert.equal(
      profiles.find((employee) => employee.id === requester.id).monthlySalary,
      12100,
    );
    assert.equal(
      profiles.find((employee) => employee.id === requester.id).managerId,
      employees[1].id,
    );
    const oldReports = (
      await call('/employees/reports', { token: employees[0].token })
    ).value;
    const newReports = (
      await call('/employees/reports', { token: employees[1].token })
    ).value;
    assert.ok(!oldReports.some((employee) => employee.id === requester.id));
    assert.ok(newReports.some((employee) => employee.id === requester.id));
    await call(`/requests/${request.id}/manager-review`, {
      token: employees[0].token,
      method: 'PATCH',
      body: { status: 'approved', reason: 'Old manager must be rejected' },
      status: 403,
    });
    await call(`/requests/${request.id}/manager-review`, {
      token: employees[1].token,
      method: 'PATCH',
      body: { status: 'approved', reason: 'Current manager approval' },
    });
    const decision = await call(`/requests/${request.id}/decision`, {
      token: admin,
      method: 'PATCH',
      body: { status: 'approved', reason: 'HR mixed-load approval' },
    });
    samples['request-decision'].push(decision.ms);
    assert.equal(decision.value.status, 'approved');
    const history = (await call('/requests/me', { token: requester.token }))
      .value;
    assert.equal(
      history.find((item) => item.id === request.id).status,
      'approved',
    );
    await call('/payroll/approve', {
      token: admin,
      body: {
        month: '2026-09',
        expectedRevision: payrollBefore.revision,
        reason: 'Stale draft must be rejected',
      },
      status: 409,
    });
    const payrollAfter = (
      await call('/payroll/run?month=2026-09', { token: admin })
    ).value;
    assert.notEqual(payrollAfter.revision, payrollBefore.revision);
    assert.equal(payrollAfter.status, 'draft');
  })();
  let next = 0;
  try {
    await Promise.all([
      mutations,
      ...Array.from({ length: 10 }, async () => {
        while (next < employees.length) {
          const employee = employees[next++];
          const checkedIn = await call('/attendance/check-in', {
            token: employee.token,
            body: evidence(),
          });
          assert.equal(checkedIn.value.employeeId, employee.id);
          samples['check-in'].push(checkedIn.ms);
          const checkedOut = await call(
            `/attendance/${checkedIn.value.id}/check-out`,
            { token: employee.token, body: evidence() },
          );
          assert.equal(checkedOut.value.id, checkedIn.value.id);
          assert.equal(checkedOut.value.employeeId, employee.id);
          assert.ok(checkedOut.value.checkOut);
          samples['check-out'].push(checkedOut.ms);
        }
      }),
    ]);
  } finally {
    finished = true;
    await background;
  }
  const metricsFinished = once(child, 'message');
  child.send('metrics-stop');
  const [{ type: _type, ...metrics }] = await metricsFinished;
  report.backendMetrics = metrics;
  for (const [phase, times] of Object.entries(samples)) {
    times.sort((a, b) => a - b);
    const percentile = (p) =>
      Number(times[Math.ceil(times.length * p) - 1].toFixed(2));
    report.results.push({
      phase,
      successful: times.length,
      medianMs: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: percentile(1),
    });
  }
  await stop();
  child = undefined;
  const db = new DatabaseSync(databasePath);
  try {
    assert.equal(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM attendance WHERE employee_id IN (SELECT value FROM json_each(?)) AND check_out IS NOT NULL AND check_out >= check_in',
        )
        .get(JSON.stringify(employees.map((employee) => employee.id))).count,
      30,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM attendance_evidence').get()
        .count,
      60,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM payroll_runs').get().count,
      0,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
  report.complete = true;
  report.verification = {
    salaryAndManagerFresh: true,
    oldManagerDenied: true,
    newManagerScopeFresh: true,
    requestDecisionFresh: true,
    stalePayrollRejected: true,
    closedRecords: 30,
    photoEvidenceRecords: 60,
    foreignKeysValid: true,
  };
  console.log(JSON.stringify(report.results));
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error);
} finally {
  try {
    await stop();
  } finally {
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(resolve(tmpdir()), 'hr-mixed-load-')));
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    await assert.rejects(access(directory), { code: 'ENOENT' });
    report.cleanupVerified = true;
    await mkdir(resolve('../artifacts'), { recursive: true });
    await writeFile(
      resolve('../artifacts/api-mixed-performance.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(
      'Mixed-load report saved; temporary database and photos removed.',
    );
  }
}
