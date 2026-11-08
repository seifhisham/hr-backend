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
import { requireHr, requireAdmin } from '../common/security/permissions.js';
import { DatabaseService } from '../database/database.service.js';
import type { AddDeductionDto, PayrollDeduction } from './dto/deduction.dto.js';
import { localTime } from '../attendance/attendance-time.js';
import { CompanyService } from '../company/company.service.js';
import type { Actor } from '../common/types/actor.type.js';
import { EmployeesService } from '../employees/employees.service.js';
import type { EmployeeRequest } from '../requests/types/employee-request.type.js';
import type { BankDetails } from './dto/bank-details.dto.js';
@Injectable()
export class PayrollService {
  constructor(
    @Inject(EmployeesService)
    private readonly employeesService: EmployeesService,
    @Inject(CompanyService)
    private readonly companyService: CompanyService,
    @Inject(DatabaseService)
    private readonly store: DatabaseService,
    @Inject(AuditService)
    private readonly auditService: AuditService,
  ) {}
  async bankDetails(actor: Actor): Promise<BankDetails> {
    requireHr(actor);
    const allowed = new Set(
      (await this.employeesService.employees(actor, true))
        .filter((employee) => employee.role !== 'admin')
        .map((employee) => employee.id),
    );
    const stored = await this.store
      .prepare("SELECT key,value FROM settings WHERE key LIKE 'payroll-bank:%'")
      .all();
    const settings = stored.find((row) => row.key === 'payroll-bank:company');
    return {
      settings: settings
        ? (JSON.parse(settings.value as string) as BankDetails['settings'])
        : {
            debitAccount: '',
            transactionTypeCode: 'BT',
            purposeCode: '13',
            paymentType: 'SALARY',
            purposeOfPayment: 'SALARY',
          },
      employees: stored
        .filter((row) =>
          allowed.has(String(row.key).slice('payroll-bank:'.length)),
        )
        .map(
          (row) =>
            JSON.parse(row.value as string) as BankDetails['employees'][number],
        ),
    };
  }
  async saveBankDetails(actor: Actor, input: BankDetails) {
    requireHr(actor);
    return this.store.transaction(async () => {
      // Validate the entire batch against current branch access before writing any bank details.
      for (const row of input.employees) {
        if (
          (await this.employeesService.employee(row.employeeId)).role ===
          'admin'
        )
          throw new BadRequestException(
            'Administrator accounts are excluded from bank payroll',
          );
      }
      for (const [key, value] of [
        ['payroll-bank:company', input.settings],
        ...input.employees.map(
          (row) => [`payroll-bank:${row.employeeId}`, row] as const,
        ),
      ] as const) {
        await this.store
          .prepare(
            'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(company_id,key) DO UPDATE SET value=excluded.value',
          )
          .run(key, JSON.stringify(value));
      }
      await this.auditService.record(
        actor,
        'payroll.bank_details.updated',
        'payroll-bank',
        null,
        { employeeIds: input.employees.map((row) => row.employeeId) },
      );
      return { message: 'Bank details saved' };
    });
  }
  async addDeduction(actor: Actor, input: AddDeductionDto) {
    requireHr(actor);
    return await this.store.transaction(async () => {
      await requireUnlockedPayroll(this.store.db, input.month);
      const visible = await this.store
        .prepare('SELECT hr_month_visible(?,?) AS allowed')
        .get(input.employeeId, input.month);
      if (!visible?.allowed)
        throw new BadRequestException(
          'Payroll spans branches outside your access',
        );
      const employee = await this.employeesService.historicalEmployee(
        actor,
        input.employeeId,
        input.month + '-01',
      );
      if (
        employee.role === 'admin' ||
        (await this.employeesService.workflowEmployee(input.employeeId))
          .role === 'admin'
      )
        throw new BadRequestException(
          'Administrator accounts are exempt from salary deductions',
        );
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
      await this.store.db
        .prepare(
          'INSERT INTO payroll_deductions (id, employee_id, month, data) VALUES (?, ?, ?, ?)',
        )
        .run(
          deduction.id,
          employee.id,
          deduction.month,
          JSON.stringify(deduction),
        );
      await this.auditService.record(
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
  async deductions(
    actor: Actor,
    range: {
      from: string;
      to: string;
    },
  ): Promise<PayrollDeduction[]> {
    requireHr(actor);
    const timezone = (await this.companyService.settings()).timezone;
    return (
      await this.store.db
        .prepare('SELECT data FROM payroll_deductions ORDER BY row_order DESC')
        .all()
    )
      .map((row) => JSON.parse(row.data as string) as PayrollDeduction)
      .filter((deduction) => {
        const date = localTime(new Date(deduction.recordedAt), timezone).date;
        return date >= range.from && date <= range.to;
      });
  }
  private async approvedRun(
    month: string,
    actor?: Actor,
  ): Promise<PayrollRun | null> {
    const row = await this.store.db
      .prepare(
        actor?.role === 'hr'
          ? 'SELECT hr_payroll_run(?) AS data'
          : 'SELECT data FROM payroll_runs WHERE month = ?',
      )
      .get(month);
    return row?.data ? (JSON.parse(row.data as string) as PayrollRun) : null;
  }
  async run(actor: Actor, month: string): Promise<PayrollRun> {
    requireHr(actor);
    const approved = await this.approvedRun(month, actor);
    if (approved) return approved;
    const { name: company, timezone } = await this.companyService.settings();
    const rows = await this.calculate(actor, month);
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
  async approve(actor: Actor, input: ApprovePayrollDto): Promise<PayrollRun> {
    requireAdmin(actor);
    return await this.store.transaction(async () => {
      await requireUnlockedPayroll(this.store.db, input.month);
      const draft = await this.run(actor, input.month);
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
      await this.store.db
        .prepare('INSERT INTO payroll_runs (month,data) VALUES (?, ?)')
        .run(input.month, JSON.stringify(approved));
      await this.auditService.record(
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
  async preview(actor: Actor, month: string): Promise<PayrollRow[]> {
    requireHr(actor);
    return (
      (await this.approvedRun(month, actor))?.rows ??
      (await this.calculate(actor, month))
    );
  }
  private async calculate(actor: Actor, month: string): Promise<PayrollRow[]> {
    const candidates =
      actor.role === 'hr'
        ? (
            await this.employeesService.historicalScope(
              actor,
              month + '-01',
              month + '-31',
            )
          ).employees
        : await this.employeesService.employees(actor, true);
    const visible = new Set(
      (
        await this.store
          .prepare(
            'SELECT employee_id FROM employee_branches WHERE hr_month_visible(employee_id,?)',
          )
          .all(month)
      ).map((row) => row.employee_id),
    );
    const employees = candidates.filter(
      (employee) =>
        employee.role !== 'admin' &&
        (actor.role !== 'hr' || visible.has(employee.id)),
    );
    const requests = (
      await this.store.db
        .prepare(
          "SELECT data FROM employee_requests WHERE status != 'pending' AND (data::jsonb->>'salaryDeductionDays') IS NOT NULL ORDER BY row_order DESC",
        )
        .all()
    ).map((row) => JSON.parse(row.data as string) as EmployeeRequest);
    const { timezone } = await this.companyService.settings();
    const manual = (
      await this.store.db
        .prepare(
          'SELECT data FROM payroll_deductions WHERE month = ? ORDER BY row_order DESC',
        )
        .all(month)
    ).map((row) => JSON.parse(row.data as string) as PayrollDeduction);
    const requestsByEmployee = new Map<string, EmployeeRequest[]>();
    for (const request of requests) {
      if (
        (request.type === 'mission' && request.status === 'approved') ||
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
      .filter(
        (employee) =>
          employee.startDate.slice(0, 7) <= month &&
          (!employee.deletedAt ||
            month <=
              localTime(new Date(employee.deletedAt), timezone).date.slice(
                0,
                7,
              )),
      )
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
