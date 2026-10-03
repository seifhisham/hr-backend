import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AttendanceRow } from '../attendance/attendance.mapper.js';
import { attendance } from '../attendance/attendance.mapper.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import type { Attendance } from '../attendance/types/attendance.type.js';
import { AuditService } from '../audit/audit.service.js';
import { requireHr } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import { DatabaseService } from '../database/database.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import type {
  RequestDecisionDto,
  SubmitRequestDto,
} from './dto/request.dto.js';
import type { EmployeeRequest } from './types/employee-request.type.js';

@Injectable()
export class RequestsService {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(EmployeesService)
    private readonly employeesService: EmployeesService,
    @Inject(AttendanceService)
    private readonly attendanceService: AttendanceService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}
  private get db() {
    return this.store.db;
  }

  requests(actor: Actor, own = false): EmployeeRequest[] {
    if (!own) requireHr(actor);
    const employeeId = own
      ? this.employeesService.employeeActor(actor).id
      : null;
    return this.db
      .prepare(
        employeeId
          ? 'SELECT data FROM employee_requests WHERE employee_id = ? ORDER BY rowid DESC'
          : 'SELECT data FROM employee_requests ORDER BY rowid DESC',
      )
      .all(...(employeeId ? [employeeId] : []))
      .map((r) => JSON.parse(r.data as string) as EmployeeRequest);
  }

  submitRequest(actor: Actor, input: SubmitRequestDto) {
    const employee = this.employeesService.employeeActor(actor);
    if (!employee.active) throw new ForbiddenException('Employee is inactive');
    return this.store.transaction(() => {
      let originalAttendance: Attendance | null = null;
      if (input.type === 'forgotten-check-out') {
        const row = this.db
          .prepare('SELECT * FROM attendance WHERE id = ? AND employee_id = ?')
          .get(input.attendanceId, employee.id) as AttendanceRow | undefined;
        if (!row) throw new NotFoundException('Attendance record not found');
        if (row.check_out)
          throw new ConflictException('Attendance is already closed');
        originalAttendance = attendance(row);
        this.attendanceService.validateTimes(attendance(row), {
          checkIn: row.check_in,
          checkOut: input.proposedCheckOut,
          reason: input.reason,
        });
      } else if (input.from < employee.startDate) {
        throw new BadRequestException(
          'Time off cannot begin before employment',
        );
      }
      this.checkRequestOverlap(employee.id, input);
      const result: EmployeeRequest = {
        ...input,
        id: randomUUID(),
        employeeId: employee.id,
        employeeName: employee.name,
        employeeCode: employee.employeeCode,
        status: 'pending',
        submittedAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
        attendance: originalAttendance,
      };
      this.db
        .prepare('INSERT INTO employee_requests VALUES (?, ?, ?, ?)')
        .run(result.id, employee.id, result.status, JSON.stringify(result));
      this.auditService.record(
        actor,
        'request.submitted',
        result.id,
        null,
        result,
        input.reason,
      );
      return result;
    });
  }

  private checkRequestOverlap(
    employeeId: string,
    input: SubmitRequestDto,
    excludeId?: string,
  ) {
    const conflicts = this.db
      .prepare(
        "SELECT data FROM employee_requests WHERE employee_id = ? AND status != 'rejected'",
      )
      .all(employeeId)
      .map((r) => JSON.parse(r.data as string) as EmployeeRequest);
    if (
      conflicts.some(
        (r) =>
          r.id !== excludeId &&
          (input.type === 'forgotten-check-out'
            ? r.type === input.type && r.attendanceId === input.attendanceId
            : r.type !== 'forgotten-check-out' &&
              r.from <= input.to &&
              r.to >= input.from),
      )
    )
      throw new ConflictException(
        'A pending or approved request already covers this attendance record or date range',
      );
  }

  decideRequest(actor: Actor, id: string, input: RequestDecisionDto) {
    requireHr(actor);
    return this.store.transaction(() => {
      const row = this.db
        .prepare('SELECT data FROM employee_requests WHERE id = ?')
        .get(id);
      if (!row) throw new NotFoundException('Request not found');
      const before = JSON.parse(row.data as string) as EmployeeRequest;
      if (before.employeeId === actor.employeeId)
        throw new ForbiddenException('You cannot decide your own request');
      if (before.status !== 'pending')
        throw new ConflictException('Request has already been decided');
      if (input.status === 'approved') {
        if (!this.employeesService.employee(before.employeeId).active)
          throw new ConflictException('Employee is inactive');
        this.checkRequestOverlap(before.employeeId, before, id);
        if (before.type === 'forgotten-check-out') {
          const record = this.db
            .prepare(
              'SELECT * FROM attendance WHERE id = ? AND employee_id = ?',
            )
            .get(before.attendanceId, before.employeeId) as
            AttendanceRow | undefined;
          if (!record || record.check_out)
            throw new ConflictException('Attendance is no longer open');
          this.attendanceService.correctInTransaction(actor, record.id, {
            checkIn: record.check_in,
            checkOut: before.proposedCheckOut,
            reason: `Request ${id}: ${input.reason}`,
          });
        }
      }
      const after: EmployeeRequest = {
        ...before,
        status: input.status,
        decidedAt: new Date().toISOString(),
        decidedBy: actor.name,
        decisionReason: input.reason,
      };
      this.db
        .prepare(
          'UPDATE employee_requests SET status = ?, data = ? WHERE id = ?',
        )
        .run(after.status, JSON.stringify(after), id);
      this.auditService.record(
        actor,
        `request.${input.status}`,
        id,
        before,
        after,
        input.reason,
      );
      return after;
    });
  }
}
