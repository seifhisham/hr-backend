import type { AuditQuery } from './audit.dto.js';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { requireHr } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import { DatabaseService } from '../database/database.service.js';
@Injectable()
export class AuditService {
  constructor(
    @Inject(DatabaseService)
    private readonly store: DatabaseService,
  ) {}
  private get db() {
    return this.store.db;
  }
  async auditHistory(actor: Actor, recordId?: string, query?: AuditQuery) {
    requireHr(actor);
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    for (const [column, value] of [
      ['record_id', recordId],
      ['action', query?.action],
      ['actor_id', query?.actorId],
    ]) {
      if (value) {
        clauses.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (query?.before) {
      clauses.push('row_order < (SELECT row_order FROM audit WHERE id = ?)');
      values.push(query.before);
    }
    if (query?.from) {
      clauses.push('at >= ?');
      values.push(`${query.from}T00:00:00.000Z`);
    }
    if (query?.to) {
      clauses.push('at < ?');
      values.push(
        new Date(Date.parse(`${query.to}T00:00:00Z`) + 86400000).toISOString(),
      );
    }
    if (query?.search) {
      clauses.push(
        "strpos(lower(actor_name || ' ' || actor_id || ' ' || action || ' ' || record_id || ' ' || coalesce(reason, '') || ' ' || coalesce(before_data, '') || ' ' || coalesce(after_data, '')), lower(?)) > 0",
      );
      values.push(query.search);
    }
    return (
      await this.db
        .prepare(
          `SELECT * FROM audit ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY row_order DESC LIMIT ?`,
        )
        .all(...values, query?.limit ?? 100)
    ).map((r) => ({
      id: r.id,
      actor: r.actor_name,
      actorId: r.actor_id,
      action: r.action,
      recordId: r.record_id,
      at: r.at,
      reason: r.reason,
      before: r.before_data
        ? (JSON.parse(r.before_data as string) as unknown)
        : null,
      after: r.after_data
        ? (JSON.parse(r.after_data as string) as unknown)
        : null,
    }));
  }
  async record(
    actor: Actor,
    action: string,
    recordId: string,
    before: unknown,
    after: unknown,
    reason: string | null = null,
  ) {
    await this.db
      .prepare(
        'INSERT INTO audit (id,actor_id,actor_name,action,record_id,at,reason,before_data,after_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        actor.id,
        actor.name,
        action,
        recordId,
        new Date().toISOString(),
        reason,
        JSON.stringify(before),
        JSON.stringify(after),
      );
  }
}
