import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { requireHr } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class AuditService {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
  ) {}
  private get db() {
    return this.store.db;
  }

  auditHistory(actor: Actor, recordId?: string) {
    requireHr(actor);
    return (
      recordId
        ? this.db
            .prepare(
              'SELECT * FROM audit WHERE record_id = ? ORDER BY rowid DESC LIMIT 100',
            )
            .all(recordId)
        : this.db
            .prepare('SELECT * FROM audit ORDER BY rowid DESC LIMIT 100')
            .all()
    ).map((r) => ({
      id: r.id,
      actor: r.actor_name,
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

  record(
    actor: Actor,
    action: string,
    recordId: string,
    before: unknown,
    after: unknown,
    reason: string | null = null,
  ) {
    this.db
      .prepare('INSERT INTO audit VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
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
