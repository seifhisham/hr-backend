import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, access, mkdir, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createLoadDatabase, inLoadCompany } from './postgres-load-fixture.mjs';
import sharp from 'sharp';
async function server() {
  if (process.env.HR_PERF_SHARP_CONCURRENCY)
    sharp.concurrency(Number(process.env.HR_PERF_SHARP_CONCURRENCY));
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../dist/app.module.js');
  const app = await NestFactory.create(AppModule, { logger: false });
  process.once('disconnect', async () => {
    await app.close();
    process.exit(0);
  });
  let diagnostics;
  if (process.env.HR_ATTENDANCE_DIAGNOSTICS === 'true') {
    for (const method of ['metadata', 'toBuffer']) {
      const original = sharp.prototype[method];
      sharp.prototype[method] = async function (...parameters) {
        const start = performance.now();
        try {
          return await original.apply(this, parameters);
        } finally {
          diagnostics?.[method].push(performance.now() - start);
        }
      };
    }
    const { DatabaseService } =
      await import('../dist/database/database.service.js');
    const { AttendanceService } =
      await import('../dist/attendance/attendance.service.js');
    const store = app.get(DatabaseService),
      attendance = app.get(AttendanceService);
    let writingAttendance = false;
    for (const method of ['checkIn', 'checkOut']) {
      const original = attendance[method].bind(attendance);
      attendance[method] = async (...parameters) => {
        writingAttendance = true;
        try {
          return await original(...parameters);
        } finally {
          writingAttendance = false;
        }
      };
    }
    const transaction = store.transaction.bind(store);
    store.transaction = async (operation) => {
      const start = performance.now();
      try {
        return await transaction(operation);
      } finally {
        if (writingAttendance)
          diagnostics?.transaction.push(performance.now() - start);
      }
    };
  }
  process.on('message', async (message) => {
    if (message === 'diagnostics-start') {
      diagnostics = { metadata: [], toBuffer: [], transaction: [] };
      process.send({ type: 'diagnostics-ready' });
    } else if (message === 'diagnostics-stop') {
      const stages = Object.fromEntries(
        Object.entries(diagnostics).map(([stage, times]) => {
          times.sort((a, b) => a - b);
          const percentile = (p) =>
            times.length
              ? Number(times[Math.ceil(times.length * p) - 1].toFixed(2))
              : null;
          return [
            stage,
            {
              count: times.length,
              medianMs: percentile(0.5),
              p95Ms: percentile(0.95),
            },
          ];
        }),
      );
      diagnostics = undefined;
      process.send({ type: 'diagnostics', stages });
    } else if (message === 'stop') {
      await app.close();
      process.exit(0);
    }
  });
  await app.listen(0, '127.0.0.1');
  process.send({
    base: await app.getUrl(),
    sharpConcurrency: sharp.concurrency(),
  });
}
async function benchmark() {
  const directory = await mkdtemp(join(tmpdir(), 'hr-attendance-load-'));
  const reportPath = resolve(
    process.argv[2] ?? '../artifacts/attendance-performance.json',
  );
  assert.ok(reportPath.endsWith('.json'), 'Report path must end with .json');
  const diagnosticMode = process.env.HR_ATTENDANCE_DIAGNOSTICS === 'true';
  const password = randomBytes(24).toString('hex');
  const cases = [
    { concurrency: 1, samples: 30 },
    { concurrency: 10, samples: 30 },
    { concurrency: 100, samples: 100 },
  ];
  const employeeCount = cases.reduce((sum, test) => sum + test.samples, 0);
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error('Load test interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const results = [];
  const report = {
    complete: false,
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    cpu: cpus()[0]?.model,
    cache: true,
    employeeCount,
    results,
    methodology:
      'Separate client/backend processes; compiled NestJS REST API; isolated PostgreSQL; fresh HTTP connections; no retries; synthetic employees provisioned and authenticated through REST outside timing; timing includes upload, photo normalization, PostgreSQL transaction, and response parsing. Validation and persistence checks are outside timing.',
  };
  let child;
  let fixture;
  async function save() {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
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
    fixture = await createLoadDatabase();
    child = fork(fileURLToPath(import.meta.url), ['--server'], {
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        ...fixture.env,
        HR_ADMIN_EMAIL: 'load-admin@test.local',
        HR_ADMIN_PASSWORD: password,
        HR_READ_CACHE: 'true',
      },
    });
    const { base, sharpConcurrency } = await new Promise((done, reject) => {
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
        reject(new Error(`Backend exited before startup: ${code}`));
      });
    });
    report.sharpConcurrency = sharpConcurrency;
    report.diagnosticMode = diagnosticMode;
    const workload = process.env.HR_PERF_PHOTO_WORKLOAD ?? 'standard-jpeg';
    assert.ok(
      ['standard-jpeg', 'large-jpeg', 'png'].includes(workload),
      'Unknown photo workload',
    );
    const width =
      workload === 'large-jpeg' ? 2560 : workload === 'png' ? 800 : 1600;
    const height =
      workload === 'large-jpeg' ? 1920 : workload === 'png' ? 600 : 1200;
    const format = workload === 'png' ? 'png' : 'jpeg';
    const image = sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    });
    const photo = await (
      format === 'png' ? image.png() : image.jpeg({ quality: 85 })
    ).toBuffer();
    assert.ok(
      photo.length <= 5 * 1024 * 1024,
      'Fixture exceeds the API photo limit',
    );
    report.photo = {
      format,
      width,
      height,
      bytes: photo.length,
      syntheticNoise: true,
    };
    console.log(
      `${employeeCount} employees; ${format} ${width}x${height} upload ${(photo.length / 1024).toFixed(0)} KiB each; cache enabled`,
    );
    async function call(
      path,
      { token, body, method = 'POST', expectedStatus } = {},
    ) {
      const headers = { Connection: 'close' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body && !(body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
      }
      const response = await fetch(`${base}/api${path}`, {
        method,
        headers,
        ...(body ? { body } : {}),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
      });
      const result = await response.json();
      if (expectedStatus)
        assert.equal(
          response.status,
          expectedStatus,
          `${path}: ${JSON.stringify(result)}`,
        );
      else
        assert.equal(
          response.ok,
          true,
          `${path}: HTTP ${response.status} ${JSON.stringify(result)}`,
        );
      return result;
    }
    const admin = await call('/auth/login', {
      body: { email: 'load-admin@test.local', password },
    });
    const schedules = await call('/schedules', {
      token: admin.token,
      method: 'GET',
    });
    const employees = [];
    for (let index = 0; index < employeeCount; index++) {
      abort.signal.throwIfAborted();
      const employee = await call('/employees', {
        token: admin.token,
        body: {
          nationalId: `LOAD-${index}`,
          name: `Load Employee ${index}`,
          email: `load-${index}@test.local`,
          department: 'Load test',
          jobTitle: 'Test employee',
          startDate: '2026-01-01',
          scheduleId: schedules[0].id,
          role: 'employee',
          active: true,
          password,
        },
      });
      const session = await call('/auth/login', {
        body: { email: employee.email, password },
      });
      employees.push({ id: employee.id, token: session.token });
    }
    console.log('Provisioning complete; measuring fresh attendance writes.');
    function evidence({ includePhoto = true, latitude = '30.023092' } = {}) {
      const form = new FormData();
      form.set('latitude', latitude);
      form.set('longitude', '31.528179');
      form.set('accuracyMeters', '10');
      form.set('capturedAt', new Date().toISOString());
      if (includePhoto)
        form.set(
          'photo',
          new Blob([photo], { type: `image/${format}` }),
          `load-test.${format === 'jpeg' ? 'jpg' : 'png'}`,
        );
      return form;
    }
    await call('/attendance/check-in', {
      body: evidence({ includePhoto: false }),
      expectedStatus: 401,
    });
    await call('/attendance/check-in', {
      token: employees[0].token,
      body: evidence({ includePhoto: false }),
      expectedStatus: 400,
    });
    await call('/attendance/check-in', {
      token: employees[0].token,
      body: evidence({ latitude: '31' }),
      expectedStatus: 403,
    });
    async function measure(phase, group, concurrency) {
      if (diagnosticMode) {
        const ready = new Promise((done) => child.once('message', done));
        child.send('diagnostics-start');
        await ready;
      }
      let next = 0;
      const times = [];
      const failures = [];
      const started = performance.now();
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < group.length) {
            const employee = group[next++];
            const start = performance.now();
            try {
              const path =
                phase === 'check-in'
                  ? '/attendance/check-in'
                  : `/attendance/${employee.attendanceId}/check-out`;
              const record = await call(path, {
                token: employee.token,
                body: evidence(),
              });
              const elapsed = performance.now() - start;
              assert.equal(record.employeeId, employee.id);
              if (phase === 'check-in') {
                assert.equal(record.checkOut, null);
                employee.attendanceId = record.id;
              } else {
                assert.equal(record.id, employee.attendanceId);
                assert.ok(record.checkOut);
                assert.ok(
                  Date.parse(record.checkOut) >= Date.parse(record.checkIn),
                );
              }
              times.push(elapsed);
            } catch (error) {
              failures.push(error.cause?.code ?? error.message);
            }
          }
        }),
      );
      const durationSeconds = (performance.now() - started) / 1000;
      let stages;
      if (diagnosticMode) {
        const finished = new Promise((done) => child.once('message', done));
        child.send('diagnostics-stop');
        stages = (await finished).stages;
      }
      times.sort((a, b) => a - b);
      const percentile = (p) =>
        times.length
          ? Number(times[Math.ceil(times.length * p) - 1].toFixed(2))
          : null;
      const row = {
        phase,
        concurrency,
        attempted: group.length,
        successful: times.length,
        failed: failures.length,
        durationSeconds: Number(durationSeconds.toFixed(2)),
        requestsPerSecond: Number((times.length / durationSeconds).toFixed(2)),
        medianMs: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: percentile(1),
        errors: failures,
        ...(stages ? { stages } : {}),
      };
      results.push(row);
      await save();
      console.log(JSON.stringify(row));
      assert.equal(failures.length, 0, `${phase} requests failed`);
    }
    let offset = 0;
    for (const test of cases) {
      const group = employees.slice(offset, offset + test.samples);
      offset += test.samples;
      await measure('check-in', group, test.concurrency);
      const current = await call('/attendance/me', {
        token: group[0].token,
        method: 'GET',
      });
      assert.ok(
        current.records.some(
          (record) =>
            record.id === group[0].attendanceId && record.checkOut === null,
        ),
      );
      const duplicateIn = await call('/attendance/check-in', {
        token: group[0].token,
        body: evidence(),
      });
      assert.equal(duplicateIn.id, group[0].attendanceId);
      await call(`/attendance/${group[0].attendanceId}/check-out`, {
        token: group[1].token,
        body: evidence(),
        expectedStatus: 404,
      });
      await measure('check-out', group, test.concurrency);
      const duplicateOut = await call(
        `/attendance/${group[0].attendanceId}/check-out`,
        { token: group[0].token, body: evidence() },
      );
      assert.equal(duplicateOut.id, group[0].attendanceId);
      const closed = await call('/attendance/me', {
        token: group[0].token,
        method: 'GET',
      });
      assert.ok(
        closed.records.some(
          (record) =>
            record.id === group[0].attendanceId &&
            record.checkOut === duplicateOut.checkOut,
        ),
      );
    }
    await stop();
    child = undefined;
    const db = fixture.db;
    try {
      assert.equal(
        (await db.prepare('SELECT COUNT(*) AS count FROM employees').get())
          .count,
        employeeCount,
      );
      assert.equal(
        (await db.prepare('SELECT COUNT(*) AS count FROM attendance').get())
          .count,
        employeeCount,
      );
      assert.equal(
        (
          await db
            .prepare(
              'SELECT COUNT(*) AS count FROM attendance WHERE check_out IS NOT NULL AND check_out >= check_in',
            )
            .get()
        ).count,
        employeeCount,
      );
      assert.equal(
        (
          await db
            .prepare(
              'SELECT COUNT(*) AS count FROM attendance_evidence WHERE length(photo) > 0',
            )
            .get()
        ).count,
        employeeCount * 2,
      );
      assert.equal(
        (
          await db
            .prepare('SELECT COUNT(*) AS count FROM attendance_location')
            .get()
        ).count,
        0,
      );
      assert.equal(
        (
          await db
            .prepare(
              'SELECT COUNT(*) AS count FROM attendance a WHERE (SELECT COUNT(*) FROM attendance_evidence e WHERE e.attendance_id = a.id) != 2',
            )
            .get()
        ).count,
        0,
      );
      assert.deepEqual(
        await db
          .prepare(
            "SELECT conname FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype='f' AND NOT convalidated",
          )
          .all(),
        [],
      );
      const stored = await db
        .prepare('SELECT photo FROM attendance_evidence LIMIT 1')
        .get();
      const metadata = await sharp(stored.photo).metadata();
      assert.equal(metadata.format, 'jpeg');
      assert.ok(metadata.width <= 1280 && metadata.height <= 1280);
      report.verification = {
        closedRecords: employeeCount,
        photoEvidenceRecords: employeeCount * 2,
        remainingLocationRecords: 0,
        duplicatesIdempotent: true,
        immediateReadsCorrect: true,
        missingPhotoRejected: true,
        outsideOfficeRejected: true,
        unauthenticatedRejected: true,
        otherEmployeeCheckoutRejected: true,
        foreignKeysValid: true,
        normalizedPhotoVerified: true,
      };
      report.complete = true;
      await save();
      console.log(
        `PASS: ${employeeCount} closed attendance records and ${employeeCount * 2} photo evidence records verified. Results: ${reportPath}`,
      );
    } finally {
      await db.close();
    }
  } finally {
    try {
      await stop();
    } finally {
      await fixture?.close();
      // Delete only the resolved temporary directory created by this test.
      assert.equal(dirname(directory), resolve(tmpdir()));
      assert.ok(
        directory.startsWith(join(resolve(tmpdir()), 'hr-attendance-load-')),
      );
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
      await assert.rejects(access(directory), { code: 'ENOENT' });
      report.cleanupVerified = true;
      await save();
      console.log(
        'Cleanup verified: disposable PostgreSQL database/role and temporary files removed.',
      );
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
}
try {
  if (process.argv[2] === '--server') await inLoadCompany(server);
  else await benchmark();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (process.argv[2] === '--server') process.exit(1);
}
