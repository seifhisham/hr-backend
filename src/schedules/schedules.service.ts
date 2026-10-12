import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { requireAdmin } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import { DatabaseService } from '../database/database.service.js';
import type { SaveScheduleDto } from './dto/schedule.dto.js';
import type { Schedule } from './types/schedule.type.js';
import { CompanyService } from '../company/company.service.js';
import {
  localTime,
  shiftDate,
  workDate,
} from '../attendance/attendance-time.js';

@Injectable()
export class SchedulesService {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(CompanyService) private readonly companyService: CompanyService,
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

  today() {
    return localTime(new Date(), this.companyService.settings().timezone).date;
  }

  schedule(id: string, date?: string): Schedule {
    if (date) {
      const row = this.db
        .prepare(
          'SELECT data FROM schedule_versions WHERE schedule_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1',
        )
        .get(id, date);
      if (row) return JSON.parse(row.data as string) as Schedule;
    }
    const value = this.schedules().find((s) => s.id === id);
    if (!value) throw new BadRequestException('Schedule not found');
    return value;
  }

  assignedSchedule(employeeId: string, date: string): Schedule {
    const row =
      this.db
        .prepare(
          'SELECT schedule_id FROM employee_schedules WHERE employee_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1',
        )
        .get(employeeId, date) ??
      this.db
        .prepare(
          'SELECT schedule_id FROM employee_schedules WHERE employee_id = ? ORDER BY effective_from LIMIT 1',
        )
        .get(employeeId);
    if (!row)
      throw new BadRequestException('Employee has no schedule assignment');
    return this.schedule(row.schedule_id as string, date);
  }

  currentWorkday(employeeId: string) {
    const now = new Date();
    const timezone = this.companyService.settings().timezone;
    const today = localTime(now, timezone).date;
    const previous = shiftDate(today, -1);
    const previousSchedule = this.assignedSchedule(employeeId, previous);
    // An overnight shift belongs to its start date, even across an assignment change.
    const date =
      workDate(now, previousSchedule, timezone) === previous ? previous : today;
    return { date, schedule: this.assignedSchedule(employeeId, date) };
  }

  saveSchedule(actor: Actor, input: SaveScheduleDto, id?: string) {
    requireAdmin(actor);
    const before = id ? this.schedule(id) : null;
    const schedule: Schedule = { ...input, id: id ?? randomUUID() };
    this.store.transaction(() => {
      if (before)
        this.db
          .prepare('INSERT OR IGNORE INTO schedule_versions VALUES (?, ?, ?)')
          .run(before.id, '0001-01-01', JSON.stringify(before));
      this.db
        .prepare(
          'INSERT INTO schedules VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
        )
        .run(schedule.id, JSON.stringify(schedule));
      this.db
        .prepare(
          'INSERT INTO schedule_versions VALUES (?, ?, ?) ON CONFLICT(schedule_id, effective_from) DO UPDATE SET data = excluded.data',
        )
        .run(
          schedule.id,
          before ? this.today() : '0001-01-01',
          JSON.stringify(schedule),
        );
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
