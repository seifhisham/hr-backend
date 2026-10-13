import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

const script = fileURLToPath(import.meta.url);
const endpoints = [
  ['Employees', '/employees'],
  ['Attendance month', '/attendance?from=2026-09-01&to=2026-09-30'],
  ['Attendance quarter', '/attendance?from=2026-07-01&to=2026-09-30'],
  ['Payroll preview', '/payroll?month=2026-09'],
  ['Sales performance', '/sales/performance?month=2026-09'],
  ['Schedules', '/schedules'],
];

async function server() {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../dist/app.module.js');
  const { DatabaseService } =
    await import('../dist/database/database.service.js');
  const app = await NestFactory.create(AppModule, { logger: false });
  process.once('disconnect', async () => {
    await app.close();
    process.exit(0);
  });
  await app.init();
  const store = app.get(DatabaseService);
  const db = store.db;
  const count = Number(process.env.HR_PERF_EMPLOYEES);
  const schedules = db
    .prepare('SELECT data FROM schedules ORDER BY rowid')
    .all()
    .map((row) => JSON.parse(row.data));
  const employeeIds = Array.from({ length: count }, () => randomUUID());
  const days = [];
  for (
    let date = new Date('2026-07-01T00:00:00Z');
    date < new Date('2026-10-01T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + 1)
  )
    if (date.getUTCDay() < 5) days.push(date.toISOString().slice(0, 10));
  const employeeInsert = db.prepare(
    'INSERT INTO employees VALUES (?, ?, ?, ?)',
  );
  const assignmentInsert = db.prepare(
    'INSERT INTO employee_schedules VALUES (?, ?, ?)',
  );
  const attendanceInsert = db.prepare(
    'INSERT INTO attendance VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const requestInsert = db.prepare(
    'INSERT INTO employee_requests VALUES (?, ?, ?, ?)',
  );
  const salesInsert = db.prepare(
    'INSERT INTO sales_activities VALUES (?, ?, ?, ?, ?)',
  );
  const deductionInsert = db.prepare(
    'INSERT INTO payroll_deductions VALUES (?, ?, ?, ?)',
  );
  const admin = db
    .prepare("SELECT id, name FROM users WHERE role = 'admin'")
    .get();
  store.transaction(() => {
    for (let index = 0; index < count; index++) {
      const id = employeeIds[index];
      const salesEnabled = index % 4 === 0;
      const schedule = schedules[salesEnabled ? 1 : 0];
      const department = salesEnabled ? 'Sales' : `Operations ${index % 5}`;
      const managerIndex = Math.floor(index / 10) * 10;
      const employee = {
        id,
        nationalId: `PERF-${index}`,
        employeeNumber: `EMP-${String(index + 1).padStart(6, '0')}`,
        name: `Performance Employee ${index}`,
        email: `perf-${index}@test.local`,
        department,
        jobTitle: salesEnabled
          ? 'Sales representative'
          : 'Operations specialist',
        startDate: '2026-01-01',
        scheduleId: schedule.id,
        active: true,
        salesEnabled,
        role: index === managerIndex ? 'manager' : 'employee',
        managerId: index === managerIndex ? null : employeeIds[managerIndex],
        monthlySalary: 12000 + (index % 10) * 1000,
        salaryCurrency: 'EGP',
      };
      employeeInsert.run(
        id,
        employee.nationalId,
        employee.email,
        JSON.stringify(employee),
      );
      db.prepare('INSERT OR IGNORE INTO departments VALUES (?)').run(
        department,
      );
      assignmentInsert.run(id, '2026-01-01', schedule.id);
      const leaveDay = '2026-09-15';
      for (const day of days) {
        if (day === leaveDay) continue;
        const hour = salesEnabled ? '08' : '07';
        attendanceInsert.run(
          randomUUID(),
          id,
          day,
          `${day}T${hour}:${index % 10 === 0 ? '20' : '00'}:00.000Z`,
          `${day}T${salesEnabled ? '16' : '15'}:00:00.000Z`,
          JSON.stringify(schedule),
          'Africa/Cairo',
        );
      }
      for (let number = 0; number < 4; number++) {
        const status = ['approved', 'rejected', 'withdrawn', 'pending'][number];
        const from =
          number === 0
            ? leaveDay
            : `2026-${number === 3 ? '10' : '09'}-${String(16 + number).padStart(2, '0')}`;
        const request = {
          id: randomUUID(),
          employeeId: id,
          employeeName: employee.name,
          nationalId: employee.nationalId,
          type: number === 1 ? 'unpaid' : 'leave',
          from,
          to: from,
          reason: 'Performance fixture request',
          status,
          submittedAt: '2026-09-01T07:00:00.000Z',
          decidedAt: number < 2 ? '2026-09-02T07:00:00.000Z' : null,
          decidedBy: number < 2 ? admin.name : null,
          decisionReason: number < 2 ? 'Fixture decision' : null,
          salaryDeductionDays: number === 1 ? 1 : null,
          attendance: null,
          managerReview: null,
        };
        requestInsert.run(request.id, id, status, JSON.stringify(request));
      }
      const deduction = {
        id: randomUUID(),
        employeeId: id,
        month: '2026-09',
        days: 0.5,
        reason: 'Fixture deduction',
        recordedAt: '2026-09-02T07:00:00.000Z',
        recordedBy: admin.name,
        recordedById: admin.id,
      };
      deductionInsert.run(
        deduction.id,
        id,
        deduction.month,
        JSON.stringify(deduction),
      );
      if (!salesEnabled) continue;
      for (const month of ['2026-07', '2026-08', '2026-09']) {
        for (let number = 0; number < 20; number++) {
          const status =
            number % 5 === 0
              ? 'pending'
              : number % 5 === 1
                ? 'returned'
                : 'verified';
          const deal = number % 4 === 0;
          const activity = {
            id: randomUUID(),
            employeeId: id,
            activityDate: `${month}-${String(number + 1).padStart(2, '0')}`,
            clientName: `Client ${number}`,
            projectName: 'Fixture development',
            propertyReference: `UNIT-${number}`,
            notes: 'Performance fixture',
            submittedAt: `${month}-21T07:00:00.000Z`,
            updatedAt: `${month}-22T07:00:00.000Z`,
            revision: 1,
            status,
            review:
              status === 'pending'
                ? null
                : {
                    status,
                    reason: 'Fixture review',
                    by: admin.name,
                    byId: admin.id,
                    at: `${month}-22T07:00:00.000Z`,
                  },
            ...(deal
              ? {
                  kind: 'closed-deal',
                  dealReference: `${index}-${month}-${number}`,
                  transactionType: 'sale',
                  value: 1500000,
                  currency: 'EGP',
                }
              : {
                  kind: number % 2 ? 'meeting' : 'viewing',
                  purpose: 'Discuss property',
                  outcome: 'Follow-up planned',
                  followUpDate: null,
                }),
          };
          salesInsert.run(
            activity.id,
            id,
            activity.activityDate,
            deal ? activity.dealReference : null,
            JSON.stringify(activity),
          );
        }
        db.prepare('INSERT INTO sales_targets VALUES (?, ?, ?)').run(
          id,
          month,
          JSON.stringify({
            employeeId: id,
            month,
            meetings: 20,
            deals: 5,
            transactionValue: 5000000,
            currency: 'EGP',
            reason: 'Fixture target',
            revision: 1,
            updatedAt: `${month}-01T07:00:00.000Z`,
            updatedBy: admin.name,
          }),
        );
      }
    }
  });
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('employee_number_sequence', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(count));
  const counts = Object.fromEntries(
    [
      'employees',
      'attendance',
      'employee_requests',
      'sales_activities',
      'payroll_deductions',
    ].map((table) => [
      table,
      Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
    ]),
  );
  assert.equal(counts.employees, count);
  assert.equal(counts.employee_requests, count * 4);
  assert.equal(counts.attendance, count * (days.length - 1));
  let profile;
  const statementPrototype = Object.getPrototypeOf(db.prepare('SELECT 1'));
  const methods = ['get', 'all', 'run'];
  const originalMethods = new Map(
    methods.map((method) => [method, statementPrototype[method]]),
  );
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  let cpuStart;
  process.on('message', async (message) => {
    if (message === 'profile-start') {
      profile = { statements: 0, sqlMs: 0 };
      for (const method of methods)
        statementPrototype[method] = function (...parameters) {
          const start = performance.now();
          try {
            return originalMethods.get(method).apply(this, parameters);
          } finally {
            profile.statements++;
            profile.sqlMs += performance.now() - start;
          }
        };
      process.send({ type: 'profile-ready' });
    } else if (message === 'profile-stop') {
      for (const method of methods)
        statementPrototype[method] = originalMethods.get(method);
      process.send({ type: 'profile', ...profile });
    } else if (message === 'metrics-start') {
      loopDelay.reset();
      loopDelay.enable();
      cpuStart = process.cpuUsage();
      process.send({ type: 'metrics-ready' });
    } else if (message === 'metrics-stop') {
      const cpu = process.cpuUsage(cpuStart);
      loopDelay.disable();
      process.send({
        type: 'metrics',
        serverCpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(2)),
        eventLoopP95Ms: Number((loopDelay.percentile(95) / 1e6).toFixed(2)),
        eventLoopMaxMs: Number((loopDelay.max / 1e6).toFixed(2)),
        rssMiB: Number((process.memoryUsage().rss / 1048576).toFixed(2)),
      });
    } else if (message === 'stop') {
      await app.close();
      process.exit(0);
    }
  });
  await app.listen(0, '127.0.0.1');
  const queryPlans = {
    attendance: db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM attendance WHERE employee_id IN (SELECT value FROM json_each(?)) AND work_date >= ? AND work_date <= ?',
      )
      .all(JSON.stringify(employeeIds), '2026-07-01', '2026-09-30')
      .map((row) => row.detail),
    sales: db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT data FROM sales_activities WHERE activity_date >= ? AND activity_date < date(?, '+1 month') AND employee_id IN (SELECT value FROM json_each(?)) ORDER BY activity_date DESC, rowid DESC",
      )
      .all('2026-09-01', '2026-09-01', JSON.stringify(employeeIds))
      .map((row) => row.detail),
  };
  process.send({ type: 'ready', base: await app.getUrl(), counts, queryPlans });
}

