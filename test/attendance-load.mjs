import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const directory = await mkdtemp(join(tmpdir(), 'hr-attendance-load-'));
const databasePath = join(directory, 'hr.sqlite');
const password = randomBytes(24).toString('hex');
process.env.HR_DATABASE_PATH = databasePath;
process.env.HR_ADMIN_EMAIL = 'load-admin@test.local';
process.env.HR_ADMIN_PASSWORD = password;
const abort = new AbortController();
const interrupt = () => abort.abort(new Error('Load test interrupted'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
let app;

try {
  // Import only after setting the isolated database and bootstrap environment.
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../dist/app.module.js');
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const photo = await sharp(randomBytes(1600 * 1200 * 3), {
    raw: { width: 1600, height: 1200, channels: 3 },
  }).jpeg({ quality: 85 }).toBuffer();
  console.log(`100 employees; JPEG upload ${(photo.length / 1024).toFixed(0)} KiB each`);

  async function call(path, { token, body, method = 'POST' } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await fetch(`${base}/api${path}`, {
      method, headers, body,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
    });
    const result = await response.json();
    assert.equal(response.ok, true, `${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
    return result;
  }

  const admin = await call('/auth/login', {
    body: { email: process.env.HR_ADMIN_EMAIL, password },
  });
  const schedules = await call('/schedules', { token: admin.token, method: 'GET' });
  const employees = [];
  // Provisioning is outside the timed attendance bursts.
  for (let index = 0; index < 100; index++) {
    abort.signal.throwIfAborted();
    const employee = await call('/employees', {
      token: admin.token,
      body: {
        nationalId: `LOAD-${index}`, name: `Load Employee ${index}`,
        email: `load-${index}@test.local`, department: 'Load test',
        jobTitle: 'Test employee', startDate: '2026-01-01',
        scheduleId: schedules[0].id, role: 'employee', active: true, password,
      },
    });
    const session = await call('/auth/login', { body: { email: employee.email, password } });
    employees.push({ token: session.token });
  }

  function evidence() {
    const form = new FormData();
    form.set('latitude', '30.023092');
    form.set('longitude', '31.528179');
    form.set('accuracyMeters', '10');
    form.set('capturedAt', new Date().toISOString());
    form.set('photo', new Blob([photo], { type: 'image/jpeg' }), 'load-test.jpg');
    return form;
  }

  async function burst(label, path) {
    const started = performance.now();
    const results = await Promise.allSettled(employees.map(async (employee) => {
      const start = performance.now();
      const record = await call(path(employee), { token: employee.token, body: evidence() });
      employee.attendanceId = record.id;
      return performance.now() - start;
    }));
    const seconds = (performance.now() - started) / 1000;
    const times = results.filter(r => r.status === 'fulfilled').map(r => r.value).sort((a, b) => a - b);
    const failures = results.filter(r => r.status === 'rejected');
    const percentile = p => times.length ? Math.round(times[Math.ceil(times.length * p) - 1]) : null;
    console.log(JSON.stringify({
      phase: label, successful: times.length, failed: failures.length,
      durationSeconds: Number(seconds.toFixed(2)), requestsPerSecond: Number((times.length / seconds).toFixed(2)),
      medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1),
    }));
    for (const failure of failures.slice(0, 5)) console.error(failure.reason.message);
    assert.equal(failures.length, 0, `${label} requests failed`);
  }

  await burst('check-in', () => '/attendance/check-in');
  await burst('check-out', employee => `/attendance/${employee.attendanceId}/check-out`);
  await app.close();
  app = undefined;
  const db = new DatabaseSync(databasePath);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM employees').get().count, 100);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attendance WHERE check_out IS NOT NULL').get().count, 100);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attendance_evidence').get().count, 200);
    console.log('PASS: 100 closed attendance records and 200 photo evidence records verified.');
  } finally {
    db.close();
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    if (app) await app.close();
  } finally {
    // Delete only the directory created by this test, never an existing database.
    assert.equal(directory.startsWith(join(tmpdir(), 'hr-attendance-load-')), true);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await assert.rejects(access(directory), { code: 'ENOENT' });
    console.log('Cleanup verified: temporary database, photos, users, sessions, audit and WAL files removed.');
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
