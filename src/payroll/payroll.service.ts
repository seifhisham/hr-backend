import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ApprovePayrollDto } from './dto/approval.dto.js';
import type {
  AbsenceDeduction,
  AutomaticDeduction,
  DeductionAdjustment,
  LateDeduction,
  NeverCheckedIn,
  PayrollRun,
  PayrollRow,
} from './types/payroll-run.type.js';
import {
  requireUnlockedPayroll,
  requireUnlockedRequest,
} from './payroll-lock.js';
import { AuditService } from '../audit/audit.service.js';
import { requireHr, requireAdmin } from '../common/security/permissions.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  AddDeductionDto,
  AdjustDeductionDto,
  PayrollDeduction,
} from './dto/deduction.dto.js';
import { localTime, minutesLate } from '../attendance/attendance-time.js';
import { arrivalExcuseMinutes } from '../attendance/arrival-excuses.js';
import {
  attendance,
  type AttendanceRow,
} from '../attendance/attendance.mapper.js';
import { DeductionPolicyService } from '../deduction-policy/deduction-policy.service.js';
import { lateArrivalDays } from '../deduction-policy/deduction-policy.js';
import { CompanyService } from '../company/company.service.js';
import type { Actor } from '../common/types/actor.type.js';
import { EmployeesService } from '../employees/employees.service.js';
import type { EmployeeRequest } from '../requests/types/employee-request.type.js';
import type { BankDetails } from './dto/bank-details.dto.js';
import type { AbsenceRule } from '../deduction-policy/deduction-policy.js';
import { SchedulesService } from '../schedules/schedules.service.js';
import {
  absenceEditable,
  absenceKey,
  calculateAbsences,
  monthDates,
  type AbsenceEmployee,
  type AbsenceOverride,
  type AbsenceRequest,
} from './absence-deductions.js';
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
    @Inject(DeductionPolicyService)
    private readonly deductionPolicy: DeductionPolicyService,
    @Inject(SchedulesService)
    private readonly schedulesService: SchedulesService,
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
  /** Employees on this actor's payroll for the month, respecting branch visibility. */
  private async payrollEmployees(
    actor: Actor,
    month: string,
    timezone: string,
  ) {
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
    return candidates.filter(
      (employee) =>
        employee.role !== 'admin' &&
        (actor.role !== 'hr' || visible.has(employee.id)) &&
        employee.startDate.slice(0, 7) <= month &&
        (!employee.deletedAt ||
          month <=
            localTime(new Date(employee.deletedAt), timezone).date.slice(0, 7)),
    );
  }
  private async calculate(actor: Actor, month: string): Promise<PayrollRow[]> {
    const { timezone } = await this.companyService.settings();
    const employees = await this.payrollEmployees(actor, month, timezone);
    const requests = (
      await this.store.db
        .prepare(
          "SELECT data FROM employee_requests WHERE status != 'pending' AND (data::jsonb->>'salaryDeductionDays') IS NOT NULL ORDER BY row_order DESC",
        )
        .all()
    ).map((row) => JSON.parse(row.data as string) as EmployeeRequest);
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
        // Older approved missions saved 1 day before missions became paid; policy-based values are used as saved.
        (request.type === 'mission' &&
          request.status === 'approved' &&
          !request.deductionPolicyApplied) ||
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
    const lateByEmployee = await this.lateDeductions(
      month,
      new Set(employees.map((employee) => employee.id)),
    );
    const absenceRule = (await this.deductionPolicy.current()).absence;
    const absences = absenceRule.enabled
      ? await this.absenceDeductions(month, employees, timezone, absenceRule)
      : null;
    return employees.map((employee) => {
      const deductions = (requestsByEmployee.get(employee.id) ?? []).map(
        (request) => ({
          requestId: request.id,
          type: request.type,
          status: request.status,
          decidedAt: request.decidedAt,
          days: request.salaryDeductionDays!,
          adjustment: request.salaryDeductionAdjustment ?? null,
        }),
      );
      const manualDeductions = manualByEmployee.get(employee.id) ?? [];
      const lateDeductions = lateByEmployee.get(employee.id) ?? [];
      const absenceDeductions = absences?.get(employee.id) ?? [];
      const deductionDays =
        lateDeductions.reduce((total, late) => total + late.days, 0) +
        manualDeductions.reduce(
          (total, deduction) => total + deduction.days,
          0,
        ) +
        deductions.reduce((total, deduction) => total + deduction.days, 0) +
        absenceDeductions.reduce((total, item) => total + item.days, 0);
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
        deductionAmount: deductionCents === null ? null : deductionCents / 100,
        netSalary:
          grossCents === null ? null : (grossCents - deductionCents!) / 100,
        deductions,
        manualDeductions,
        lateDeductions,
        // Omitted while the rule is off so existing drafts keep their revision.
        ...(absences ? { absenceDeductions } : {}),
      };
    });
  }
  /**
   * Loads the month once and computes in memory. Reads company-wide so a
   * branch-limited HR user gets the same result as an administrator; only
   * derived days for the employees passed in are returned.
   */
  private async absenceDeductions(
    month: string,
    employees: { id: string }[],
    timezone: string,
    rule: AbsenceRule,
  ) {
    const ids = employees.map((employee) => employee.id);
    const dates = monthDates(month);
    const from = dates[0];
    const to = dates.at(-1)!;
    const scope =
      'employee_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))';
    const idList = JSON.stringify(ids);
    return await this.store.companyRead(async () => {
      const db = this.store.db;
      const state = await this.employeeState(ids, timezone);
      const firsts = await db
        .prepare(
          `SELECT employee_id, MIN(work_date) AS first FROM attendance WHERE ${scope} GROUP BY employee_id`,
        )
        .all(idList);
      const attendanceRows = await db
        .prepare(
          `SELECT employee_id, work_date FROM attendance WHERE work_date >= ? AND work_date <= ? AND ${scope}`,
        )
        .all(from, to, idList);
      const requestRows = await db
        .prepare(
          `SELECT employee_id, status, data::jsonb->>'type' AS type, data::jsonb->>'from' AS from_date, data::jsonb->>'to' AS to_date
          FROM employee_requests WHERE status IN ('pending','approved','rejected')
          AND data::jsonb->>'from' <= ? AND data::jsonb->>'to' >= ? AND ${scope}`,
        )
        .all(to, from, idList);
      const overrideRows = await db
        .prepare('SELECT value FROM settings WHERE key LIKE ?')
        .all(`${absenceOverridePrefix}${month}:%`);
      const reader = await this.schedulesService.assignmentReader(ids);
      return calculateAbsences({
        month,
        rule,
        now: localTime(new Date(), timezone),
        employees: state,
        firstCheckIns: new Map(
          firsts.map((row) => [row.employee_id as string, row.first as string]),
        ),
        attended: new Set(
          attendanceRows.map((row) =>
            absenceKey(row.employee_id as string, row.work_date as string),
          ),
        ),
        requests: requestRows.map(
          (row): AbsenceRequest => ({
            employeeId: row.employee_id as string,
            type: row.type as string,
            status: row.status as string,
            from: row.from_date as string,
            to: row.to_date as string,
          }),
        ),
        scheduleAt: (employeeId, date) => {
          try {
            return reader(employeeId, date);
          } catch {
            // Without a resolvable schedule there is no scheduled workday to charge.
            return null;
          }
        },
        overrides: new Map(
          overrideRows.map((row) => {
            const value = JSON.parse(row.value as string) as AbsenceOverride;
            return [absenceKey(value.employeeId, value.workDate), value];
          }),
        ),
      });
    });
  }
  /** Current eligibility fields; branch snapshots can be stale after a transfer. */
  private async employeeState(ids: string[], timezone: string) {
    return (
      await this.store.db
        .prepare(
          `SELECT id, data::jsonb->>'role' AS role, (data::jsonb->>'active')::boolean AS active,
          data::jsonb->>'startDate' AS start_date, data::jsonb->>'deletedAt' AS deleted_at
          FROM employees WHERE id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))`,
        )
        .all(JSON.stringify(ids))
    ).map(
      (row): AbsenceEmployee => ({
        id: row.id as string,
        role: row.role as string,
        active: row.active === true,
        startDate: row.start_date as string,
        deletedDate: row.deleted_at
          ? localTime(new Date(row.deleted_at as string), timezone).date
          : null,
      }),
    );
  }
  /** Active employees with no attendance in any month. Never affects payroll. */
  async neverCheckedIn(actor: Actor, month: string): Promise<NeverCheckedIn[]> {
    requireHr(actor);
    const { timezone } = await this.companyService.settings();
    const employees = await this.payrollEmployees(actor, month, timezone);
    const ids = employees.map((employee) => employee.id);
    const today = localTime(new Date(), timezone).date;
    const { state, attended } = await this.store.companyRead(async () => ({
      state: await this.employeeState(ids, timezone),
      attended: new Set(
        (
          await this.store.db
            .prepare(
              'SELECT DISTINCT employee_id FROM attendance WHERE employee_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))',
            )
            .all(JSON.stringify(ids))
        ).map((row) => row.employee_id as string),
      ),
    }));
    const eligible = new Set(
      state
        .filter(
          (employee) =>
            employee.active &&
            !employee.deletedDate &&
            employee.role !== 'admin' &&
            employee.startDate.slice(0, 10) <= today,
        )
        .map((employee) => employee.id),
    );
    const last = monthDates(month).at(-1)!;
    const branches = await this.employeesService.historicalScope(
      actor,
      `${month}-01`,
      last,
    );
    return employees
      .filter(
        (employee) => eligible.has(employee.id) && !attended.has(employee.id),
      )
      .map((employee) => ({
        employeeId: employee.id,
        employeeName: employee.name,
        employeeNumber: employee.employeeNumber,
        department: employee.department,
        branchName:
          (
            branches.at(employee.id, last) ??
            branches.at(employee.id, `${month}-01`)
          )?.branchName ?? null,
        startDate: employee.startDate,
      }));
  }
  /** Late-arrival charges for the month's work dates under the current policy. */
  private async lateDeductions(month: string, employeeIds: Set<string>) {
    const result = new Map<string, LateDeduction[]>();
    const policy = (await this.deductionPolicy.current()).lateArrival;
    if (!policy.enabled) return result;
    const from = `${month}-01`;
    const to = `${month}-31`;
    const approved = (
      await this.store.db
        .prepare(
          "SELECT data FROM employee_requests WHERE status = 'approved' AND data::jsonb->>'from' <= ? AND data::jsonb->>'to' >= ?",
        )
        .all(to, from)
    ).map((row) => JSON.parse(row.data as string) as EmployeeRequest);
    // Arriving-late excuses always apply, by their minutes, so payroll matches the attendance status.
    const excusedMinutes = arrivalExcuseMinutes(approved);
    const covered = new Map<string, { from: string; to: string }[]>();
    if (policy.exemptApprovedRequests)
      for (const request of approved) {
        if (request.type === 'forgotten-check-out' || request.type === 'excuse')
          continue;
        const ranges = covered.get(request.employeeId) ?? [];
        ranges.push({ from: request.from, to: request.to });
        covered.set(request.employeeId, ranges);
      }
    const rows = (await this.store.db
      .prepare(
        'SELECT * FROM attendance WHERE work_date >= ? AND work_date <= ? ORDER BY work_date',
      )
      .all(from, to)) as AttendanceRow[];
    const overrides = await this.lateOverrides();
    const lateCount = new Map<string, number>();
    for (const record of rows.map(attendance)) {
      if (!employeeIds.has(record.employeeId)) continue;
      const late = minutesLate(
        record,
        excusedMinutes.get(`${record.employeeId}:${record.workDate}`) ?? 0,
      );
      if (!late) continue;
      const excused = (covered.get(record.employeeId) ?? []).some(
        (range) => range.from <= record.workDate && range.to >= record.workDate,
      );
      const count = excused ? 0 : (lateCount.get(record.employeeId) ?? 0) + 1;
      if (!excused) lateCount.set(record.employeeId, count);
      const exemption = excused
        ? 'approved-request'
        : count <= policy.freeLatesPerMonth
          ? 'free-allowance'
          : null;
      const automaticDays = exemption ? 0 : lateArrivalDays(policy, late);
      const override = overrides.get(record.id);
      const list = result.get(record.employeeId) ?? [];
      list.push({
        attendanceId: record.id,
        workDate: record.workDate,
        minutesLate: late,
        automaticDays,
        days: override?.days ?? automaticDays,
        exemption,
        adjustment: override?.adjustment ?? null,
      });
      result.set(record.employeeId, list);
    }
    return result;
  }
  private async lateOverrides() {
    return new Map(
      (
        await this.store.db
          .prepare(
            `SELECT key,value FROM settings WHERE key LIKE '${lateOverridePrefix}%'`,
          )
          .all()
      ).map((row) => [
        String(row.key).slice(lateOverridePrefix.length),
        JSON.parse(row.value as string) as LateOverride,
      ]),
    );
  }
  /** Automatic request and late-arrival deductions for HR review, from the draft or approved run. */
  async automaticDeductions(
    actor: Actor,
    month: string,
  ): Promise<AutomaticDeduction[]> {
    requireHr(actor);
    const run = await this.run(actor, month);
    const locked = run.status === 'approved';
    return run.rows.flatMap((row) => {
      const employee = {
        employeeId: row.employeeId,
        employeeName: row.name,
        employeeNumber: row.employeeNumber,
        department: row.department,
      };
      return [
        ...row.deductions.map((item): AutomaticDeduction => ({
          source: 'request',
          id: item.requestId,
          ...employee,
          date: item.decidedAt,
          detail: `${item.type ?? 'Request'} ${item.status}`,
          automaticDays: item.adjustment?.originalDays ?? item.days,
          days: item.days,
          adjustment: item.adjustment ?? null,
          locked,
        })),
        ...(row.lateDeductions ?? []).map((item): AutomaticDeduction => ({
          source: 'late',
          id: item.attendanceId,
          ...employee,
          date: item.workDate,
          detail: `Late arrival, ${item.minutesLate} min${
            item.exemption === 'free-allowance'
              ? ' (free allowance)'
              : item.exemption === 'approved-request'
                ? ' (covered by approved request)'
                : ''
          }`,
          automaticDays: item.automaticDays ?? item.days,
          days: item.days,
          adjustment: item.adjustment ?? null,
          locked,
        })),
        // Approved runs saved before this rule have no absence data.
        ...(row.absenceDeductions ?? []).map((item): AutomaticDeduction => ({
          source: 'absence',
          id: absenceKey(row.employeeId, item.workDate),
          ...employee,
          date: item.workDate,
          detail: absenceDetail(item),
          automaticDays: item.automaticDays,
          days: item.days,
          adjustment: item.adjustment,
          locked,
          workDate: item.workDate,
          absenceStatus: item.status,
          absenceCause: item.cause,
          requestType: item.requestType,
          editable: absenceEditable(item.cause),
        })),
      ];
    });
  }
  /** Edits or removes (0 days) one absence, keyed by employee and work date. */
  async adjustAbsenceDeduction(
    actor: Actor,
    employeeId: string,
    workDate: string,
    input: AdjustDeductionDto,
  ) {
    requireHr(actor);
    return await this.store.transaction(async () => {
      const month = workDate.slice(0, 7);
      await this.requireEditable(employeeId, month);
      const { timezone } = await this.companyService.settings();
      const rule = (await this.deductionPolicy.current()).absence;
      if (!rule.enabled)
        throw new ConflictException('The absence rule is turned off');
      const employee = (
        await this.payrollEmployees(actor, month, timezone)
      ).find((value) => value.id === employeeId);
      if (!employee) throw new NotFoundException('Employee not found');
      const item = (
        await this.absenceDeductions(month, [employee], timezone, rule)
      )
        .get(employeeId)
        ?.find((value) => value.workDate === workDate);
      if (!item) throw new ConflictException('No absence applies to this date');
      if (!absenceEditable(item.cause))
        throw new ConflictException(
          item.cause === 'pending-request'
            ? 'Decide the pending request for this date first'
            : 'The rejected request already carries the deduction for this date',
        );
      if (item.days === input.days)
        throw new BadRequestException('The deduction already has this value');
      const override: AbsenceOverride = {
        employeeId,
        month,
        workDate,
        cause: item.cause,
        days: input.days,
        adjustment: {
          originalDays: item.automaticDays,
          reason: input.reason,
          by: actor.name,
          byId: actor.id,
          at: new Date().toISOString(),
        },
      };
      await this.store
        .prepare(
          'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(company_id,key) DO UPDATE SET value=excluded.value',
        )
        .run(
          `${absenceOverridePrefix}${month}:${employeeId}:${workDate}`,
          JSON.stringify(override),
        );
      await this.auditService.record(
        actor,
        `payroll.absence.${input.days === 0 ? 'deduction_removed' : 'deduction_adjusted'}`,
        absenceKey(employeeId, workDate),
        { employeeId, month, workDate, days: item.days },
        {
          employeeId,
          month,
          workDate,
          days: input.days,
          originalDays: item.automaticDays,
        },
        input.reason,
      );
      return { ...item, days: input.days, adjustment: override.adjustment };
    });
  }
  /** Edits (or removes, with 0 days) one automatic deduction; every change is audited. */
  async adjustAutomaticDeduction(
    actor: Actor,
    source: 'request' | 'late',
    id: string,
    input: AdjustDeductionDto,
  ) {
    requireHr(actor);
    return await this.store.transaction(async () => {
      const { timezone } = await this.companyService.settings();
      const adjustment = (originalDays: number): DeductionAdjustment => ({
        originalDays,
        reason: input.reason,
        by: actor.name,
        byId: actor.id,
        at: new Date().toISOString(),
      });
      const action =
        input.days === 0 ? 'deduction_removed' : 'deduction_adjusted';
      if (source === 'request') {
        const row = await this.store.db
          .prepare('SELECT data FROM employee_requests WHERE id = ?')
          .get(id);
        if (!row) throw new NotFoundException('Request not found');
        const request = JSON.parse(row.data as string) as EmployeeRequest;
        if (request.salaryDeductionDays === null || !request.decidedAt)
          throw new ConflictException(
            'This request has no automatic salary deduction',
          );
        const month = localTime(
          new Date(request.decidedAt),
          timezone,
        ).date.slice(0, 7);
        await this.requireEditable(request.employeeId, month);
        await requireUnlockedRequest(this.store.db, id);
        if (request.salaryDeductionDays === input.days)
          throw new BadRequestException('The deduction already has this value');
        const after: EmployeeRequest = {
          ...request,
          salaryDeductionDays: input.days,
          salaryDeductionAdjustment: adjustment(
            request.salaryDeductionAdjustment?.originalDays ??
              request.salaryDeductionDays,
          ),
        };
        await this.store.db
          .prepare('UPDATE employee_requests SET data = ? WHERE id = ?')
          .run(JSON.stringify(after), id);
        await this.auditService.record(
          actor,
          `request.${action}`,
          id,
          {
            employeeId: request.employeeId,
            month,
            days: request.salaryDeductionDays,
          },
          {
            employeeId: request.employeeId,
            month,
            days: input.days,
            originalDays: after.salaryDeductionAdjustment!.originalDays,
          },
          input.reason,
        );
        return after;
      }
      const record = (await this.store.db
        .prepare('SELECT * FROM attendance WHERE id = ?')
        .get(id)) as AttendanceRow | undefined;
      if (!record) throw new NotFoundException('Attendance not found');
      const month = record.work_date.slice(0, 7);
      await this.requireEditable(record.employee_id, month);
      const item = (
        await this.lateDeductions(month, new Set([record.employee_id]))
      )
        .get(record.employee_id)
        ?.find((late) => late.attendanceId === id);
      if (!item)
        throw new ConflictException(
          'No automatic late-arrival deduction applies to this attendance',
        );
      if (item.days === input.days)
        throw new BadRequestException('The deduction already has this value');
      const override: LateOverride = {
        employeeId: record.employee_id,
        month,
        days: input.days,
        adjustment: adjustment(item.automaticDays ?? item.days),
      };
      await this.store
        .prepare(
          'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(company_id,key) DO UPDATE SET value=excluded.value',
        )
        .run(lateOverridePrefix + id, JSON.stringify(override));
      await this.auditService.record(
        actor,
        `attendance.${action}`,
        id,
        { employeeId: record.employee_id, month, days: item.days },
        {
          employeeId: record.employee_id,
          month,
          days: input.days,
          originalDays: override.adjustment.originalDays,
        },
        input.reason,
      );
      return { ...item, days: input.days, adjustment: override.adjustment };
    });
  }
  private async requireEditable(employeeId: string, month: string) {
    await requireUnlockedPayroll(this.store.db, month);
    const visible = await this.store
      .prepare('SELECT hr_month_visible(?,?) AS allowed')
      .get(employeeId, month);
    if (!visible?.allowed)
      throw new BadRequestException(
        'Payroll spans branches outside your access',
      );
    if (
      (await this.employeesService.workflowEmployee(employeeId)).role ===
      'admin'
    )
      throw new BadRequestException(
        'Administrator accounts are exempt from salary deductions',
      );
  }
}

const lateOverridePrefix = 'late-deduction:';
const absenceOverridePrefix = 'absence-deduction:';
const absenceDetail = (item: AbsenceDeduction) =>
  item.cause === 'no-record'
    ? 'Absent, no check-in or request'
    : item.cause === 'pending-request'
      ? `Held for review, ${item.requestType} request pending`
      : item.cause === 'approved-excuse'
        ? 'Held for review, approved excuse'
        : `Covered by rejected ${item.requestType} request`;
type LateOverride = {
  employeeId: string;
  month: string;
  days: number;
  adjustment: DeductionAdjustment;
};
