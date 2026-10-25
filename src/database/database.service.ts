import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types, type PoolClient } from 'pg';
import { z } from 'zod';
import { MIGRATIONS } from './postgres/migrations.js';
import type { Actor } from '../common/types/actor.type.js';
import { localTime } from '../attendance/attendance-time.js';

export type SqlValue = string | number | bigint | boolean | Uint8Array | null;
export type DatabaseRow = Record<string, SqlValue>;
export type QueryDatabase = Pick<DatabaseService, 'prepare'>;
type Context = {
  companyId: string;
  client?: PoolClient;
  actor?: Actor;
  sessionHash?: string;
  personal?: boolean;
  grants?: string;
};
export const companyContext = new AsyncLocalStorage<Context>();

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  readonly db = this;
  private readonly readCache = new Map<
    string,
    { revision: string; value: string; expires: number }
  >();

  constructor() {
    if (!process.env.HR_PG_URL)
      throw new Error('Set HR_PG_URL; SQLite is never migrated automatically');
    this.pool = new Pool({
      connectionString: process.env.HR_PG_URL,
      connectionTimeoutMillis: 5000,
      types: {
        getTypeParser: (oid, format) =>
          oid === 20
            ? (value: string) => {
                const number = Number(value);
                if (!Number.isSafeInteger(number))
                  throw new RangeError(
                    'PostgreSQL integer exceeds JavaScript safe range',
                  );
                return number;
              }
            : types.getTypeParser(oid, format),
      },
    });
    this.pool.on('error', () =>
      console.error('An idle PostgreSQL connection failed'),
    );
  }

  async onModuleInit() {
    const role = await this.pool.query(
      'SELECT rolsuper OR rolbypassrls OR rolcreaterole AS unsafe FROM pg_roles WHERE rolname=current_user',
    );
    if (role.rows[0]?.unsafe !== false)
      throw new Error('HR_PG_URL must use a restricted runtime role');
    const version = await this.pool.query(
      'SELECT hr_schema_version() AS version',
    );
    if (version.rows[0]?.version !== MIGRATIONS.at(-1)!.version)
      throw new Error(
        'PostgreSQL schema version does not match this application; run explicit migrations',
      );
  }

  get companyId() {
    const context = companyContext.getStore();
    if (!context) throw new Error('A verified company context is required');
    return context.companyId;
  }

  withCompany<T>(companyId: string, work: () => Promise<T>): Promise<T> {
    z.uuid().parse(companyId);
    const current = companyContext.getStore();
    if (current?.companyId === companyId) return work();
    if (current?.client)
      throw new Error('Cannot switch companies inside a transaction');
    return companyContext.run({ companyId }, work);
  }

  withSession<T>(
    actor: Actor,
    sessionHash: string,
    work: () => Promise<T>,
    personal = false,
    checkResponse = true,
  ): Promise<T> {
    return companyContext.run(
      { companyId: actor.companyId, actor, sessionHash, personal },
      async () => {
        const context = companyContext.getStore()!;
        context.grants = await this.grantSignature(actor);
        const result = await work();
        if (checkResponse) await this.transaction(async () => undefined, true);
        return result;
      },
    );
  }

  personal<T>(work: () => Promise<T>): Promise<T> {
    const context = companyContext.getStore();
    if (!context || context.client)
      throw new Error(
        'Personal reads require an independent scoped transaction',
      );
    return companyContext.run({ ...context, personal: true }, work);
  }

  private async grantSignature(actor: Actor) {
    if (actor.role !== 'hr') return '';
    const result = await this.pool.query(
      'SELECT hr_grant_signature($1,$2) AS signature',
      [actor.companyId, actor.id],
    );
    return result.rows[0].signature as string;
  }

  async workspaceCompany(workspace: string): Promise<string | null> {
    return (
      await this.pool.query('SELECT hr_workspace_company($1) AS id', [
        workspace,
      ])
    ).rows[0].id;
  }

  async sessionActor(hash: string, at: string) {
    return (
      await this.pool.query('SELECT * FROM hr_session_actor($1,$2)', [hash, at])
    ).rows[0] as DatabaseRow | undefined;
  }

  async activeCompanyIds(): Promise<string[]> {
    return (
      await this.pool.query('SELECT hr_active_companies() AS id')
    ).rows.map((row) => row.id as string);
  }

  prepare(sql: string) {
    // Bind markers are numbered here so optional filter fragments keep their parameter order.
    let parameter = 0;
    const text = sql.replace(/\?/g, () => `$${++parameter}`);
    const execute = async (values: SqlValue[]) => {
      const context = companyContext.getStore();
      if (!context) throw new Error('A verified company context is required');
      if (context.client)
        return context.client.query<DatabaseRow>(text, values);
      return this.transaction(
        async () =>
          companyContext.getStore()!.client!.query<DatabaseRow>(text, values),
        /^\s*(SELECT|EXPLAIN)\b/i.test(text),
      );
    };
    return {
      get: async (...values: SqlValue[]) => (await execute(values)).rows[0],
      all: async (...values: SqlValue[]) => (await execute(values)).rows,
      run: async (...values: SqlValue[]) => ({
        changes: (await execute(values)).rowCount ?? 0,
      }),
    };
  }

  async cachedRead<T>(key: string, load: () => T | Promise<T>): Promise<T> {
    if (
      companyContext.getStore()?.client ||
      process.env.HR_READ_CACHE === 'false'
    )
      return load();
    const revision = String(
      (await this.prepare('SELECT hr_company_revision() AS revision').get())!
        .revision,
    );
    const cacheKey = JSON.stringify([this.companyId, key]);
    const now = performance.now();
    const cached = this.readCache.get(cacheKey);
    if (cached && cached.revision === revision && cached.expires > now)
      return JSON.parse(cached.value) as T;
    this.readCache.delete(cacheKey);
    const value = JSON.stringify(await load());
    if (this.readCache.size >= 256)
      this.readCache.delete(this.readCache.keys().next().value!);
    this.readCache.set(cacheKey, { revision, value, expires: now + 60000 });
    return JSON.parse(value) as T;
  }

  async nextEmployeeNumber() {
    const row = await this.prepare(
      `INSERT INTO settings(key,value) VALUES('employee_number_sequence','1')
      ON CONFLICT(company_id,key) DO UPDATE SET value=(settings.value::bigint+1)::text RETURNING value`,
    ).get();
    return `EMP-${String(row!.value).padStart(6, '0')}`;
  }

  snapshot<T>(work: () => Promise<T>): Promise<T> {
    return this.transaction(work, true);
  }

  async transaction<T>(
    work: () => T | Promise<T>,
    readOnly = false,
  ): Promise<T> {
    const context = companyContext.getStore();
    if (!context) throw new Error('A verified company context is required');
    if (context.client) return work();
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query(
        readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
      );
      await client.query("SELECT set_config('hr.company_id',$1,true)", [
        context.companyId,
      ]);
      // Preserve SQLite's serialized writes, now independently for each company.
      if (!readOnly)
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [context.companyId],
        );
      const company = await client.query(
        `SELECT status,timezone FROM companies WHERE id=$1 ${readOnly ? '' : 'FOR SHARE'}`,
        [context.companyId],
      );
      if (company.rows[0]?.status !== 'active')
        throw new ServiceUnavailableException('Company access is unavailable');
      await client.query(
        `SELECT set_config('hr.actor_id',$1,true),set_config('hr.actor_role',$2,true),
        set_config('hr.personal',$3,true),set_config('hr.today',$4,true)`,
        [
          context.actor?.id ?? '',
          context.actor?.role ?? '',
          String(context.personal ?? false),
          localTime(new Date(), company.rows[0].timezone).date,
        ],
      );
      if (context.actor) {
        const user = await client.query(
          `SELECT u.role,u.employee_id FROM users u JOIN sessions s
          ON (s.company_id,s.user_id)=(u.company_id,u.id)
          WHERE u.id=$1 AND u.active=1 AND s.hash=$2 AND s.expires>$3`,
          [context.actor.id, context.sessionHash, new Date().toISOString()],
        );
        if (!user.rows[0]) throw new UnauthorizedException('Please sign in');
        if (
          user.rows[0].role !== context.actor.role ||
          user.rows[0].employee_id !== context.actor.employeeId
        )
          throw new ForbiddenException('Your access changed. Sign in again.');
        if (context.actor.role === 'hr') {
          const grants = await client.query(
            'SELECT hr_grant_signature($1,$2) AS signature',
            [context.companyId, context.actor.id],
          );
          if (grants.rows[0].signature !== context.grants)
            throw new ForbiddenException(
              'Your branch access changed. Refresh and try again.',
            );
        }
      }
      const result = await companyContext.run({ ...context, client }, work);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
