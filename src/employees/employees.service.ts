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
    @Inject(DatabaseService)
    private readonly store: DatabaseService,
    @Inject(SchedulesService)
    private readonly schedulesService: SchedulesService,
    @Inject(AuditService)
    private readonly auditService: AuditService,
  ) {}
  private get db() {
    return this.store.db;
  }
  async employeeActor(actor: Actor) {
    if (!actor.employeeId)
      throw new BadRequestException('This account has no employee profile');
    return await this.employee(actor.employeeId);
  }
  async employees(actor: Actor) {
    requireHr(actor);
    const accounts = new Map(
      (
        await this.db
          .prepare(
            'SELECT id, employee_id FROM users WHERE employee_id IS NOT NULL',
          )
          .all()
      ).map((row) => [row.employee_id as string, row.id as string]),
    );
    return (
      await this.currentEmployees(
        (
          await this.db
            .prepare('SELECT data FROM employees ORDER BY code')
            .all()
        ).map((r) => JSON.parse(r.data as string) as Employee),
      )
    ).map((employee) => ({
      ...employee,
      accountId: accounts.get(employee.id) ?? null,
    }));
  }
  async reports(actor: Actor) {
    return (await this.managedEmployees(actor)).map((employee) => ({
      id: employee.id,
      name: employee.name,
      employeeNumber: employee.employeeNumber,
      department: employee.department,
      jobTitle: employee.jobTitle,
      active: employee.active,
    }));
  }
  async managedEmployees(actor: Actor) {
    if (actor.role !== 'manager' || !actor.employeeId)
      throw new ForbiddenException('Manager access required');
    return await this.currentEmployees(
      (
        await this.db
          .prepare(
            "SELECT data FROM employees WHERE (data::jsonb->>'managerId') = ? ORDER BY code",
          )
          .all(actor.employeeId)
      ).map((row) => JSON.parse(row.data as string) as Employee),
    );
  }
  async employee(id: string): Promise<Employee> {
    return await this.currentEmployee(await this.storedEmployee(id));
  }
  async storedEmployee(id: string): Promise<Employee> {
    const row = await this.db
      .prepare('SELECT data FROM employees WHERE id = ?')
      .get(id);
    if (!row) throw new NotFoundException('Employee not found');
    return JSON.parse(row.data as string) as Employee;
  }
  private async currentEmployee(employee: Employee): Promise<Employee> {
    const branch = await this.db
      .prepare('SELECT hr_branch_at(?,?) AS id')
      .get(employee.id, await this.schedulesService.today());
    return {
      ...employee,
      branchId: branch?.id as string | undefined,
      salesEnabled: employee.salesEnabled ?? false,
      scheduleId: (
        await this.schedulesService.assignedSchedule(
          employee.id,
          await this.schedulesService.today(),
        )
      ).id,
    };
  }
  private async currentEmployees(employees: Employee[]): Promise<Employee[]> {
    if (!employees.length) return [];
    const today = await this.schedulesService.today();
    const assigned = await this.schedulesService.assignmentReader(
      employees.map((employee) => employee.id),
    );
    const branches = new Map(
      (
        await this.db
          .prepare(
            'SELECT DISTINCT ON (employee_id) employee_id,branch_id FROM employee_branches WHERE employee_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)) ORDER BY employee_id,(effective_from<=?) DESC,CASE WHEN effective_from<=? THEN effective_from END DESC,effective_from ASC',
          )
          .all(JSON.stringify(employees.map((e) => e.id)), today, today)
      ).map((row) => [row.employee_id, row.branch_id]),
    );
    return employees.map((employee) => ({
      ...employee,
      branchId: branches.get(employee.id) as string | undefined,
      salesEnabled: employee.salesEnabled ?? false,
      scheduleId: assigned(employee.id, today).id,
    }));
  }
  async historicalScope(actor: Actor, from: string, to: string) {
    requireHr(actor);
    const assignments = await this.db
      .prepare('SELECT * FROM hr_visible_assignments(?,?)')
      .all(from, to);
    const snapshots = assignments.map((row) => ({
      employee: JSON.parse(row.employee_snapshot as string) as Employee,
      from: row.effective_from as string,
      to: row.effective_to as string,
      branchId: row.branch_id as string,
      branchName: row.branch_name as string,
    }));
    return {
      employees: [
        ...new Map(
          snapshots.map((row) => [row.employee.id, row.employee]),
        ).values(),
      ],
      at: (id: string, date: string) =>
        snapshots.find(
          (row) => row.employee.id === id && row.from <= date && row.to > date,
        ),
    };
  }
  async historicalEmployee(actor: Actor, id: string, date: string) {
    if (actor.role !== 'hr') return this.employee(id);
    const row = await this.db
      .prepare('SELECT hr_employee_history(?,?) AS data')
      .get(id, date);
    if (!row?.data) throw new NotFoundException('Employee history not found');
    return JSON.parse(row.data as string) as Employee;
  }
  async workflowEmployee(id: string) {
    const row = await this.db
      .prepare('SELECT hr_workflow_employee(?) AS data')
      .get(id);
    if (!row?.data) throw new NotFoundException('Employee not found');
    return JSON.parse(row.data as string) as Pick<
      Employee,
      'id' | 'managerId' | 'department' | 'active' | 'role'
    >;
  }
  async scheduleHistory(actor: Actor, id: string) {
    requireHr(actor);
    await this.employee(id);
    return await Promise.all(
      (
        await this.db
          .prepare(
            'SELECT effective_from, schedule_id FROM employee_schedules WHERE employee_id = ? AND hr_branch_visible(hr_branch_at(employee_id,effective_from)) ORDER BY effective_from',
          )
          .all(id)
      ).map(async (row) => ({
        effectiveFrom: row.effective_from as string,
        schedule: await this.schedulesService.schedule(
          row.schedule_id as string,
          row.effective_from as string,
        ),
      })),
    );
  }
  async profile(actor: Actor) {
    return actor.employeeId ? await this.employee(actor.employeeId) : null;
  }
  async saveEmployee(actor: Actor, input: SaveEmployeeDto, id?: string) {
    requireHr(actor);
    const before = id ? await this.employee(id) : null;
    const branchId =
      input.branchId ??
      before?.branchId ??
      ((
        await this.db
          .prepare(
            'SELECT id FROM branches WHERE active AND (SELECT count(*) FROM branches WHERE active)=1',
          )
          .get()
      )?.id as string | undefined);
    if (
      !branchId ||
      !(await this.db
        .prepare('SELECT id FROM branches WHERE id=? AND active')
        .get(branchId))
    )
      throw new BadRequestException('Select an active permitted branch');
    if (before && branchId !== before.branchId)
      throw new BadRequestException(
        'Use branch assignment history to transfer an employee',
      );
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
    await this.schedulesService.schedule(input.scheduleId);
    if (!before && !input.password)
      throw new BadRequestException('An initial password is required');
    const hash = input.password ? await passwordHash(input.password) : null;
    // Password hashing yields; check access again before committing account changes.
    const current = (await this.db
      .prepare('SELECT role, active FROM users WHERE id = ?')
      .get(actor.id)) as {
      role: string;
      active: number;
    };
    if (!current?.active || current.role !== actor.role)
      throw new ForbiddenException('Your access changed. Sign in again.');
    if (
      id &&
      actor.role !== 'admin' &&
      ['hr', 'admin'].includes((await this.employee(id)).role)
    )
      throw new ForbiddenException(
        'Only administrators manage HR and administrator accounts',
      );
    const { password: _password, scheduleEffectiveFrom, ...fields } = input;
    let employee: Employee;
    try {
      await this.store.transaction(async () => {
        const assignmentChanged =
          !before ||
          input.scheduleId !== before.scheduleId ||
          scheduleEffectiveFrom !== undefined;
        const effectiveFrom = before
          ? (scheduleEffectiveFrom ?? (await this.schedulesService.today()))
          : input.startDate;
        if (
          assignmentChanged &&
          (effectiveFrom < input.startDate ||
            (before && effectiveFrom < (await this.schedulesService.today())))
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
          (await this.db
            .prepare(
              'SELECT 1 FROM employee_schedules WHERE employee_id = ? AND effective_from < ?',
            )
            .get(before.id, input.startDate))
        )
          throw new BadRequestException(
            'Employment date cannot be after an existing schedule assignment',
          );
        await this.db
          .prepare(
            'INSERT INTO departments (name) VALUES (?) ON CONFLICT DO NOTHING',
          )
          .run(input.department);
        const department = (await this.db
          .prepare('SELECT name FROM departments WHERE lower(name) = lower(?)')
          .get(input.department)) as {
          name: string;
        };
        employee = {
          ...fields,
          branchId,
          managerId: input.managerId ?? null,
          salesEnabled: input.salesEnabled ?? before?.salesEnabled ?? false,
          department: department.name,
          id: id ?? randomUUID(),
          employeeNumber:
            before?.employeeNumber ?? (await this.store.nextEmployeeNumber()),
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
          const manager = await this.workflowEmployee(employee.managerId);
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
          for (const report of await this.db
            .prepare(
              "SELECT id, data FROM employees WHERE (data::jsonb->>'managerId') = ?",
            )
            .all(employee.id)) {
            const updated = {
              ...(JSON.parse(report.data as string) as Employee),
              managerId: null,
            };
            await this.db
              .prepare('UPDATE employees SET data = ? WHERE id = ?')
              .run(JSON.stringify(updated), report.id as string);
            await this.auditService.record(
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
          for (const row of await this.db
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
            await this.db
              .prepare('UPDATE employee_requests SET data = ? WHERE id = ?')
              .run(JSON.stringify(after), request.id);
            await this.auditService.record(
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
          await this.db
            .prepare(
              'UPDATE employees SET code = ?, email = ?, data = ? WHERE id = ?',
            )
            .run(
              employee.nationalId,
              employee.email,
              JSON.stringify(employee),
              employee.id,
            );
          await this.db
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
            await this.db
              .prepare(
                'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE employee_id = ?)',
              )
              .run(employee.id);
        } else {
          await this.db
            .prepare(
              'INSERT INTO employees (id,code,email,data) VALUES (?, ?, ?, ?)',
            )
            .run(
              employee.id,
              employee.nationalId,
              employee.email,
              JSON.stringify(employee),
            );
          await this.db
            .prepare(
              'INSERT INTO users (id,email,name,role,employee_id,active,password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
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
        if (before?.role === 'hr' && employee.role !== 'hr')
          await this.db
            .prepare(
              'DELETE FROM hr_branch_grants WHERE user_id IN (SELECT id FROM users WHERE employee_id=?)',
            )
            .run(employee.id);
        if (assignmentChanged) {
          if (
            actor.role === 'hr' &&
            !(await this.db
              .prepare(
                'SELECT 1 FROM hr_branch_grants WHERE user_id=? AND branch_id=hr_branch_at(?,?)',
              )
              .get(actor.id, employee.id, effectiveFrom))
          )
            throw new ForbiddenException(
              'The schedule date is outside your assigned branches',
            );
          const previousAssignment = await this.db
            .prepare(
              'SELECT schedule_id FROM employee_schedules WHERE employee_id = ? AND effective_from = ?',
            )
            .get(employee.id, effectiveFrom);
          await this.db
            .prepare(
              'INSERT INTO employee_schedules (employee_id,effective_from,schedule_id) VALUES (?, ?, ?) ON CONFLICT(company_id,employee_id, effective_from) DO UPDATE SET schedule_id = excluded.schedule_id',
            )
            .run(employee.id, effectiveFrom, input.scheduleId);
          await this.auditService.record(
            actor,
            'employee.schedule_assigned',
            employee.id,
            previousAssignment
              ? { effectiveFrom, scheduleId: previousAssignment.schedule_id }
              : null,
            { effectiveFrom, scheduleId: input.scheduleId },
          );
        }
        employee = await this.currentEmployee(employee);
        await this.auditService.record(
          actor,
          before ? 'employee.updated' : 'employee.created',
          employee.id,
          before,
          employee,
        );
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '23505')
        throw new ConflictException('National ID or email already exists');
      throw error;
    }
    return employee!;
  }
}
