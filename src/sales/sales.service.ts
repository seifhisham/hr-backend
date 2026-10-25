import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { localTime } from '../attendance/attendance-time.js';
import { requireHr } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import { CompanyService } from '../company/company.service.js';
import { DatabaseService } from '../database/database.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import type { Employee } from '../employees/types/employee.type.js';
import type { z } from 'zod';
import type {
  ActivityInput,
  SalesActivity,
  SalesFilters,
  SalesTarget,
  reviewSchema,
  targetSchema,
} from './sales.dto.js';
@Injectable()
export class SalesService {
  constructor(
    @Inject(DatabaseService)
    private readonly store: DatabaseService,
    @Inject(AuditService)
    private readonly audit: AuditService,
    @Inject(CompanyService)
    private readonly company: CompanyService,
    @Inject(EmployeesService)
    private readonly employees: EmployeesService,
  ) {}
  private get db() {
    return this.store.db;
  }
  private async managedEmployees(actor: Actor): Promise<string[]> {
    return actor.role === 'manager'
      ? (await this.employees.managedEmployees(actor)).map(
          (employee) => employee.id,
        )
      : [];
  }
  async access(actor: Actor) {
    const employee = await this.employees.profile(actor);
    const granted =
      actor.role !== 'hr' ||
      !!(await this.db
        .prepare('SELECT 1 FROM hr_branch_grants WHERE user_id=? LIMIT 1')
        .get(actor.id));
    return {
      canSubmit: !!employee?.active && !!employee.salesEnabled,
      canReview: actor.role !== 'employee' && granted,
      canSetTargets: (actor.role === 'hr' && granted) || actor.role === 'admin',
    };
  }
  private async scope(
    actor: Actor,
    own: boolean,
    month?: string,
  ): Promise<Employee[]> {
    if (own)
      return actor.employeeId
        ? [await this.employees.employeeActor(actor)]
        : [];
    if (actor.role === 'employee')
      throw new ForbiddenException('Sales review access required');
    if (actor.role === 'hr' && month)
      return (
        await this.employees.historicalScope(
          actor,
          month + '-01',
          month + '-31',
        )
      ).employees;
    return actor.role === 'manager'
      ? await this.employees.managedEmployees(actor)
      : await this.employees.employees(actor);
  }
  private async canReview(actor: Actor, employee: Employee, date?: string) {
    if (
      actor.role === 'hr' &&
      !(await this.db
        .prepare(
          'SELECT 1 FROM hr_branch_grants WHERE user_id=? AND branch_id=hr_branch_at(?,?)',
        )
        .get(
          actor.id,
          employee.id,
          date ??
            localTime(new Date(), (await this.company.settings()).timezone)
              .date,
        ))
    )
      return false;
    return (
      employee.id !== actor.employeeId &&
      (actor.role === 'hr' ||
        actor.role === 'admin' ||
        (await this.managedEmployees(actor)).includes(employee.id))
    );
  }
  private async submitter(actor: Actor) {
    const employee = await this.employees.employeeActor(actor);
    if (!employee.active || !employee.salesEnabled)
      throw new ForbiddenException('Sales activity access is not enabled');
    return employee;
  }
  private async validateDate(employee: Employee, activity: ActivityInput) {
    const today = localTime(
      new Date(),
      (await this.company.settings()).timezone,
    ).date;
    if (
      activity.activityDate < employee.startDate ||
      activity.activityDate > today
    )
      throw new BadRequestException(
        'Activity date must be between employment start and today in company time',
      );
  }
  private async find(id: string): Promise<SalesActivity> {
    const row = await this.db
      .prepare('SELECT data FROM sales_activities WHERE id = ?')
      .get(id);
    if (!row) throw new NotFoundException('Sales activity not found');
    return JSON.parse(row.data as string) as SalesActivity;
  }
  private async present(actor: Actor, activity: SalesActivity) {
    const employee = await this.employees.historicalEmployee(
      actor,
      activity.employeeId,
      activity.activityDate,
    );
    return {
      ...activity,
      employeeName: employee.name,
      employeeNumber: employee.employeeNumber,
      department: employee.department,
      canReview: await this.canReview(actor, employee, activity.activityDate),
    };
  }
  async get(actor: Actor, id: string) {
    const activity = await this.find(id);
    const employee = await this.employees.historicalEmployee(
      actor,
      activity.employeeId,
      activity.activityDate,
    );
    if (
      activity.employeeId !== actor.employeeId &&
      !(await this.canReview(actor, employee, activity.activityDate))
    )
      throw new NotFoundException('Sales activity not found');
    return await this.present(actor, activity);
  }
  async list(actor: Actor, filters: SalesFilters, own = false) {
    const allowed = new Map(
      (await this.scope(actor, own, filters.month))
        .filter(
          (employee) =>
            (!filters.employeeId || employee.id === filters.employeeId) &&
            (!filters.department || employee.department === filters.department),
        )
        .map((employee) => [employee.id, employee]),
    );
    return (await this.activities(filters.month, [...allowed.keys()]))
      .filter(
        (activity) =>
          (!filters.kind || activity.kind === filters.kind) &&
          (!filters.status || activity.status === filters.status),
      )
      .map((activity) => {
        const employee = allowed.get(activity.employeeId)!;
        return {
          ...activity,
          employeeName: employee.name,
          employeeNumber: employee.employeeNumber,
          department: employee.department,
          canReview:
            employee.id !== actor.employeeId && actor.role !== 'employee',
        };
      });
  }
  private async activities(
    month: string,
    employeeIds: string[],
  ): Promise<SalesActivity[]> {
    if (!employeeIds.length) return [];
    return (
      await this.db
        .prepare(
          "SELECT data FROM sales_activities WHERE activity_date >= ? AND activity_date < to_char((?::date + interval '1 month'),'YYYY-MM-DD') AND employee_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)) ORDER BY activity_date DESC, row_order DESC",
        )
        .all(`${month}-01`, `${month}-01`, JSON.stringify(employeeIds))
    ).map((row) => JSON.parse(row.data as string) as SalesActivity);
  }
  private async write(activity: SalesActivity) {
    try {
      await this.db
        .prepare(
          `INSERT INTO sales_activities (id,employee_id,activity_date,deal_reference,data) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(company_id,id) DO UPDATE SET activity_date = excluded.activity_date, deal_reference = excluded.deal_reference, data = excluded.data`,
        )
        .run(
          activity.id,
          activity.employeeId,
          activity.activityDate,
          activity.kind === 'closed-deal' ? activity.dealReference : null,
          JSON.stringify(activity),
        );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '23505')
        throw new ConflictException(
          'This deal reference is already registered',
        );
      if (error instanceof Error && 'code' in error && error.code === '23514')
        throw new BadRequestException(
          'Activity dates cannot cross a branch transfer',
        );
      throw error;
    }
  }
  async create(actor: Actor, id: string, input: ActivityInput) {
    const employee = await this.submitter(actor);
    await this.validateDate(employee, input);
    return await this.store.transaction(async () => {
      const existing = await this.db
        .prepare('SELECT data FROM sales_activities WHERE id = ?')
        .get(id);
      if (existing) {
        const activity = JSON.parse(existing.data as string) as SalesActivity;
        const {
          id: _id,
          employeeId: _employee,
          submittedAt: _submitted,
          updatedAt: _updated,
          revision: _revision,
          status: _status,
          review: _review,
          ...original
        } = activity;
        if (
          activity.employeeId !== employee.id ||
          JSON.stringify(original) !== JSON.stringify(input)
        )
          throw new ConflictException(
            'Submission ID was already used for different activity data',
          );
        return await this.present(actor, activity);
      }
      const now = new Date().toISOString();
      const activity: SalesActivity = {
        ...input,
        id,
        employeeId: employee.id,
        submittedAt: now,
        updatedAt: now,
        revision: 1,
        status: 'pending',
        review: null,
      };
      await this.write(activity);
      await this.audit.record(
        actor,
        'sales.activity.created',
        id,
        null,
        activity,
      );
      return await this.present(actor, activity);
    });
  }
  async update(
    actor: Actor,
    id: string,
    revision: number,
    input: ActivityInput,
  ) {
    const employee = await this.submitter(actor);
    await this.validateDate(employee, input);
    return await this.store.transaction(async () => {
      const before = await this.find(id);
      if (before.employeeId !== employee.id)
        throw new NotFoundException('Sales activity not found');
      if (before.revision !== revision || before.status === 'verified')
        throw new ConflictException(
          'Activity changed or is verified. Refresh; verified entries must be returned for correction.',
        );
      const after: SalesActivity = {
        ...input,
        id,
        employeeId: employee.id,
        submittedAt: before.submittedAt,
        updatedAt: new Date().toISOString(),
        revision: before.revision + 1,
        status: 'pending',
        review: before.review,
      };
      await this.write(after);
      await this.audit.record(
        actor,
        'sales.activity.updated',
        id,
        before,
        after,
      );
      return await this.present(actor, after);
    });
  }
  async review(actor: Actor, id: string, input: z.infer<typeof reviewSchema>) {
    return await this.store.transaction(async () => {
      const before = await this.find(id);
      if (
        !(await this.canReview(
          actor,
          await this.employees.historicalEmployee(
            actor,
            before.employeeId,
            before.activityDate,
          ),
          before.activityDate,
        ))
      )
        throw new ForbiddenException(
          'Only HR or the assigned direct manager can review another employee’s activity',
        );
      if (
        before.revision !== input.expectedRevision ||
        (input.status === 'verified'
          ? before.status !== 'pending'
          : before.status === 'returned')
      )
        throw new ConflictException(
          'Activity changed or this review is no longer available. Refresh first.',
        );
      const now = new Date().toISOString();
      const after: SalesActivity = {
        ...before,
        status: input.status,
        revision: before.revision + 1,
        updatedAt: now,
        review: {
          status: input.status,
          reason: input.reason,
          by: actor.name,
          byId: actor.id,
          at: now,
        },
      };
      await this.write(after);
      await this.audit.record(
        actor,
        `sales.activity.${input.status}`,
        id,
        before,
        after,
        input.reason,
      );
      return await this.present(actor, after);
    });
  }
  private async target(
    employeeId: string,
    month: string,
  ): Promise<SalesTarget | null> {
    const row = await this.db
      .prepare(
        'SELECT data FROM sales_targets WHERE employee_id = ? AND month = ?',
      )
      .get(employeeId, month);
    return row ? (JSON.parse(row.data as string) as SalesTarget) : null;
  }
  async saveTarget(actor: Actor, input: z.infer<typeof targetSchema>) {
    requireHr(actor);
    if (
      !(
        await this.db
          .prepare('SELECT hr_month_visible(?,?) AS allowed')
          .get(input.employeeId, input.month)
      )?.allowed
    )
      throw new BadRequestException(
        'Targets span branches outside your access',
      );
    const employee = await this.employees.historicalEmployee(
      actor,
      input.employeeId,
      input.month + '-01',
    );
    if (!employee.active || !employee.salesEnabled)
      throw new BadRequestException('Select an active sales-enabled employee');
    if (input.month < employee.startDate.slice(0, 7))
      throw new BadRequestException('Target month precedes employment');
    return await this.store.transaction(async () => {
      const before = await this.target(employee.id, input.month);
      if ((before?.revision ?? 0) !== input.expectedRevision)
        throw new ConflictException('Targets changed. Refresh before saving.');
      const { expectedRevision: _revision, ...fields } = input;
      const after: SalesTarget = {
        ...fields,
        revision: (before?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: actor.name,
      };
      await this.db
        .prepare(
          'INSERT INTO sales_targets (employee_id,month,data) VALUES (?, ?, ?) ON CONFLICT(company_id,employee_id, month) DO UPDATE SET data = excluded.data',
        )
        .run(employee.id, input.month, JSON.stringify(after));
      await this.audit.record(
        actor,
        'sales.target.saved',
        employee.id,
        before,
        after,
        input.reason,
      );
      return after;
    });
  }
  async performance(
    actor: Actor,
    filters: Pick<SalesFilters, 'month' | 'department' | 'employeeId'>,
    own = false,
  ) {
    const employees = (await this.scope(actor, own, filters.month)).filter(
      (employee) =>
        employee.startDate.slice(0, 7) <= filters.month &&
        (!filters.department || employee.department === filters.department) &&
        (!filters.employeeId || employee.id === filters.employeeId),
    );
    const employeeIds = employees.map((employee) => employee.id);
    const byEmployee = new Map<string, SalesActivity[]>();
    for (const activity of await this.activities(filters.month, employeeIds)) {
      const entries = byEmployee.get(activity.employeeId) ?? [];
      entries.push(activity);
      byEmployee.set(activity.employeeId, entries);
    }
    const targets = new Map(
      (
        await this.db
          .prepare(
            'SELECT employee_id, data FROM sales_targets WHERE month = ? AND employee_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))',
          )
          .all(filters.month, JSON.stringify(employeeIds))
      ).map((row) => [
        row.employee_id as string,
        JSON.parse(row.data as string) as SalesTarget,
      ]),
    );
    return employees.flatMap((employee) => {
      const entries = byEmployee.get(employee.id) ?? [];
      const target = targets.get(employee.id) ?? null;
      if (!employee.salesEnabled && !entries.length && !target) return [];
      const verified = entries.filter(
        (activity) => activity.status === 'verified',
      );
      const meetings = verified.filter(
        (activity) => activity.kind === 'meeting',
      ).length;
      const viewings = verified.filter(
        (activity) => activity.kind === 'viewing',
      ).length;
      const deals = verified.filter(
        (activity) => activity.kind === 'closed-deal',
      );
      const cents = new Map<string, number>();
      for (const deal of deals)
        if (deal.kind === 'closed-deal')
          cents.set(
            deal.currency,
            (cents.get(deal.currency) ?? 0) + Math.round(deal.value * 100),
          );
      const values = Object.fromEntries(
        [...cents.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, value]) => [currency, value / 100]),
      );
      const percentage = (actual: number, goal: number | undefined | null) =>
        goal ? Math.round((actual / goal) * 1000) / 10 : null;
      return [
        {
          employeeId: employee.id,
          employeeName: employee.name,
          employeeNumber: employee.employeeNumber,
          department: employee.department,
          active: employee.active,
          salesEnabled: employee.salesEnabled,
          month: filters.month,
          meetings,
          viewings,
          meetingTotal: meetings + viewings,
          deals: deals.length,
          sales: deals.filter(
            (activity) =>
              activity.kind === 'closed-deal' &&
              activity.transactionType === 'sale',
          ).length,
          leases: deals.filter(
            (activity) =>
              activity.kind === 'closed-deal' &&
              activity.transactionType === 'lease',
          ).length,
          transactionValues: values,
          pending: entries.filter((activity) => activity.status === 'pending')
            .length,
          returned: entries.filter((activity) => activity.status === 'returned')
            .length,
          target,
          achievement: {
            meetings: percentage(meetings + viewings, target?.meetings),
            deals: percentage(deals.length, target?.deals),
            transactionValue: percentage(
              target?.currency ? (values[target.currency] ?? 0) : 0,
              target?.transactionValue,
            ),
          },
        },
      ];
    });
  }
}
