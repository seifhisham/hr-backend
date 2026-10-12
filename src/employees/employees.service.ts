import type { EmployeeRequest } from '../requests/types/employee-request.type.js';
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
import { passwordHash } from '../common/security/credentials.js';
import { requireHr } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import { DatabaseService } from '../database/database.service.js';
import { SchedulesService } from '../schedules/schedules.service.js';
import type { SaveEmployeeDto } from './dto/employee.dto.js';
import type { Employee } from './types/employee.type.js';

@Injectable()
export class EmployeesService {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(SchedulesService)
    private readonly schedulesService: SchedulesService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}
  private get db() {
    return this.store.db;
  }

  employeeActor(actor: Actor) {
    if (!actor.employeeId)
      throw new BadRequestException('This account has no employee profile');
    return this.employee(actor.employeeId);
  }

  employees(actor: Actor) {
    requireHr(actor);
    return this.db
      .prepare('SELECT data FROM employees ORDER BY code')
      .all()
      .map((r) =>
        this.currentEmployee(JSON.parse(r.data as string) as Employee),
      );
  }

  reports(actor: Actor) {
    return this.managedEmployees(actor).map((employee) => ({
      id: employee.id,
      name: employee.name,
      employeeNumber: employee.employeeNumber,
      department: employee.department,
      jobTitle: employee.jobTitle,
      active: employee.active,
    }));
  }

  managedEmployees(actor: Actor) {
    if (actor.role !== 'manager' || !actor.employeeId)
      throw new ForbiddenException('Manager access required');
    return this.db
      .prepare(
        "SELECT data FROM employees WHERE json_extract(data, '$.managerId') = ? ORDER BY code",
      )
      .all(actor.employeeId)
      .map((row) =>
        this.currentEmployee(JSON.parse(row.data as string) as Employee),
      );
  }

  employee(id: string): Employee {
    return this.currentEmployee(this.storedEmployee(id));
  }

  storedEmployee(id: string): Employee {
    const row = this.db
      .prepare('SELECT data FROM employees WHERE id = ?')
      .get(id);
    if (!row) throw new NotFoundException('Employee not found');
    return JSON.parse(row.data as string) as Employee;
  }

  private currentEmployee(employee: Employee): Employee {
    return {
      ...employee,
      salesEnabled: employee.salesEnabled ?? false,
      scheduleId: this.schedulesService.assignedSchedule(
        employee.id,
        this.schedulesService.today(),
      ).id,
    };
  }

  scheduleHistory(actor: Actor, id: string) {
    requireHr(actor);
    this.employee(id);
    return this.db
      .prepare(
        'SELECT effective_from, schedule_id FROM employee_schedules WHERE employee_id = ? ORDER BY effective_from',
      )
      .all(id)
      .map((row) => ({
        effectiveFrom: row.effective_from as string,
        schedule: this.schedulesService.schedule(
          row.schedule_id as string,
          row.effective_from as string,
        ),
      }));
  }

  profile(actor: Actor) {
    return actor.employeeId ? this.employee(actor.employeeId) : null;
  }

  async saveEmployee(actor: Actor, input: SaveEmployeeDto, id?: string) {
    requireHr(actor);
    const before = id ? this.employee(id) : null;
    if (
      actor.role !== 'admin' &&
      (['hr', 'admin'].includes(input.role) ||
        (before && ['hr', 'admin'].includes(before.role)))
    )
      throw new ForbiddenException(
        'Only administrators manage HR and administrator accounts',
      );
    if (id === actor.employeeId && (!input.active || input.role !== actor.role))
      throw new BadRequestException(
        'You cannot deactivate or change your own role',
      );
    this.schedulesService.schedule(input.scheduleId);
    if (!before && !input.password)
      throw new BadRequestException('An initial password is required');
    const hash = input.password ? await passwordHash(input.password) : null;
    // Password hashing yields; check access again before committing account changes.
    const current = this.db
      .prepare('SELECT role, active FROM users WHERE id = ?')
      .get(actor.id) as { role: string; active: number };
    if (!current?.active || current.role !== actor.role)
      throw new ForbiddenException('Your access changed. Sign in again.');
    if (
      id &&
      actor.role !== 'admin' &&
      ['hr', 'admin'].includes(this.employee(id).role)
    )
      throw new ForbiddenException(
        'Only administrators manage HR and administrator accounts',
      );
    const { password: _password, scheduleEffectiveFrom, ...fields } = input;
    let employee: Employee;
    try {
      this.store.transaction(() => {
        const assignmentChanged =
          !before ||
          input.scheduleId !== before.scheduleId ||
          scheduleEffectiveFrom !== undefined;
        const effectiveFrom = before
          ? (scheduleEffectiveFrom ?? this.schedulesService.today())
          : input.startDate;
        if (
          assignmentChanged &&
          (effectiveFrom < input.startDate ||
            (before && effectiveFrom < this.schedulesService.today()))
        )
          throw new BadRequestException(
            'Schedule changes cannot start before today or employment begins',
          );
        if (
          !before &&
          scheduleEffectiveFrom &&
          scheduleEffectiveFrom !== input.startDate
        )
          throw new BadRequestException(
            'The initial schedule must start on the employment date',
          );
        if (
          before &&
          input.startDate !== before.startDate &&
          this.db
            .prepare(
              'SELECT 1 FROM employee_schedules WHERE employee_id = ? AND effective_from < ?',
            )
            .get(before.id, input.startDate)
        )
          throw new BadRequestException(
            'Employment date cannot be after an existing schedule assignment',
          );
        this.db
          .prepare('INSERT OR IGNORE INTO departments (name) VALUES (?)')
          .run(input.department);
        const department = this.db
          .prepare('SELECT name FROM departments WHERE name = ? COLLATE NOCASE')
          .get(input.department) as { name: string };
        employee = {
          ...fields,
          managerId: input.managerId ?? null,
          salesEnabled: input.salesEnabled ?? before?.salesEnabled ?? false,
          department: department.name,
          id: id ?? randomUUID(),
          employeeNumber:
            before?.employeeNumber ?? this.store.nextEmployeeNumber(),
          monthlySalary:
            input.monthlySalary === undefined
              ? (before?.monthlySalary ?? null)
              : input.monthlySalary,
          salaryCurrency:
            input.salaryCurrency ?? before?.salaryCurrency ?? 'EGP',
        };
        if (employee.managerId) {
          if (employee.managerId === employee.id)
            throw new BadRequestException(
              'An employee cannot manage themselves',
            );
          const manager = this.employee(employee.managerId);
          if (
            !manager.active ||
            !['manager', 'hr', 'admin'].includes(manager.role)
          )
            throw new BadRequestException('Select an active manager');
        }
        if (
          before &&
          (!employee.active ||
            !['manager', 'hr', 'admin'].includes(employee.role))
        ) {
          for (const report of this.db
            .prepare(
              "SELECT id, data FROM employees WHERE json_extract(data, '$.managerId') = ?",
            )
            .all(employee.id)) {
            const updated = {
              ...(JSON.parse(report.data as string) as Employee),
              managerId: null,
            };
            this.db
              .prepare('UPDATE employees SET data = ? WHERE id = ?')
              .run(JSON.stringify(updated), report.id as string);
            this.auditService.record(
              actor,
              'employee.updated',
              report.id as string,
              JSON.parse(report.data as string),
              updated,
            );
          }
        }
        if (
          before &&
          (employee.department !== before.department ||
            employee.managerId !== (before.managerId ?? null))
        ) {
          for (const row of this.db
            .prepare(
              "SELECT data FROM employee_requests WHERE employee_id = ? AND status = 'pending'",
            )
            .all(employee.id)) {
            const request = JSON.parse(row.data as string) as EmployeeRequest;
            const {
              managerStage: _stage,
              managerEmployeeId: _managerId,
              managerDepartment: _department,
              ...fields
            } = request;
            const after: EmployeeRequest = { ...fields, managerReview: null };
            this.db
              .prepare('UPDATE employee_requests SET data = ? WHERE id = ?')
              .run(JSON.stringify(after), request.id);
            this.auditService.record(
              actor,
              'request.manager_review_reset',
              request.id,
              request,
              after,
              'Employee department or manager changed',
            );
          }
        }
        if (before) {
          this.db
            .prepare(
              'UPDATE employees SET code = ?, email = ?, data = ? WHERE id = ?',
            )
            .run(
              employee.nationalId,
              employee.email,
              JSON.stringify(employee),
              employee.id,
            );
          this.db
            .prepare(
              'UPDATE users SET email = ?, name = ?, role = ?, active = ?, password_hash = COALESCE(?, password_hash) WHERE employee_id = ?',
            )
            .run(
              employee.email,
              employee.name,
              employee.role,
              Number(employee.active),
              hash,
              employee.id,
            );
          if (hash || !employee.active || employee.role !== before.role)
            this.db
              .prepare(
                'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE employee_id = ?)',
              )
              .run(employee.id);
        } else {
          this.db
            .prepare('INSERT INTO employees VALUES (?, ?, ?, ?)')
            .run(
              employee.id,
              employee.nationalId,
              employee.email,
              JSON.stringify(employee),
            );
          this.db
            .prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(
              randomUUID(),
              employee.email,
              employee.name,
              employee.role,
              employee.id,
              Number(employee.active),
              hash!,
            );
        }
        if (assignmentChanged) {
          const previousAssignment = this.db
            .prepare(
              'SELECT schedule_id FROM employee_schedules WHERE employee_id = ? AND effective_from = ?',
            )
            .get(employee.id, effectiveFrom);
          this.db
            .prepare(
              'INSERT INTO employee_schedules VALUES (?, ?, ?) ON CONFLICT(employee_id, effective_from) DO UPDATE SET schedule_id = excluded.schedule_id',
            )
            .run(employee.id, effectiveFrom, input.scheduleId);
          this.auditService.record(
            actor,
            'employee.schedule_assigned',
            employee.id,
            previousAssignment
              ? { effectiveFrom, scheduleId: previousAssignment.schedule_id }
              : null,
            { effectiveFrom, scheduleId: input.scheduleId },
          );
        }
        employee = this.currentEmployee(employee);
        this.auditService.record(
          actor,
          before ? 'employee.updated' : 'employee.created',
          employee.id,
          before,
          employee,
        );
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint'))
        throw new ConflictException('National ID or email already exists');
      throw error;
    }
    return employee!;
  }
}
