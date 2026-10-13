import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ApprovePayrollDto } from './dto/approval.dto.js';
import type { PayrollRun, PayrollRow } from './types/payroll-run.type.js';
import { requireUnlockedPayroll } from './payroll-lock.js';
import { AuditService } from '../audit/audit.service.js';
import { requireHr } from '../common/security/permissions.js';
import { DatabaseService } from '../database/database.service.js';
import type { AddDeductionDto, PayrollDeduction } from './dto/deduction.dto.js';
import { localTime } from '../attendance/attendance-time.js';
import { CompanyService } from '../company/company.service.js';
import type { Actor } from '../common/types/actor.type.js';
import { EmployeesService } from '../employees/employees.service.js';
import type { EmployeeRequest } from '../requests/types/employee-request.type.js';

@Injectable()
export class PayrollService {
  constructor(
    @Inject(EmployeesService)
    private readonly employeesService: EmployeesService,
    @Inject(CompanyService) private readonly companyService: CompanyService,
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  addDeduction(actor: Actor, input: AddDeductionDto) {
    requireHr(actor);
    return this.store.transaction(() => {
      requireUnlockedPayroll(this.store.db, input.month);
      const employee = this.employeesService.employee(input.employeeId);
      if (input.month < employee.startDate.slice(0, 7))
        throw new BadRequestException(
          'Deduction month cannot be before employment',
        );
      const deduction: PayrollDeduction = {
        ...input,
        id: randomUUID(),
        recordedAt: new Date().toISOString(),
        recordedBy: actor.name,
        recordedById: actor.id,
      };
      this.store.db
        .prepare(
          'INSERT INTO payroll_deductions (id, employee_id, month, data) VALUES (?, ?, ?, ?)',
        )
        .run(
          deduction.id,
          employee.id,
          deduction.month,
          JSON.stringify(deduction),
        );
      this.auditService.record(
        actor,
        'payroll.deduction.created',
        deduction.id,
        null,
        deduction,
        deduction.reason,
      );
      return deduction;
    });
  }

  deductions(
    actor: Actor,
    range: { from: string; to: string },
  ): PayrollDeduction[] {
    requireHr(actor);
    const timezone = this.companyService.settings().timezone;
    return this.store.db
      .prepare('SELECT data FROM payroll_deductions ORDER BY rowid DESC')
      .all()
      .map((row) => JSON.parse(row.data as string) as PayrollDeduction)
      .filter((deduction) => {
        const date = localTime(new Date(deduction.recordedAt), timezone).date;
        return date >= range.from && date <= range.to;
      });
  }

  private approvedRun(month: string): PayrollRun | null {
    const row = this.store.db
      .prepare('SELECT data FROM payroll_runs WHERE month = ?')
      .get(month);
    return row ? (JSON.parse(row.data as string) as PayrollRun) : null;
  }

  run(actor: Actor, month: string): PayrollRun {
    requireHr(actor);
    const approved = this.approvedRun(month);
    if (approved) return approved;
    const { name: company, timezone } = this.companyService.settings();
    const rows = this.calculate(actor, month);
    const revision = createHash('sha256')
      .update(JSON.stringify({ month, company, timezone, rows }))
      .digest('hex');
    return {
      month,
      status: 'draft',
      company,
      timezone,
      revision,
      approvedAt: null,
      approvedBy: null,
      approvedById: null,
      approvalReason: null,
      rows,
    };
  }

  approve(actor: Actor, input: ApprovePayrollDto): PayrollRun {
    requireHr(actor);
    return this.store.transaction(() => {
      requireUnlockedPayroll(this.store.db, input.month);
      const draft = this.run(actor, input.month);
      if (input.month > localTime(new Date(), draft.timezone).date.slice(0, 7))
        throw new BadRequestException(
          'Future payroll months cannot be approved',
        );
      if (draft.revision !== input.expectedRevision)
        throw new ConflictException(
          'Payroll changed since it was reviewed. Refresh and review the updated payroll before approving.',
        );
      if (
        !draft.rows.length ||
        draft.rows.some((row) => row.grossSalary === null)
      )
        throw new ConflictException(
          'Configure all employee salaries before approving a non-empty payroll',
        );
      const approved: PayrollRun = {
        ...draft,
        status: 'approved',
        approvedAt: new Date().toISOString(),
        approvedBy: actor.name,
        approvedById: actor.id,
        approvalReason: input.reason,
      };
      this.store.db
        .prepare('INSERT INTO payroll_runs VALUES (?, ?)')
        .run(input.month, JSON.stringify(approved));
      this.auditService.record(
        actor,
        'payroll.approved',
        input.month,
        draft,
        approved,
        input.reason,
      );
      return approved;
    });
  }

  preview(actor: Actor, month: string): PayrollRow[] {
    requireHr(actor);
    return this.approvedRun(month)?.rows ?? this.calculate(actor, month);
  }

  private calculate(actor: Actor, month: string): PayrollRow[] {
    const employees = this.employeesService.employees(actor);
    const requests = this.store.db
      .prepare(
        "SELECT data FROM employee_requests WHERE status != 'pending' AND json_extract(data, '$.salaryDeductionDays') IS NOT NULL ORDER BY rowid DESC",
      )
      .all()
      .map((row) => JSON.parse(row.data as string) as EmployeeRequest);
    const { timezone } = this.companyService.settings();
    const manual = this.store.db
      .prepare(
        'SELECT data FROM payroll_deductions WHERE month = ? ORDER BY rowid DESC',
      )
      .all(month)
      .map((row) => JSON.parse(row.data as string) as PayrollDeduction);
    const requestsByEmployee = new Map<string, EmployeeRequest[]>();
    for (const request of requests) {
      if (
        !request.decidedAt ||
        localTime(new Date(request.decidedAt), timezone).date.slice(0, 7) !==
          month
      )
        continue;
      const deductions = requestsByEmployee.get(request.employeeId) ?? [];
      deductions.push(request);
      requestsByEmployee.set(request.employeeId, deductions);
    }
    const manualByEmployee = new Map<string, PayrollDeduction[]>();
    for (const deduction of manual) {
      const deductions = manualByEmployee.get(deduction.employeeId) ?? [];
      deductions.push(deduction);
      manualByEmployee.set(deduction.employeeId, deductions);
    }
    return employees
      .filter((employee) => employee.startDate.slice(0, 7) <= month)
      .map((employee) => {
        const deductions = (requestsByEmployee.get(employee.id) ?? []).map(
          (request) => ({
            requestId: request.id,
            status: request.status,
            decidedAt: request.decidedAt,
            days: request.salaryDeductionDays!,
          }),
        );
        const manualDeductions = manualByEmployee.get(employee.id) ?? [];
        const deductionDays =
          manualDeductions.reduce(
            (total, deduction) => total + deduction.days,
            0,
          ) +
          deductions.reduce((total, deduction) => total + deduction.days, 0);
        const grossCents =
          employee.monthlySalary === null
            ? null
            : Math.round(employee.monthlySalary * 100);
        // Calculate from integer cents; round the total deduction once, not each day's rate.
        const deductionCents =
          grossCents === null
            ? null
            : Math.round((grossCents * deductionDays) / 30);
        return {
          employeeId: employee.id,
          employeeNumber: employee.employeeNumber,
          name: employee.name,
          department: employee.department,
          active: employee.active,
          month,
          currency: employee.salaryCurrency,
          grossSalary: grossCents === null ? null : grossCents / 100,
          dailyRate:
            grossCents === null ? null : Math.round(grossCents / 30) / 100,
          deductionDays,
          deductionAmount:
            deductionCents === null ? null : deductionCents / 100,
          netSalary:
            grossCents === null ? null : (grossCents - deductionCents!) / 100,
          deductions,
          manualDeductions,
        };
      });
  }
}
