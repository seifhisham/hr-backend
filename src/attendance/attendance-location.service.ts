import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { getDistance } from 'geolib';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../common/types/actor.type.js';
import { parse } from '../common/validation/parse.js';
import { DatabaseService } from '../database/database.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { CompanyService } from '../company/company.service.js';

export const trackingPolicy = Object.freeze({
  radiusMeters: 150,
  graceSeconds: 300,
  updateIntervalSeconds: 30,
  staleAfterSeconds: 90,
  maxCaptureAgeSeconds: 60,
  maxAccuracyMeters: 50,
  confirmationSeconds: 15,
});
export const locationSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracyMeters: z.number().positive(),
      capturedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);
type LocationInput = z.infer<typeof locationSchema>;
type Tracking = {
  status: 'inside' | 'outside' | 'unavailable' | 'auto-checked-out';
  lastCapturedAt: string | null;
  outsideSince: string | null;
  returnBy: string | null;
  distanceMeters: number | null;
  accuracyMeters: number | null;
  autoCheckedOutAt: string | null;
  actor: Actor;
};

@Injectable()
export class AttendanceLocationService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(AttendanceLocationService.name);
  constructor(
    @Inject(CompanyService) private readonly company: CompanyService,
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(EmployeesService) private readonly employees: EmployeesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  policy() {
    const settings = this.company.settings();
    return { ...trackingPolicy, radiusMeters: settings.trackingRadiusMeters, graceSeconds: settings.trackingGraceMinutes * 60 };
  }

  onModuleInit() {
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        this.logger.error('Attendance location processing failed');
      }
    }, 10000);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }

  start(id: string, actor: Actor) {
    this.save(id, {
      status: 'unavailable',
      lastCapturedAt: null,
      outsideSince: null,
      returnBy: null,
      distanceMeters: null,
      accuracyMeters: null,
      autoCheckedOutAt: null,
      actor,
    });
  }
  reset(id: string) {
    this.store.db
      .prepare('DELETE FROM attendance_location WHERE attendance_id = ?')
      .run(id);
  }
  private load(id: string): Tracking | null {
    const row = this.store.db
      .prepare('SELECT data FROM attendance_location WHERE attendance_id = ?')
      .get(id);
    return row ? (JSON.parse(row.data as string) as Tracking) : null;
  }
  private save(id: string, state: Tracking) {
    this.store.db
      .prepare(
        'INSERT INTO attendance_location VALUES (?, ?) ON CONFLICT(attendance_id) DO UPDATE SET data = excluded.data',
      )
      .run(id, JSON.stringify(state));
  }
  private unavailable(state: Tracking) {
    state.status = 'unavailable';
    state.outsideSince = null;
    state.returnBy = null;
  }
  private stale(state: Tracking, now: number) {
    return (
      !state.lastCapturedAt ||
      now - Date.parse(state.lastCapturedAt) >
        trackingPolicy.staleAfterSeconds * 1000
    );
  }
  view(id: string) {
    const state = this.load(id);
    return this.present(state, Date.now());
  }
  views(employeeIds: string[], from: string, to: string) {
    const now = Date.now();
    return new Map(
      this.store.db
        .prepare(
          'SELECT l.attendance_id, l.data FROM attendance_location l JOIN attendance a ON a.id = l.attendance_id WHERE a.employee_id IN (SELECT value FROM json_each(?)) AND a.work_date >= ? AND a.work_date <= ?',
        )
        .all(JSON.stringify(employeeIds), from, to)
        .map((row) => [
          row.attendance_id as string,
          this.present(JSON.parse(row.data as string) as Tracking, now),
        ]),
    );
  }
  private present(state: Tracking | null, now: number) {
    if (!state) return null;
    if (state.status !== 'auto-checked-out' && this.stale(state, now))
      this.unavailable(state);
    return this.publicState(state);
  }
  update(actor: Actor, id: string, body: unknown) {
    const input = parse(locationSchema, body);
    const employee = this.employees.employeeActor(actor);
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare(
          'SELECT check_out FROM attendance WHERE id = ? AND employee_id = ?',
        )
        .get(id, employee.id);
      if (!row) throw new NotFoundException('Attendance record not found');
      if (row.check_out)
        throw new ConflictException('Attendance is already checked out');
      let state = this.load(id);
      if (!state) {
        this.start(id, actor);
        state = this.load(id)!;
      }
      const now = Date.now();
      if (this.stale(state, now)) this.unavailable(state);
      this.apply(state, input, now);
      state.actor = actor;
      this.save(id, state);
      return this.view(id);
    });
  }
  private apply(state: Tracking, input: LocationInput, now: number) {
    if (!input.available) {
      this.unavailable(state);
      return;
    }
    const policy = this.policy();
    const captured = Date.parse(input.capturedAt);
    if (
      captured > now ||
      now - captured > trackingPolicy.maxCaptureAgeSeconds * 1000
    )
      throw new ConflictException(
        'Location must be fresh and not in the future',
      );
    if (state.lastCapturedAt && captured <= Date.parse(state.lastCapturedAt))
      throw new ConflictException(
        'Location updates must arrive in capture order',
      );
    // A delayed sample cannot hide a gap in reliable coverage.
    if (
      state.lastCapturedAt &&
      captured - Date.parse(state.lastCapturedAt) >
        trackingPolicy.staleAfterSeconds * 1000
    )
      this.unavailable(state);
    state.lastCapturedAt = new Date(captured).toISOString();
    state.distanceMeters = getDistance(input, this.company.settings(), 0.01);
    state.accuracyMeters = input.accuracyMeters;
    if (input.accuracyMeters > trackingPolicy.maxAccuracyMeters) {
      this.unavailable(state);
      return;
    }
    if (
      state.distanceMeters + input.accuracyMeters <=
      policy.radiusMeters
    ) {
      state.status = 'inside';
      state.outsideSince = null;
      state.returnBy = null;
    } else if (
      state.distanceMeters - input.accuracyMeters >
      policy.radiusMeters
    ) {
      state.status = 'outside';
      if (!state.outsideSince) state.outsideSince = new Date(now).toISOString();
      else if (
        !state.returnBy &&
        now - Date.parse(state.outsideSince) >=
          trackingPolicy.confirmationSeconds * 1000
      )
        state.returnBy = new Date(
          now + policy.graceSeconds * 1000,
        ).toISOString();
    } else this.unavailable(state);
  }
  sweep() {
    this.store.transaction(() => {
      const now = Date.now();
      const rows = this.store.db
        .prepare(
          'SELECT a.id, l.data FROM attendance a JOIN attendance_location l ON l.attendance_id = a.id WHERE a.check_out IS NULL',
        )
        .all();
      for (const row of rows) {
        const state = JSON.parse(row.data as string) as Tracking;
        if (this.stale(state, now)) this.unavailable(state);
        else if (
          state.status === 'outside' &&
          state.returnBy &&
          now >= Date.parse(state.returnBy)
        ) {
          const checkOut = state.returnBy;
          this.store.db
            .prepare(
              'UPDATE attendance SET check_out = ? WHERE id = ? AND check_out IS NULL',
            )
            .run(checkOut, row.id);
          state.status = 'auto-checked-out';
          state.autoCheckedOutAt = checkOut;
          this.audit.record(
            { ...state.actor, name: 'Automatic location checkout' },
            'attendance.auto_checked_out',
            row.id as string,
            { checkOut: null },
            { checkOut, location: this.publicState(state) },
            'Confirmed outside the configured office boundary after the saved return deadline',
          );
          state.returnBy = null;
        }
        if (JSON.stringify(state) !== row.data)
          this.save(row.id as string, state);
      }
    });
  }
  private publicState(state: Tracking) {
    const { actor: _actor, ...result } = state;
    return result;
  }
}
