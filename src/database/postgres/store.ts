import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { z } from 'zod';

// Isolated migration/load verification; Nest uses DatabaseService with request authentication.
export class PostgresStore {
  private readonly pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool({ connectionTimeoutMillis: 5000, ...config });
    this.pool.on('error', () => {
      console.error('An idle PostgreSQL connection failed');
    });
  }

  async companyTransaction<T>(
    companyId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    z.uuid().parse(companyId);
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      const role = await client.query<{ unsafe: boolean }>(`
        SELECT rolsuper OR rolbypassrls AS unsafe
        FROM pg_roles WHERE rolname = current_user
      `);
      if (role.rows[0]?.unsafe !== false)
        throw new Error(
          'Company transactions require a non-privileged PostgreSQL role',
        );
      await client.query("SELECT set_config('hr.company_id', $1, true)", [
        companyId,
      ]);
      const result = await operation(client);
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

  async close() {
    await this.pool.end();
  }
}
