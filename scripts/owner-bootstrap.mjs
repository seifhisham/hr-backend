import { parseArgs } from 'node:util';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { tokenHash } from '../dist/common/security/credentials.js';
import { dashboardOrigin, promptOwnerSetup } from './owner-setup-prompts.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    output: { type: 'string' },
    'base-url': { type: 'string' },
    interactive: { type: 'boolean', default: false },
  },
});
let pool, createdFile;
try {
  if (values.interactive) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        'Interactive setup needs a terminal. Run bash scripts/create-owner.sh over SSH.',
      );
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let setup;
    try {
      setup = await promptOwnerSetup(
        terminal.question.bind(terminal),
        values['base-url'] ??
          (process.env.HR_DOMAIN ? `https://${process.env.HR_DOMAIN}` : ''),
        (message) => process.stdout.write(message),
      );
    } finally {
      terminal.close();
    }
    if (!setup) {
      console.log('Cancelled. No account or setup link was created.');
      process.exit(0);
    }
    values.email = setup.email;
    values['base-url'] = setup.origin;
    values.output ??= `/private/owner-setup-${randomUUID()}.json`;
  }
  const email = z.email().trim().toLowerCase().max(254).parse(values.email);
  if (!values.output || !values['base-url'])
    throw new Error('Specify --email, --output and --base-url.');
  const url = new URL(dashboardOrigin(values['base-url']));
  if (
    !process.env.HR_PG_MIGRATION_URL ||
    !/^[a-f0-9]{64}$/i.test(process.env.HR_OWNER_ENCRYPTION_KEY ?? '')
  )
    throw new Error('Configure migration URL and owner encryption key.');
  const output = resolve(values.output);
  if (existsSync(output)) throw new Error('Output must be a new private file.');
  pool = new Pool({
    connectionString: process.env.HR_PG_MIGRATION_URL,
    connectionTimeoutMillis: 5000,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(715104,2)');
    if (
      (await client.query('SELECT max(version) version FROM schema_migrations'))
        .rows[0].version < 4
    )
      throw new Error('Apply migration 4 first.');
    const owners = await client.query(
      'SELECT id,email,password_hash FROM platform_owners FOR UPDATE',
    );
    if (
      owners.rows.some((owner) => owner.password_hash || owner.email !== email)
    )
      throw new Error('Owner already exists; use MFA recovery instead.');
    const token = randomBytes(32).toString('base64url'),
      expiresAt = new Date(Date.now() + 3600000).toISOString();
    const id = owners.rows[0]?.id ?? randomUUID();
    await client.query(
      `INSERT INTO platform_owners(id,email,name,setup_hash,setup_expires) VALUES($1,$2,'Platform Owner',$3,$4)
    ON CONFLICT(id) DO UPDATE SET setup_hash=excluded.setup_hash,setup_expires=excluded.setup_expires,setup_failures=0`,
      [id, email, tokenHash(token), expiresAt],
    );
    await client.query(
      "INSERT INTO platform_audit(owner_id,action) VALUES($1,'owner.bootstrap_started')",
      [id],
    );
    writeFileSync(
      output,
      JSON.stringify(
        {
          email,
          setupUrl: url.origin + '/owner/setup#token=' + token,
          expiresAt,
          instructions:
            'Open privately. Set a unique password, add the displayed key to your authenticator, verify its code, and save the recovery codes. No email was sent.',
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    createdFile = output;
    await client.query('COMMIT');
    console.log(
      'Owner setup link saved to the requested private file. It expires in one hour; no email was sent.',
    );
    if (values.interactive) {
      console.log(
        `\nNEXT: Open this private link in your browser:\n\n${url.origin}/owner/setup#token=${token}\n\nChoose your name and password, scan the authenticator QR code, and save your recovery codes.\nThen sign in at ${url.origin}/owner with a fresh authenticator code.\n\nKeep this terminal private: the link grants owner setup access for one hour.\nA private copy is saved at ${output} (the /private directory is .secrets on the server).`,
      );
    }
  } catch (error) {
    await client.query('ROLLBACK');
    if (createdFile) unlinkSync(createdFile);
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  if (values.interactive) {
    console.error('\nOwner setup did not finish.');
    if (
      error instanceof Error &&
      [
        'Owner already exists; use MFA recovery instead.',
        'Apply migration 4 first.',
        'Configure migration URL and owner encryption key.',
        'Interactive setup needs a terminal. Run bash scripts/create-owner.sh over SSH.',
      ].includes(error.message)
    )
      console.error(error.message);
    else
      console.error(
        'Check that PostgreSQL is running, migrations are applied, and the private setup directory is writable.',
      );
  }
  console.error(
    'Owner bootstrap failed. Check configuration, existing owner state and output path. No credentials or setup token printed.',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
