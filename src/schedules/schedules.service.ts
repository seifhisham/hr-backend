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
    @Inject(DatabaseService)
    private readonly store: DatabaseService,
    @Inject(AuditService)
    private readonly auditService: AuditService,
    @Inject(CompanyService)
    private readonly companyService: CompanyService,
  ) {}
  private get db() {
    return this.store.db;
  }
  async schedules(): Promise<Schedule[]> {
    return await this.store.cachedRead('schedules', async () =>
      (
        await this.db
          .prepare('SELECT data FROM schedules ORDER BY row_order')
          .all()
      ).map((r) => JSON.parse(r.data as string) as Schedule),
    );
  }
  async today() {
    return localTime(
      new Date(),
      (await this.companyService.settings()).timezone,
    ).date;
  }
  async schedule(id: string, date?: string): Promise<Schedule> {
    return await this.store.cachedRead(
      JSON.stringify(['schedule', id, date ?? null]),
      async () => {
        if (date) {
          const row = await this.db
            .prepare(
              'SELECT data FROM schedule_versions WHERE schedule_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1',
            )
            .get(id, date);
          if (row) return JSON.parse(row.data as string) as Schedule;
        }
        const value = (await this.schedules()).find((s) => s.id === id);
        if (!value) throw new BadRequestException('Schedule not found');
        return value;
      },
    );
  }
  async assignedSchedule(employeeId: string, date: string): Promise<Schedule> {
    const row =
      (await this.db
        .prepare(
          'SELECT schedule_id FROM employee_schedules WHERE employee_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1',
        )
        .get(employeeId, date)) ??
      (await this.db
        .prepare(
          'SELECT schedule_id FROM employee_schedules WHERE employee_id = ? ORDER BY effective_from LIMIT 1',
        )
        .get(employeeId));
    if (!row)
      throw new BadRequestException('Employee has no schedule assignment');
    return await this.schedule(row.schedule_id as string, date);
  }
  async assignmentReader(employeeIds: string[]) {
    const assignments = new Map<
      string,
      {
        scheduleId: string;
        from: string;
      }[]
    >();
    for (const row of await this.db
      .prepare(
        'SELECT employee_id, schedule_id, effective_from FROM employee_schedules WHERE employee_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)) ORDER BY effective_from DESC',
      )
      .all(JSON.stringify(employeeIds))) {
      const employeeId = row.employee_id as string;
      const history = assignments.get(employeeId) ?? [];
      history.push({
        scheduleId: row.schedule_id as string,
        from: row.effective_from as string,
      });
      assignments.set(employeeId, history);
    }
    const schedules = new Map(
      (await this.schedules()).map((schedule) => [schedule.id, schedule]),
    );
    const versions = new Map<
      string,
      {
        from: string;
        schedule: Schedule;
      }[]
    >();
    for (const row of await this.db
      .prepare(
        'SELECT schedule_id, effective_from, data FROM schedule_versions WHERE schedule_id IN (SELECT schedule_id FROM employee_schedules WHERE employee_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))) ORDER BY effective_from DESC',
      )
      .all(JSON.stringify(employeeIds))) {
      const scheduleId = row.schedule_id as string;
      const history = versions.get(scheduleId) ?? [];
      history.push({
        from: row.effective_from as string,
        schedule: JSON.parse(row.data as string) as Schedule,
      });
      versions.set(scheduleId, history);
    }
    return (employeeId: string, date: string): Schedule => {
      const history = assignments.get(employeeId);
      const assignment =
        history?.find((value) => value.from <= date) ?? history?.at(-1);
      if (!assignment)
        throw new BadRequestException('Employee has no schedule assignment');
      const schedule =
        versions.get(assignment.scheduleId)?.find((value) => value.from <= date)
          ?.schedule ?? schedules.get(assignment.scheduleId);
      if (!schedule) throw new BadRequestException('Schedule not found');
      return schedule;
    };
  }
  async currentWorkday(employeeId: string) {
    const now = new Date();
    const timezone = (await this.companyService.settings()).timezone;
    const today = localTime(now, timezone).date;
    const previous = shiftDate(today, -1);
    const previousSchedule = await this.assignedSchedule(employeeId, previous);
    // An overnight shift belongs to its start date, even across an assignment change.
    const date =
      workDate(now, previousSchedule, timezone) === previous ? previous : today;
    return { date, schedule: await this.assignedSchedule(employeeId, date) };
  }
  async saveSchedule(actor: Actor, input: SaveScheduleDto, id?: string) {
    requireAdmin(actor);
    const before = id ? await this.schedule(id) : null;
    const schedule: Schedule = { ...input, id: id ?? randomUUID() };
    await this.store.transaction(async () => {
      if (before)
        await this.db
          .prepare(
            'INSERT INTO schedule_versions (schedule_id,effective_from,data) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
          )
          .run(before.id, '0001-01-01', JSON.stringify(before));
      await this.db
        .prepare(
          'INSERT INTO schedules (id,data) VALUES (?, ?) ON CONFLICT(company_id,id) DO UPDATE SET data = excluded.data',
        )
        .run(schedule.id, JSON.stringify(schedule));
      await this.db
        .prepare(
          'INSERT INTO schedule_versions (schedule_id,effective_from,data) VALUES (?, ?, ?) ON CONFLICT(company_id,schedule_id, effective_from) DO UPDATE SET data = excluded.data',
        )
        .run(
          schedule.id,
          before ? await this.today() : '0001-01-01',
          JSON.stringify(schedule),
        );
      await this.auditService.record(
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
