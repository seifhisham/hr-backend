import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(AttendanceEvidence) private readonly evidence: AttendanceEvidence,
    @Inject(EmployeesService)
    private readonly employeesService: EmployeesService,
    @Inject(SchedulesService)
    private readonly schedulesService: SchedulesService,
    @Inject(CompanyService) private readonly companyService: CompanyService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}
  private get db() {
    return this.store.db;
  }

  myAttendance(actor: Actor) {
    const employee = this.employeesService.employeeActor(actor);
    const records = this.db
      .prepare(
        'SELECT * FROM attendance WHERE employee_id = ? ORDER BY work_date DESC LIMIT 93',
      )
      .all(employee.id) as AttendanceRow[];
    return {
      employee,
      schedule: this.schedulesService.schedule(employee.scheduleId),
      workDate: workDate(
        new Date(),
        this.schedulesService.schedule(employee.scheduleId),
        this.companyService.settings().timezone,
      ),
      records: records.map((r) => ({
        ...attendance(r),
        status: attendanceStatus(attendance(r), new Date()),
      })),
    };
  }

  checkIn(actor: Actor, evidence: Evidence) {
    const employee = this.employeesService.employeeActor(actor);
    if (!employee.active) throw new ForbiddenException('Employee is inactive');
    return this.store.transaction(() => {
      const schedule = this.schedulesService.schedule(employee.scheduleId);
      const timezone = this.companyService.settings().timezone;
      const now = new Date();
      const date = workDate(now, schedule, timezone);
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
            'SELECT id FROM attendance WHERE employee_id = ? AND check_out IS NULL',
          )
          .get(employee.id)
      )
        throw new ConflictException(
          'A previous attendance record is still open. Ask HR to correct it.',
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
      row.check_out = new Date().toISOString();
      this.db
        .prepare('UPDATE attendance SET check_out = ? WHERE id = ?')
        .run(row.check_out, row.id);
      this.evidence.save(row.id, 'check-out', evidence, row.check_out);
      return attendance(row);
    });
  }

  report(actor: Actor, filters: AttendanceFiltersDto): ReportRow[] {
    requireHr(actor);
    const records = (
      this.db
        .prepare(
          'SELECT * FROM attendance WHERE work_date >= ? AND work_date <= ?',
        )
        .all(filters.from, filters.to) as AttendanceRow[]
    ).map(attendance);
    const employees = this.employeesService
      .employees(actor)
      .filter(
        (e) =>
          (!filters.employeeId || e.id === filters.employeeId) &&
          (!filters.department || e.department === filters.department),
      );
    const byKey = new Map(
      records.map((r) => [`${r.employeeId}:${r.workDate}`, r]),
    );
    const rows: ReportRow[] = [];
    const now = new Date();
    const timeOff = this.db
      .prepare("SELECT data FROM employee_requests WHERE status = 'approved'")
      .all()
      .map((r) => JSON.parse(r.data as string) as EmployeeRequest)
      .filter(
        (r) => r.status === 'approved' && r.type !== 'forgotten-check-out',
      );
    for (
      let date = filters.from;
      date <= filters.to;
      date = shiftDate(date, 1)
    ) {
      for (const employee of employees) {
        const record = byKey.get(`${employee.id}:${date}`);
        if (
          !record &&
          (!employee.active ||
            employee.startDate > date ||
            !this.schedulesService
              .schedule(employee.scheduleId)
              .days.includes(weekday(date)))
        )
          continue;
        const approved = timeOff.find(
          (r) =>
            r.type !== 'forgotten-check-out' &&
            r.employeeId === employee.id &&
            r.from <= date &&
            r.to >= date,
        );
        const status = record
          ? attendanceStatus(record, now)
          : approved
            ? approved.type === 'leave'
              ? 'Approved leave'
              : 'Approved holiday'
            : 'No record';
        if (filters.status && filters.status !== status) continue;
        rows.push({
          id: record?.id ?? null,
          employeeId: employee.id,
          employeeCode: employee.employeeCode,
          name: employee.name,
          department: employee.department,
          workDate: date,
          checkIn: record?.checkIn ?? null,
          checkOut: record?.checkOut ?? null,
          status,
          late: record ? arrivalStatus(record) === 'Late' : false,
          hours: record?.checkOut
            ? Math.round(
                ((Date.parse(record.checkOut) - Date.parse(record.checkIn)) /
                  3600000) *
                  100,
              ) / 100
            : null,
          timezone: record?.timezone ?? this.companyService.settings().timezone,
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
        schedule: this.schedulesService.schedule(employee.scheduleId),
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
