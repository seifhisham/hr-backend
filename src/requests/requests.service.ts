import { shiftDate } from '../attendance/attendance-time.js';
import {
  requireUnlockedPayroll,
  requireUnlockedRequest,
} from '../payroll/payroll-lock.js';
import { CompanyService } from '../company/company.service.js';
import { localTime } from '../attendance/attendance-time.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SchedulesService } from '../schedules/schedules.service.js';
import { randomUUID } from 'node:crypto';
import type { AttendanceRow } from '../attendance/attendance.mapper.js';
import { attendance } from '../attendance/attendance.mapper.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import type { Attendance } from '../attendance/types/attendance.type.js';
import { AuditService } from '../audit/audit.service.js';
import { requireHr } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import {
  DatabaseService,
  companyContext,
} from '../database/database.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import type { Employee } from '../employees/types/employee.type.js';
import type {
  RequestDecisionDto,
  SubmitRequestDto,
  RequestPageDto,
} from './dto/request.dto.js';
import type { EmployeeRequest } from './types/employee-request.type.js';
@Injectable()
export class RequestsService {
  constructor(
    @Inject(CompanyService)
    private readonly companyService: CompanyService,
    @Inject(SchedulesService)
    private readonly schedulesService: SchedulesService,
    @Inject(DatabaseService)
    private readonly store: DatabaseService,
    @Inject(EmployeesService)
    private readonly employeesService: EmployeesService,
    @Inject(AttendanceService)
    private readonly attendanceService: AttendanceService,
    @Inject(AuditService)
    private readonly auditService: AuditService,
  ) {}
  private get db() {
    return this.store.db;
  }
  async requests(
    actor: Actor,
    own = false,
    page?: RequestPageDto,
  ): Promise<EmployeeRequest[]> {
    if (!own) requireHr(actor);
    const profiles = new Map<
      string,
      | Pick<Employee, 'id' | 'managerId' | 'department' | 'active' | 'role'>
      | Promise<
          Pick<Employee, 'id' | 'managerId' | 'department' | 'active' | 'role'>
        >
    >();
    const employee = own
      ? await this.employeesService.employeeActor(actor)
      : null;
    if (employee) profiles.set(employee.id, employee);
    const employeeId = employee?.id;
    return await Promise.all(
      (
        await this.db
          .prepare(
            `SELECT data FROM employee_requests WHERE 1 = 1
          ${employeeId ? 'AND employee_id = ?' : ''}
          ${page?.status ? 'AND status = ?' : ''}
          ${page?.before ? 'AND row_order < (SELECT row_order FROM employee_requests WHERE id = ?)' : ''}
          ORDER BY row_order DESC ${page ? 'LIMIT ?' : ''}`,
          )
          .all(
            ...(employeeId ? [employeeId] : []),
            ...(page?.status ? [page.status] : []),
            ...(page?.before ? [page.before] : []),
            ...(page ? [page.limit] : []),
          )
      ).map(
        async (r) =>
          await this.workflow(
            JSON.parse(r.data as string) as EmployeeRequest,
            profiles,
          ),
      ),
    );
  }
  async workflow(
    request: EmployeeRequest,
    profiles = new Map<
      string,
      | Pick<Employee, 'id' | 'managerId' | 'department' | 'active' | 'role'>
      | Promise<
          Pick<Employee, 'id' | 'managerId' | 'department' | 'active' | 'role'>
        >
    >(),
  ): Promise<EmployeeRequest> {
    if (request.status !== 'pending') return request;
    const profile = async (id: string) => {
      let employee = profiles.get(id);
      if (!employee) {
        employee =
          companyContext.getStore()?.actor?.role === 'hr'
            ? this.employeesService.workflowEmployee(id)
            : this.employeesService.storedEmployee(id);
        profiles.set(id, employee);
      }
      return employee;
    };
    const employee = await profile(request.employeeId);
    const manager = employee.managerId
      ? await profile(employee.managerId)
      : null;
    const managerEmployeeId =
      manager?.active && ['manager', 'hr', 'admin'].includes(manager.role)
        ? manager.id
        : null;
    const required = managerEmployeeId && managerEmployeeId !== employee.id;
    const review = request.managerReview;
    const valid =
      review &&
      review.employeeId === managerEmployeeId &&
      review.department === employee.department;
    return {
      ...request,
      managerEmployeeId: required ? managerEmployeeId : null,
      managerDepartment: employee.department,
      managerStage: required
        ? valid
          ? review.status
          : 'pending'
        : 'not-required',
    };
  }
  async managedRequests(actor: Actor, page?: RequestPageDto) {
    if (!actor.employeeId) return [];
    if (page?.status && page.status !== 'pending') return [];
    const profiles = new Map<
      string,
      | Pick<Employee, 'id' | 'managerId' | 'department' | 'active' | 'role'>
      | Promise<
          Pick<Employee, 'id' | 'managerId' | 'department' | 'active' | 'role'>
        >
    >();
    return (
      await Promise.all(
        (
          await this.db
            .prepare(
              `SELECT data FROM employee_requests WHERE status = 'pending'
          AND employee_id IN (SELECT id FROM employees WHERE (data::jsonb->>'managerId') = ?)
          AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND (data::jsonb->>'active') = 'true' AND (data::jsonb->>'role') IN ('manager', 'hr', 'admin'))
          AND employee_id != ?
          ${page?.before ? 'AND row_order < (SELECT row_order FROM employee_requests WHERE id = ?)' : ''}
          ORDER BY row_order DESC ${page ? 'LIMIT ?' : ''}`,
            )
            .all(
              actor.employeeId,
              actor.employeeId,
              actor.employeeId,
              ...(page?.before ? [page.before] : []),
              ...(page ? [page.limit] : []),
            )
        ).map(
          async (row) =>
            await this.workflow(
              JSON.parse(row.data as string) as EmployeeRequest,
              profiles,
            ),
        ),
      )
    ).filter((request) => request.managerEmployeeId === actor.employeeId);
  }
  async reviewRequest(actor: Actor, id: string, input: RequestDecisionDto) {
    return await this.store.transaction(async () => {
      const row = await this.db
        .prepare('SELECT data FROM employee_requests WHERE id = ?')
        .get(id);
      if (!row) throw new NotFoundException('Request not found');
      const before = await this.workflow(
        JSON.parse(row.data as string) as EmployeeRequest,
      );
      if (
        before.employeeId === actor.employeeId ||
        !actor.employeeId ||
        before.managerEmployeeId !== actor.employeeId
      )
        throw new ForbiddenException(
          'Only the assigned direct manager can review this request',
        );
      if (before.status !== 'pending' || before.managerStage !== 'pending')
        throw new ConflictException('Request is not awaiting manager review');
      const after: EmployeeRequest = {
        ...before,
        managerStage: input.status,
        managerReview: {
          status: input.status,
          employeeId: actor.employeeId,
          department: before.managerDepartment!,
          reviewedBy: actor.name,
          reviewedAt: new Date().toISOString(),
          reason: input.reason,
        },
      };
      await this.db
        .prepare('UPDATE employee_requests SET data = ? WHERE id = ?')
        .run(JSON.stringify(after), id);
      await this.auditService.record(
        actor,
        'request.manager_reviewed',
        id,
        before,
        after,
        input.reason,
      );
      return after;
    });
  }
  async submitRequest(actor: Actor, input: SubmitRequestDto) {
    const employee = await this.employeesService.employeeActor(actor);
    if (!employee.active) throw new ForbiddenException('Employee is inactive');
    return await this.store.transaction(async () => {
      let originalAttendance: Attendance | null = null;
      if (input.type === 'forgotten-check-out') {
        const row = (await this.db
          .prepare('SELECT * FROM attendance WHERE id = ? AND employee_id = ?')
          .get(input.attendanceId, employee.id)) as AttendanceRow | undefined;
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
      if (input.type === 'excuse') {
        const minutes = (value: string) =>
          Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
        for (
          let date = input.from;
          date <= input.to;
          date = shiftDate(date, 1)
        ) {
          const shift = await this.schedulesService.assignedSchedule(
            employee.id,
            date,
          );
          if (input.shiftId !== shift.id)
            throw new BadRequestException(
              'Select the assigned shift for every requested date; split requests at schedule changes',
            );
          const length =
            (minutes(shift.end) - minutes(shift.start) + 1440) % 1440 || 1440;
          if (input.durationMinutes > length)
            throw new BadRequestException(
              'Excuse duration exceeds the shift length',
            );
        }
      }
      if (input.type !== 'forgotten-check-out') {
        const scope = await this.db
          .prepare(
            'SELECT hr_branch_at(?,?) AS first,hr_branch_at(?,?) AS last',
          )
          .get(employee.id, input.from, employee.id, input.to);
        const boundary = await this.db
          .prepare(
            'SELECT 1 FROM employee_branches WHERE employee_id=? AND effective_from>? AND effective_from<=?',
          )
          .get(employee.id, input.from, input.to);
        if (!scope?.first || scope.first !== scope.last || boundary)
          throw new BadRequestException(
            'Split requests at branch assignment changes',
          );
      }
      await this.checkExcuseAllowance(employee.id, input);
      await this.checkRequestOverlap(employee.id, input);
      const result: EmployeeRequest = {
        ...input,
        id: randomUUID(),
        employeeId: employee.id,
        employeeName: employee.name,
        nationalId: employee.nationalId,
        status: 'pending',
        managerReview: null,
        submittedAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
        salaryDeductionDays: null,
        attendance: originalAttendance,
      };
      await this.db
        .prepare(
          'INSERT INTO employee_requests (id,employee_id,status,data) VALUES (?, ?, ?, ?)',
        )
        .run(result.id, employee.id, result.status, JSON.stringify(result));
      await this.auditService.record(
        actor,
        'request.submitted',
        result.id,
        null,
        result,
        input.reason,
      );
      return await this.workflow(result);
    });
  }
  private async checkExcuseAllowance(
    employeeId: string,
    input: SubmitRequestDto,
    excludeId?: string,
  ) {
    if (input.type !== 'excuse') return;
    const minutesByMonth = (
      request: Extract<
        SubmitRequestDto,
        {
          type: 'excuse';
        }
      >,
    ) => {
      const months = new Map<string, number>();
      for (
        let day = Date.parse(request.from);
        day <= Date.parse(request.to);
        day += 86400000
      ) {
        const month = new Date(day).toISOString().slice(0, 7);
        months.set(month, (months.get(month) ?? 0) + request.durationMinutes);
      }
      return months;
    };
    const existing = (
      await this.db
        .prepare(
          "SELECT data FROM employee_requests WHERE employee_id = ? AND status IN ('pending', 'approved')",
        )
        .all(employeeId)
    )
      .map((row) => JSON.parse(row.data as string) as EmployeeRequest)
      .filter(
        (
          request,
        ): request is Extract<
          EmployeeRequest,
          {
            type: 'excuse';
          }
        > => request.id !== excludeId && request.type === 'excuse',
      )
      .map(minutesByMonth);
    for (const [month, candidateMinutes] of minutesByMonth(input)) {
      const used = existing.filter((months) => months.has(month));
      if (used.length >= 3)
        throw new ConflictException(
          `Excuse limit reached for ${month}: at most 3 pending or approved requests per month`,
        );
      const minutes = used.reduce(
        (total, months) => total + months.get(month)!,
        0,
      );
      if (minutes + candidateMinutes > 240)
        throw new ConflictException(
          `Excuse limit exceeded for ${month}: at most 240 minutes (4 hours) per month`,
        );
    }
  }
  private async checkRequestOverlap(
    employeeId: string,
    input: SubmitRequestDto,
    excludeId?: string,
  ) {
    const conflicts = (
      await this.db
        .prepare(
          "SELECT data FROM employee_requests WHERE employee_id = ? AND status IN ('pending', 'approved')",
        )
        .all(employeeId)
    ).map((r) => JSON.parse(r.data as string) as EmployeeRequest);
    if (
      conflicts.some(
        (r) =>
          r.id !== excludeId &&
          (input.type === 'forgotten-check-out'
            ? r.type === input.type && r.attendanceId === input.attendanceId
            : r.type !== 'forgotten-check-out' &&
              r.from <= input.to &&
              r.to >= input.from &&
              (input.type !== 'excuse' ||
                r.type !== 'excuse' ||
                (r.shiftId === input.shiftId &&
                  r.excuseType === input.excuseType))),
      )
    )
      throw new ConflictException(
        'A pending or approved request already covers this attendance record or date range',
      );
  }
  async changeRequest(
    actor: Actor,
    id: string,
    action: 'withdraw' | 'reopen',
    reason: string,
  ) {
    return await this.store.transaction(async () => {
      const row = await this.db
        .prepare('SELECT data FROM employee_requests WHERE id = ?')
        .get(id);
      if (!row) throw new NotFoundException('Request not found');
      const before = JSON.parse(row.data as string) as EmployeeRequest;
      if (action === 'withdraw') {
        if (before.employeeId !== actor.employeeId)
          throw new ForbiddenException(
            'You can only withdraw your own request',
          );
        if (before.status !== 'pending')
          throw new ConflictException('Only pending requests can be withdrawn');
      } else {
        requireHr(actor);
        await requireUnlockedRequest(this.db, id);
        if (before.employeeId === actor.employeeId)
          throw new ForbiddenException('You cannot reopen your own request');
        if (before.status !== 'approved')
          throw new ConflictException('Only approved requests can be reopened');
        if (before.type === 'forgotten-check-out')
          throw new ConflictException(
            'Use attendance correction for an approved forgotten check-out',
          );
        await this.checkExcuseAllowance(before.employeeId, before, id);
        await this.checkRequestOverlap(before.employeeId, before, id);
      }
      const after: EmployeeRequest = await this.workflow({
        ...before,
        status: action === 'withdraw' ? 'withdrawn' : 'pending',
        ...(action === 'reopen' ? { managerReview: null } : {}),
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
        salaryDeductionDays: null,
        lastChange: {
          action,
          reason,
          at: new Date().toISOString(),
          by: actor.name,
        },
      });
      await this.db
        .prepare(
          'UPDATE employee_requests SET status = ?, data = ? WHERE id = ?',
        )
        .run(after.status, JSON.stringify(after), id);
      await this.auditService.record(
        actor,
        `request.${action === 'withdraw' ? 'withdrawn' : 'reopened'}`,
        id,
        before,
        after,
        reason,
      );
      return await this.workflow(after);
    });
  }
  async decideRequest(actor: Actor, id: string, input: RequestDecisionDto) {
    requireHr(actor);
    return await this.store.transaction(async () => {
      const row = await this.db
        .prepare('SELECT data FROM employee_requests WHERE id = ?')
        .get(id);
      if (!row) throw new NotFoundException('Request not found');
      const before = await this.workflow(
        JSON.parse(row.data as string) as EmployeeRequest,
      );
      if (before.employeeId === actor.employeeId)
        throw new ForbiddenException('You cannot decide your own request');
      if (before.status !== 'pending')
        throw new ConflictException('Request has already been decided');
      if (before.managerStage === 'pending')
        throw new ConflictException(
          'Direct manager review is required before the HR decision',
        );
      if (
        before.managerReview?.employeeId === actor.employeeId &&
        before.managerStage !== 'not-required'
      )
        throw new ForbiddenException(
          'The manager reviewer cannot give the final HR decision',
        );
      if (before.type !== 'forgotten-check-out')
        await requireUnlockedPayroll(
          this.db,
          localTime(
            new Date(),
            (await this.companyService.settings()).timezone,
          ).date.slice(0, 7),
        );
      if (input.status === 'approved') {
        if (
          !(await this.employeesService.workflowEmployee(before.employeeId))
            .active
        )
          throw new ConflictException('Employee is inactive');
        await this.checkExcuseAllowance(before.employeeId, before, id);
        await this.checkRequestOverlap(before.employeeId, before, id);
        if (before.type === 'forgotten-check-out') {
          const record = (await this.db
            .prepare(
              'SELECT * FROM attendance WHERE id = ? AND employee_id = ?',
            )
            .get(before.attendanceId, before.employeeId)) as
            AttendanceRow | undefined;
          if (!record || record.check_out)
            throw new ConflictException('Attendance is no longer open');
          await this.attendanceService.correctInTransaction(actor, record.id, {
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
        salaryDeductionDays:
          before.type === 'forgotten-check-out'
            ? null
            : input.status === 'approved'
              ? 1
              : 3,
      };
      await this.db
        .prepare(
          'UPDATE employee_requests SET status = ?, data = ? WHERE id = ?',
        )
        .run(after.status, JSON.stringify(after), id);
      await this.auditService.record(
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
