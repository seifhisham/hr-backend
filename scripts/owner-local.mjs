import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { setTimeout } from 'node:timers/promises';

export function localEnvironment(backend, foundation) {
  const env = { ...backend, ...foundation };
  for (const name of ['HR_PG_URL', 'HR_PG_MIGRATION_URL']) {
    const url = new URL(env[name]);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Local setup only accepts local PostgreSQL connections.');
  }
  const runtime = new URL(env.HR_PG_URL),
    migration = new URL(env.HR_PG_MIGRATION_URL);
  if (
    runtime.hostname !== migration.hostname ||
    runtime.port !== migration.port ||
    runtime.pathname !== migration.pathname
  )
    throw new Error(
      'The runtime and migration URLs must select the same local database.',
    );
  if (
    !/^[a-f0-9]{64}$/i.test(env.HR_OWNER_ENCRYPTION_KEY ?? '') ||
    (backend.HR_OWNER_ENCRYPTION_KEY &&
      backend.HR_OWNER_ENCRYPTION_KEY !== env.HR_OWNER_ENCRYPTION_KEY)
  )
    throw new Error(
      'Local encryption keys are missing or inconsistent. Existing keys were not changed.',
    );
  return env;
}

async function healthy(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function startService(label, cwd, args, url, env, log) {
  if (await healthy(url)) {
    console.log(`${label} is already running.`);
    return;
  }
  console.log(`Starting ${label}…`);
  const fd = openSync(log, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  let failed = false;
  child.on('error', () => {
    failed = true;
  });
  child.unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    if (failed || child.exitCode !== null) break;
    if (await healthy(url)) {
      console.log(`${label} is ready.`);
      return;
    }
    await setTimeout(500);
  }
  throw new Error(`${label} did not become ready. Check ${log}.`);
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'Run npm --prefix hr-backend run owner:setup in an interactive terminal.',
    );
  const backend = fileURLToPath(new URL('..', import.meta.url));
  const root = resolve(backend, '..');
  const foundation = resolve(root, '.tmp/postgres-foundation.env');
  if (!existsSync(foundation))
    throw new Error(
      'Local database configuration is missing: .tmp/postgres-foundation.env. Complete the local PostgreSQL setup first.',
    );
  const config = localEnvironment(
    existsSync(resolve(backend, '.env'))
      ? parseEnv(readFileSync(resolve(backend, '.env'), 'utf8'))
      : {},
    parseEnv(readFileSync(foundation, 'utf8')),
  );
  const env = {
    ...process.env,
    ...config,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '3002',
    HR_ALLOWED_ORIGINS: 'http://localhost:3003',
    HR_BOOTSTRAP_COMPANY_ID: '',
  };
  const privateDir = resolve(root, '.tmp/owner-local');
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  console.log(
    '\nPreparing local owner setup. PostgreSQL must already be running.\n',
  );
  await startService(
    'Backend',
    backend,
    ['dist/main.js'],
    'http://127.0.0.1:3002/api/health',
    env,
    resolve(privateDir, 'backend.log'),
  );
  const frontend = resolve(root, 'hr-frontend');
  await startService(
    'Dashboard',
    frontend,
    [
      resolve(frontend, 'node_modules/next/dist/bin/next'),
      'dev',
      '--port',
      '3003',
    ],
    'http://localhost:3003',
    {
      ...process.env,
      NODE_ENV: 'development',
      HR_API_URL: 'http://127.0.0.1:3002',
    },
    resolve(privateDir, 'frontend.log'),
  );
  console.log(
    '\nServices stay running after this wizard. Logs: .tmp/owner-local/\n',
  );
  const child = spawn(
    process.execPath,
    [
      'scripts/owner-bootstrap.mjs',
      '--interactive',
      '--base-url',
      'http://localhost:3003',
      '--output',
      resolve(privateDir, `owner-setup-${randomUUID()}.json`),
    ],
    { cwd: backend, env, stdio: 'inherit', windowsHide: true },
  );
  await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      process.exitCode = code ?? 1;
      done();
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof TypeError
        ? 'Local database configuration is invalid. Check the local connection URLs.'
        : error.message,
    );
    process.exitCode = 1;
  });
}
