import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { AuditService } from '../audit/audit.service.js';
import { requireHr } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import { CompanyService } from '../company/company.service.js';
import { DatabaseService } from '../database/database.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import type { EmployeeRequest } from '../requests/types/employee-request.type.js';
import { SchedulesService } from '../schedules/schedules.service.js';
import type { Evidence } from './attendance-evidence.service.js';
import { AttendanceEvidence } from './attendance-evidence.service.js';
import { AttendanceLocationService } from './attendance-location.service.js';
import {
  arrivalStatus,
  attendanceStatus,
  shiftDate,
  weekday,
  workDate,
} from './attendance-time.js';
import type { AttendanceRow } from './attendance.mapper.js';
import { attendance } from './attendance.mapper.js';
import type {
  AttendanceCorrectionDto,
  AttendanceFiltersDto,
  ManualAttendanceDto,
} from './dto/attendance.dto.js';
import type { Attendance, ReportRow } from './types/attendance.type.js';

@Injectable()
export class AttendanceService {
  private reportQueue: Promise<void> = Promise.resolve();
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(AttendanceEvidence) private readonly evidence: AttendanceEvidence,
    @Inject(EmployeesService)
    private readonly employeesService: EmployeesService,
    @Inject(SchedulesService)
    private readonly schedulesService: SchedulesService,
    @Inject(CompanyService) private readonly companyService: CompanyService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(AttendanceLocationService)
    private readonly location: AttendanceLocationService,
  ) {}
  private get db() {
    return this.store.db;
  }

  myAttendance(actor: Actor) {
    const employee = this.employeesService.employeeActor(actor);
    this.location.sweep();
    const current = this.schedulesService.currentWorkday(employee.id);
    const records = this.db
      .prepare(
        'SELECT * FROM attendance WHERE employee_id = ? ORDER BY work_date DESC LIMIT 93',
      )
      .all(employee.id) as AttendanceRow[];
    return {
      employee,
      schedule: current.schedule,
      workDate: current.date,
      records: records.map((r) => ({
        ...attendance(r),
        status: attendanceStatus(attendance(r), new Date()),
        location: this.location.view(r.id),
      })),
    };
  }

  checkIn(actor: Actor, evidence: Evidence) {
    const employee = this.employeesService.employeeActor(actor);
    if (!employee.active) throw new ForbiddenException('Employee is inactive');
    return this.store.transaction(() => {
      const { schedule, date } = this.schedulesService.currentWorkday(
        employee.id,
      );
      const timezone = this.companyService.settings().timezone;
      const now = new Date();
      if (employee.startDate > date)
        throw new BadRequestException(
          'Attendance cannot start before employment begins',
        );
      const existing = this.db
        .prepare(
          'SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?',
        )
        .get(employee.id, date) as AttendanceRow | undefined;
      if (existing) return attendance(existing);
      if (
        this.db
          .prepare(
            `SELECT a.id FROM attendance a
             WHERE a.employee_id = ? AND a.check_out IS NULL
               AND (a.work_date >= ? OR NOT EXISTS (
                 SELECT 1 FROM employee_requests r
                 WHERE r.employee_id = a.employee_id AND r.status = 'pending'
                   AND json_extract(r.data, '$.type') = 'forgotten-check-out'
                   AND json_extract(r.data, '$.attendanceId') = a.id
               ))`,
          )
          .get(employee.id, date)
      )
        throw new ConflictException(
          'A previous attendance record is still open. Submit a forgotten check-out request or ask HR to correct it.',
        );
      const record: Attendance = {
        id: randomUUID(),
        employeeId: employee.id,
        workDate: date,
        checkIn: now.toISOString(),
        checkOut: null,
        schedule,
        timezone,
      };
      this.db
        .prepare('INSERT INTO attendance VALUES (?, ?, ?, ?, NULL, ?, ?)')
        .run(
          record.id,
          employee.id,
          date,
          record.checkIn,
          JSON.stringify(schedule),
          timezone,
        );
      this.evidence.save(record.id, 'check-in', evidence, record.checkIn);
      this.location.start(record.id, actor);
      this.auditService.record(
        actor,
        'attendance.checked_in',
        record.id,
        null,
        record,
      );
      return record;
    });
  }

  checkOut(actor: Actor, id: string, evidence: Evidence) {
    const employee = this.employeesService.employeeActor(actor);
    return this.store.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM attendance WHERE id = ? AND employee_id = ?')
        .get(id, employee.id) as AttendanceRow | undefined;
      if (!row) throw new NotFoundException('Attendance record not found');
      if (row.check_out) return attendance(row);
      const before = attendance(row);
      row.check_out = new Date().toISOString();
      this.db
        .prepare('UPDATE attendance SET check_out = ? WHERE id = ?')
        .run(row.check_out, row.id);
      this.evidence.save(row.id, 'check-out', evidence, row.check_out);
      this.location.reset(row.id);
      const after = attendance(row);
      this.auditService.record(
        actor,
        'attendance.checked_out',
        row.id,
        before,
        after,
      );
      return after;
    });
  }

  async report(
    actor: Actor,
    filters: AttendanceFiltersDto,
  ): Promise<ReportRow[]> {
    if (actor.role !== 'manager') requireHr(actor);
    const previous = this.reportQueue;
    let release!: () => void;
    this.reportQueue = new Promise<void>((done) => {
      release = done;
    });
    await previous;
    try {
      return await this.buildReport(actor, filters);
    } finally {
      release();
    }
  }

  private async buildReport(
    actor: Actor,
    filters: AttendanceFiltersDto,
  ): Promise<ReportRow[]> {
    if (actor.role !== 'manager') requireHr(actor);
    this.location.sweep();
    const employees = (
      actor.role === 'manager'
        ? this.employeesService.managedEmployees(actor)
        : this.employeesService.employees(actor)
    ).filter(
      (e) =>
        (!filters.employeeId || e.id === filters.employeeId) &&
        (!filters.department || e.department === filters.department),
    );
    const employeeIds = JSON.stringify(
      employees.map((employee) => employee.id),
    );
    const records = (
      this.db
        .prepare(
          'SELECT * FROM attendance WHERE employee_id IN (SELECT value FROM json_each(?)) AND work_date >= ? AND work_date <= ?',
        )
        .all(employeeIds, filters.from, filters.to) as AttendanceRow[]
    ).map(attendance);
    const assigned = this.schedulesService.assignmentReader(
      employees.map((employee) => employee.id),
    );
    const locations = this.location.views(
      employees.map((employee) => employee.id),
      filters.from,
      filters.to,
    );
    const timezone = this.companyService.settings().timezone;
    const byKey = new Map(
      records.map((r) => [`${r.employeeId}:${r.workDate}`, r]),
    );
    const rows: ReportRow[] = [];
    const now = new Date();
    const timeOff = this.db
      .prepare(
        "SELECT data FROM employee_requests WHERE status = 'approved' AND employee_id IN (SELECT value FROM json_each(?)) AND json_extract(data, '$.from') <= ? AND json_extract(data, '$.to') >= ?",
      )
      .all(employeeIds, filters.to, filters.from)
      .map((r) => JSON.parse(r.data as string) as EmployeeRequest)
      .filter(
        (r) =>
          r.status === 'approved' &&
          r.type !== 'forgotten-check-out' &&
          r.type !== 'excuse',
      );
    const timeOffByEmployee = new Map<string, EmployeeRequest[]>();
    for (const request of timeOff) {
      const requests = timeOffByEmployee.get(request.employeeId) ?? [];
      requests.push(request);
      timeOffByEmployee.set(request.employeeId, requests);
    }
    let processed = 0;
    for (
      let date = filters.from;
      date <= filters.to;
      date = shiftDate(date, 1)
    ) {
      const day = weekday(date);
      for (const employee of employees) {
        // Bound memory to one report and give sockets/writes time between batches.
        if (processed++ % 1000 === 0) await setImmediate();
        const record = byKey.get(`${employee.id}:${date}`);
        if (
          !record &&
          (!employee.active ||
            employee.startDate > date ||
            !assigned(employee.id, date).days.includes(day))
        )
          continue;
        const approved = timeOffByEmployee
          .get(employee.id)
          ?.find(
            (r) =>
              r.type !== 'forgotten-check-out' &&
              r.employeeId === employee.id &&
              r.from <= date &&
              r.to >= date,
          );
        const arrival = record ? arrivalStatus(record) : null;
        const status = record
          ? record.checkOut
            ? arrival!
            : attendanceStatus(record, now)
          : approved
            ? approved.type === 'leave'
              ? 'Approved leave'
              : approved.type === 'holiday'
                ? 'Approved holiday'
                : `Approved ${approved.type}`
            : 'No record';
        if (filters.status && filters.status !== status) continue;
        rows.push({
          id: record?.id ?? null,
          employeeId: employee.id,
          nationalId: actor.role === 'manager' ? '' : employee.nationalId,
          name: employee.name,
          department: employee.department,
          workDate: date,
          checkIn: record?.checkIn ?? null,
          checkOut: record?.checkOut ?? null,
          status,
          late: arrival === 'Late',
          hours: record?.checkOut
            ? Math.round(
                ((Date.parse(record.checkOut) - Date.parse(record.checkIn)) /
                  3600000) *
                  100,
              ) / 100
            : null,
          timezone: record?.timezone ?? timezone,
          location: record ? (locations.get(record.id) ?? null) : null,
        });
      }
    }
    return rows.reverse();
  }

  correct(actor: Actor, id: string, input: AttendanceCorrectionDto) {
    requireHr(actor);
    return this.store.transaction(() =>
      this.correctInTransaction(actor, id, input),
    );
  }

  // Shares the caller's transaction when approving an attendance request.
  correctInTransaction(
    actor: Actor,
    id: string,
    input: AttendanceCorrectionDto,
  ) {
    requireHr(actor);
    const row = this.db
      .prepare('SELECT * FROM attendance WHERE id = ?')
      .get(id) as AttendanceRow | undefined;
    if (!row) throw new NotFoundException('Attendance record not found');
    const before = attendance(row);
    const { checkIn, checkOut } = this.validateTimes(before, input);
    if (
      !checkOut &&
      this.db
        .prepare(
          'SELECT id FROM attendance WHERE employee_id = ? AND check_out IS NULL AND id != ?',
        )
        .get(before.employeeId, id)
    )
      throw new ConflictException('Another attendance record is already open');
    const after = { ...before, checkIn, checkOut };
    this.db
      .prepare('UPDATE attendance SET check_in = ?, check_out = ? WHERE id = ?')
      .run(checkIn, checkOut, id);
    this.location.reset(id);
    this.auditService.record(
      actor,
      'attendance.corrected',
      id,
      before,
      after,
      input.reason,
    );
    return after;
  }

  manualAttendance(actor: Actor, input: ManualAttendanceDto) {
    requireHr(actor);
    return this.store.transaction(() => {
      const employee = this.employeesService.employee(input.employeeId);
      if (input.workDate < employee.startDate)
        throw new BadRequestException(
          'Attendance cannot start before employment begins',
        );
      const record: Attendance = {
        id: randomUUID(),
        employeeId: employee.id,
        workDate: input.workDate,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        schedule: this.schedulesService.assignedSchedule(
          employee.id,
          input.workDate,
        ),
        timezone: this.companyService.settings().timezone,
      };
      Object.assign(record, this.validateTimes(record, input));
      if (
        this.db
          .prepare(
            'SELECT id FROM attendance WHERE employee_id = ? AND work_date = ?',
          )
          .get(employee.id, input.workDate)
      )
        throw new ConflictException(
          'An attendance record already exists for this workday',
        );
      if (
        !record.checkOut &&
        this.db
          .prepare(
            'SELECT id FROM attendance WHERE employee_id = ? AND check_out IS NULL',
          )
          .get(employee.id)
      )
        throw new ConflictException(
          'Another attendance record is already open',
        );
      this.db
        .prepare('INSERT INTO attendance VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          record.id,
          employee.id,
          record.workDate,
          record.checkIn,
          record.checkOut,
          JSON.stringify(record.schedule),
          record.timezone,
        );
      this.auditService.record(
        actor,
        'attendance.manual_entry',
        record.id,
        null,
        record,
        input.reason,
      );
      return record;
    });
  }

  validateTimes(record: Attendance, input: AttendanceCorrectionDto) {
    const checkIn = new Date(input.checkIn).toISOString();
    const checkOut = input.checkOut
      ? new Date(input.checkOut).toISOString()
      : null;
    if (
      Date.parse(checkIn) > Date.now() ||
      (checkOut &&
        (Date.parse(checkOut) < Date.parse(checkIn) ||
          Date.parse(checkOut) > Date.now()))
    )
      throw new BadRequestException(
        'Times must be in the past, and check-out must follow check-in',
      );
    if (
      workDate(new Date(checkIn), record.schedule, record.timezone) !==
      record.workDate
    )
      throw new BadRequestException(
        'Check-in must belong to the original scheduled workday',
      );
    return { checkIn, checkOut };
  }
}
