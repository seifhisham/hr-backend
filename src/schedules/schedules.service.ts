import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { requireAdmin } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import { DatabaseService } from '../database/database.service.js';
import type { SaveScheduleDto } from './dto/schedule.dto.js';
import type { Schedule } from './types/schedule.type.js';

@Injectable()
export class SchedulesService {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}
  private get db() {
    return this.store.db;
  }

  schedules(): Schedule[] {
    return this.db
      .prepare('SELECT data FROM schedules ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(r.data as string) as Schedule);
  }

  schedule(id: string) {
    const value = this.schedules().find((s) => s.id === id);
    if (!value) throw new BadRequestException('Schedule not found');
    return value;
  }

  saveSchedule(actor: Actor, input: SaveScheduleDto, id?: string) {
    requireAdmin(actor);
    const before = id ? this.schedule(id) : null;
    const schedule: Schedule = { ...input, id: id ?? randomUUID() };
    this.store.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO schedules VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
        )
        .run(schedule.id, JSON.stringify(schedule));
      this.auditService.record(
        actor,
        before ? 'schedule.updated' : 'schedule.created',
        schedule.id,
        before,
        schedule,
      );
    });
    return schedule;
  }
}
