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
  private processing = false;
  constructor(
    @Inject(CompanyService)
    private readonly company: CompanyService,
    @Inject(DatabaseService)
    private readonly store: DatabaseService,
    @Inject(EmployeesService)
    private readonly employees: EmployeesService,
    @Inject(AuditService)
    private readonly audit: AuditService,
  ) {}
  async policy(id?: string) {
    const settings = id
      ? (
          JSON.parse(
            (await this.store
              .prepare('SELECT branch_snapshot FROM attendance WHERE id=?')
              .get(id))!.branch_snapshot as string,
          ) as { policy: Awaited<ReturnType<CompanyService['settings']>> }
        ).policy
      : await this.company.settings();
    return {
      ...trackingPolicy,
      radiusMeters: settings.trackingRadiusMeters,
      graceSeconds: settings.trackingGraceMinutes * 60,
    };
  }
  onModuleInit() {
    this.timer = setInterval(async () => {
      if (this.processing) return;
      this.processing = true;
      try {
        for (const companyId of await this.store.activeCompanyIds())
          await this.store.withCompany(companyId, () => this.sweep());
      } catch {
        this.logger.error('Attendance location processing failed');
      } finally {
        this.processing = false;
      }
    }, 10000);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }
  async start(id: string, actor: Actor) {
    await this.save(id, {
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
  async reset(id: string) {
    await this.store.db
      .prepare('DELETE FROM attendance_location WHERE attendance_id = ?')
      .run(id);
  }
  private async load(id: string): Promise<Tracking | null> {
    const row = await this.store.db
      .prepare('SELECT data FROM attendance_location WHERE attendance_id = ?')
      .get(id);
    return row ? (JSON.parse(row.data as string) as Tracking) : null;
  }
  private async save(id: string, state: Tracking) {
    await this.store.db
      .prepare(
        'INSERT INTO attendance_location (attendance_id,data) VALUES (?, ?) ON CONFLICT(company_id,attendance_id) DO UPDATE SET data = excluded.data',
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
  async view(id: string) {
    const state = await this.load(id);
    return this.present(state, Date.now());
  }
  async views(employeeIds: string[], from: string, to: string) {
    const now = Date.now();
    return new Map(
      (
        await this.store.db
          .prepare(
            'SELECT l.attendance_id, l.data FROM attendance_location l JOIN attendance a ON a.id = l.attendance_id WHERE a.employee_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)) AND a.work_date >= ? AND a.work_date <= ?',
          )
          .all(JSON.stringify(employeeIds), from, to)
      ).map((row) => [
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
  async update(actor: Actor, id: string, body: unknown) {
    const input = parse(locationSchema, body);
    const employee = await this.employees.employeeActor(actor);
    return await this.store.transaction(async () => {
      const row = await this.store.db
        .prepare(
          'SELECT check_out FROM attendance WHERE id = ? AND employee_id = ?',
        )
        .get(id, employee.id);
      if (!row) throw new NotFoundException('Attendance record not found');
      if (row.check_out)
        throw new ConflictException('Attendance is already checked out');
      let state = await this.load(id);
      if (!state) {
        await this.start(id, actor);
        state = (await this.load(id))!;
      }
      const now = Date.now();
      if (this.stale(state, now)) this.unavailable(state);
      await this.apply(state, input, now, id);
      state.actor = actor;
      await this.save(id, state);
      return await this.view(id);
    });
  }
  private async apply(
    state: Tracking,
    input: LocationInput,
    now: number,
    id: string,
  ) {
    if (!input.available) {
      this.unavailable(state);
      return;
    }
    const policy = await this.policy(id);
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
    state.distanceMeters = getDistance(
      input,
      (
        JSON.parse(
          (await this.store
            .prepare('SELECT branch_snapshot FROM attendance WHERE id=?')
            .get(id))!.branch_snapshot as string,
        ) as { policy: { latitude: number; longitude: number } }
      ).policy,
      0.01,
    );
    state.accuracyMeters = input.accuracyMeters;
    if (input.accuracyMeters > trackingPolicy.maxAccuracyMeters) {
      this.unavailable(state);
      return;
    }
    if (state.distanceMeters + input.accuracyMeters <= policy.radiusMeters) {
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
  async sweep() {
    await this.store.transaction(async () => {
      const now = Date.now();
      const rows = await this.store.db
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
          await this.store.db
            .prepare(
              'UPDATE attendance SET check_out = ? WHERE id = ? AND check_out IS NULL',
            )
            .run(checkOut, row.id);
          state.status = 'auto-checked-out';
          state.autoCheckedOutAt = checkOut;
          await this.audit.record(
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
          await this.save(row.id as string, state);
      }
    });
  }
  private publicState(state: Tracking) {
    const { actor: _actor, ...result } = state;
    return result;
  }
}