function message(child, type) {
  return new Promise((fulfill, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for ${type}`)),
      120000,
    );
    const onMessage = (value) => {
      if (value.type === type) finish(null, value);
    };
    const onExit = (code) =>
      finish(new Error(`Backend exited with code ${code} before ${type}`));
    const onError = (error) => finish(error);
    function finish(error, value) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else fulfill(value);
    }
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function benchmark() {
  const reportPath = resolve(
    process.argv[2] ?? '../artifacts/api-performance.json',
  );
  assert.ok(reportPath.endsWith('.json'), 'Report path must end with .json');
  const directory = await mkdtemp(join(tmpdir(), 'hr-api-performance-'));
  const password = randomBytes(24).toString('hex');
  const results = [];
  const datasets = {};
  const queryPlans = {};
  const keepAlive = process.env.HR_PERF_KEEP_ALIVE === 'true';
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const current = child;
    const exited = new Promise((resolveExit) =>
      current.once('exit', resolveExit),
    );
    if (current.connected) current.send('stop');
    else current.kill();
    const timer = setTimeout(() => current.kill(), 10000);
    await exited;
    clearTimeout(timer);
  }
  const interrupt = () => {
    if (child) child.kill();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    for (const employees of [100, 500]) {
      for (const cache of [false, true]) {
        child = fork(script, ['--server'], {
          cwd: resolve(dirname(script), '..'),
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          env: {
            ...process.env,
            NODE_ENV: 'production',
            HR_DATABASE_PATH: join(directory, `${employees}-${cache}.sqlite`),
            HR_ADMIN_EMAIL: 'performance-admin@test.local',
            HR_ADMIN_PASSWORD: password,
            HR_READ_CACHE: String(cache),
            HR_PERF_EMPLOYEES: String(employees),
          },
        });
        const {
          base,
          counts,
          queryPlans: plans,
        } = await message(child, 'ready');
        datasets[employees] = counts;
        queryPlans[employees] = plans;
        let token;
        async function call(path, body) {
          const start = performance.now();
          const response = await fetch(`${base}/api${path}`, {
            method: body ? 'POST' : 'GET',
            headers: {
              ...(keepAlive ? {} : { Connection: 'close' }),
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(120000),
          });
          const text = await response.text();
          const value = JSON.parse(text);
          assert.equal(response.ok, true, `${path}: HTTP ${response.status}`);
          return {
            value,
            ms: performance.now() - start,
            bytes: Buffer.byteLength(text),
            wireBytes: Number(
              response.headers.get('content-length') ?? Buffer.byteLength(text),
            ),
            contentEncoding:
              response.headers.get('content-encoding') ?? 'identity',
          };
        }
        token = (
          await call('/auth/login', {
            email: 'performance-admin@test.local',
            password,
          })
        ).value.token;
        for (const [endpoint, path] of endpoints) {
          const cold = await call(path);
          assert.ok(Array.isArray(cold.value), `${endpoint} must return rows`);
          if (endpoint === 'Employees' || endpoint === 'Payroll preview')
            assert.equal(cold.value.length, employees);
          if (endpoint === 'Sales performance') {
            assert.equal(cold.value.length, employees / 4);
            assert.equal(cold.value[0].meetingTotal, 9);
            assert.equal(cold.value[0].deals, 3);
          }
          if (endpoint === 'Attendance month') {
            assert.equal(cold.value.length, employees * 22);
            assert.equal(
              cold.value.filter((row) => row.status === 'Approved leave')
                .length,
              employees,
            );
          }
          await call(path);
          await call(path);
          for (const concurrency of [1, 10]) {
            const metricsReady = message(child, 'metrics-ready');
            child.send('metrics-start');
            await metricsReady;
            let next = 0;
            const times = [];
            const failures = [];
            const started = performance.now();
            await Promise.all(
              Array.from({ length: concurrency }, async () => {
                while (next++ < 30) {
                  try {
                    const sample = await call(path);
                    assert.equal(sample.value.length, cold.value.length);
                    times.push(sample.ms);
                  } catch (error) {
                    failures.push(error.cause?.code ?? error.message);
                  }
                }
              }),
            );
            const elapsed = performance.now() - started;
            const metricsFinished = message(child, 'metrics');
            child.send('metrics-stop');
            const { type: _type, ...metrics } = await metricsFinished;
            times.sort((a, b) => a - b);
            const percentile = (fraction) =>
              times.length
                ? Number(
                    times[Math.ceil(times.length * fraction) - 1].toFixed(2),
                  )
                : null;
            results.push({
              employees,
              cache,
              endpoint,
              concurrency,
              samples: times.length,
              failed: failures.length,
              errors: failures.join('; '),
              ...metrics,
              rows: cold.value.length,
              responseBytes: cold.bytes,
              wireBytes: cold.wireBytes,
              contentEncoding: cold.contentEncoding,
              firstReadMs: Number(cold.ms.toFixed(2)),
              medianMs: percentile(0.5),
              p95Ms: percentile(0.95),
              maxMs: percentile(1),
              requestsPerSecond: Number(
                ((times.length * 1000) / elapsed).toFixed(2),
              ),
            });
          }
          const waiting = message(child, 'profile-ready');
          child.send('profile-start');
          await waiting;
          const profiled = await call(path);
          const finished = message(child, 'profile');
          child.send('profile-stop');
          const profile = await finished;
          for (const row of results.filter(
            (row) =>
              row.employees === employees &&
              row.cache === cache &&
              row.endpoint === endpoint,
          ))
            Object.assign(row, {
              sqlStatements: profile.statements,
              sqlMs: Number(profile.sqlMs.toFixed(2)),
              profiledRequestMs: Number(profiled.ms.toFixed(2)),
            });
          console.log(
            `${employees} employees, cache ${cache ? 'on' : 'off'}, ${endpoint}: median ${results.at(-2).medianMs}ms; concurrent p95 ${results.at(-1).p95Ms}ms; ${profile.statements} SQL statements`,
          );
          await mkdir(dirname(reportPath), { recursive: true });
          await writeFile(
            reportPath,
            JSON.stringify({ complete: false, datasets, results }, null, 2) +
              '\n',
          );
        }
        await stop();
        child = undefined;
      }
    }
    const report = {
      complete: true,
      measuredAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      cpu: cpus()[0]?.model,
      datasets,
      queryPlans,
      keepAlive,
      methodology: `Separate client/backend processes; compiled production-mode NestJS; temporary file-backed SQLite; synthetic fixtures seeded outside timing; authenticated localhost REST over ${keepAlive ? 'persistent' : 'fresh'} connections; no retries; timings include full response download and JSON parsing; 3 priming reads (first recorded separately); 30 requests per endpoint/concurrency/cache/workload; failures recorded separately and excluded from latency percentiles; separate SQL profiling counts all statement get/all/run executions, including already-prepared cache change counters. CPU, event-loop delay and end-of-phase RSS describe the backend process during each timed condition.`,
      results,
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    const columns = Object.keys(results[0]);
    await writeFile(
      reportPath.replace(/\.json$/, '.csv'),
      [
        columns.join(','),
        ...results.map((row) =>
          columns
            .map((column) => `"${String(row[column]).replaceAll('"', '""')}"`)
            .join(','),
        ),
      ].join('\n') + '\n',
    );
    console.log(
      `${results.length * 30} timed requests; ${results.reduce((sum, row) => sum + row.failed, 0)} failed; report saved to ${reportPath}`,
    );
    assert.equal(
      results.reduce((sum, row) => sum + row.failed, 0),
      0,
      'Timed requests failed; inspect saved report',
    );
  } finally {
    await stop();
    // Delete only this run's resolved temporary directory, never an existing database.
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(
      directory.startsWith(join(resolve(tmpdir()), 'hr-api-performance-')),
    );
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    await assert.rejects(access(directory), { code: 'ENOENT' });
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    console.log('Cleanup verified: isolated databases removed.');
  }
}

try {
  if (process.argv[2] === '--server') await server();
  else await benchmark();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (process.argv[2] === '--server') process.exit(1);
}
