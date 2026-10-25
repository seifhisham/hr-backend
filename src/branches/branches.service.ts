import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../common/types/actor.type.js';
import { requireAdmin, requireHr } from '../common/security/permissions.js';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { BranchInput } from './branch.dto.js';
import { localTime } from '../attendance/attendance-time.js';
@Injectable()
export class BranchesService {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  private async today() {
    const company = await this.store
      .prepare('SELECT timezone FROM companies')
      .get();
    return localTime(new Date(), company!.timezone as string).date;
  }
  async list(actor: Actor) {
    requireHr(actor);
    return (
      await this.store
        .prepare(
          'SELECT id,code,name,active,policy FROM branches ORDER BY lower(name),id',
        )
        .all()
    ).map((row) => ({
      ...JSON.parse(row.policy as string),
      id: row.id,
      code: row.code,
      name: row.name,
      active: row.active,
    }));
  }
  async save(actor: Actor, input: BranchInput, id?: string) {
    requireAdmin(actor);
    return this.store.transaction(async () => {
      const before = id
        ? await this.store.prepare('SELECT * FROM branches WHERE id=?').get(id)
        : null;
      if (id && !before) throw new NotFoundException('Branch not found');
      if (!input.active && id) {
        const use = await this.store
          .prepare(
            `SELECT 1 FROM employee_branches a WHERE a.branch_id=? AND EXISTS(SELECT 1 FROM employees e WHERE e.id=a.employee_id AND (e.data::jsonb->>'active')='true') AND
      (a.effective_from>=? OR a.effective_from=(SELECT max(b.effective_from) FROM employee_branches b WHERE b.employee_id=a.employee_id AND b.effective_from<=?)) LIMIT 1`,
          )
          .get(id, await this.today(), await this.today());
        const open = await this.store
          .prepare(
            'SELECT 1 FROM attendance WHERE branch_id=? AND check_out IS NULL LIMIT 1',
          )
          .get(id);
        if (use || open)
          throw new ConflictException(
            'Move current/future employees and close open attendance before deactivating this branch',
          );
      }
      const { code, name, active, ...policy } = input;
      const branchId = id ?? randomUUID();
      try {
        await this.store
          .prepare(
            `INSERT INTO branches(id,code,name,active,policy) VALUES(?,?,?,?,?) ON CONFLICT(company_id,id)
      DO UPDATE SET code=excluded.code,name=excluded.name,active=excluded.active,policy=excluded.policy`,
          )
          .run(branchId, code, name, active, JSON.stringify(policy));
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'HR409'
        )
          throw new ConflictException(error.message);
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === '23505'
        )
          throw new ConflictException('Branch code already exists');
        throw error;
      }
      if (
        active &&
        Number(
          (await this.store
            .prepare('SELECT count(*) AS n FROM branches WHERE active')
            .get())!.n,
        ) === 1
      ) {
        const row = await this.store
          .prepare("SELECT value FROM settings WHERE key='company'")
          .get();
        if (row) {
          const { address: _address, ...location } = policy;
          await this.store
            .prepare("UPDATE settings SET value=? WHERE key='company'")
            .run(
              JSON.stringify({
                ...JSON.parse(row.value as string),
                ...location,
              }),
            );
        }
      }
      await this.audit.record(
        actor,
        id ? 'branch.updated' : 'branch.created',
        branchId,
        before
          ? {
              id: before.id,
              code: before.code,
              name: before.name,
              active: before.active,
              ...JSON.parse(before.policy as string),
            }
          : null,
        { id: branchId, ...input },
      );
      return { id: branchId, ...input };
    });
  }
  async hrAccounts(actor: Actor) {
    requireAdmin(actor);
    return this.store
      .prepare(
        "SELECT id,name,email FROM users WHERE role='hr' ORDER BY lower(name),id",
      )
      .all();
  }
  async grants(actor: Actor, userId: string) {
    requireAdmin(actor);
    const user = await this.store
      .prepare("SELECT id FROM users WHERE id=? AND role='hr'")
      .get(userId);
    if (!user) throw new NotFoundException('HR account not found');
    return (
      await this.store
        .prepare(
          'SELECT branch_id FROM hr_branch_grants WHERE user_id=? ORDER BY branch_id',
        )
        .all(userId)
    ).map((row) => row.branch_id as string);
  }
  async setGrants(
    actor: Actor,
    userId: string,
    input: { branchIds: string[]; reason: string },
  ) {
    requireAdmin(actor);
    return this.store.transaction(async () => {
      const before = await this.grants(actor, userId);
      for (const branchId of input.branchIds)
        if (
          !(await this.store
            .prepare('SELECT id FROM branches WHERE id=?')
            .get(branchId))
        )
          throw new BadRequestException('Select branches from this company');
      await this.store
        .prepare('DELETE FROM hr_branch_grants WHERE user_id=?')
        .run(userId);
      for (const branchId of input.branchIds)
        await this.store
          .prepare(
            'INSERT INTO hr_branch_grants(user_id,branch_id) VALUES(?,?)',
          )
          .run(userId, branchId);
      await this.audit.record(
        actor,
        'account.branch_grants.updated',
        userId,
        before,
        input.branchIds,
        input.reason,
      );
      return input.branchIds;
    });
  }
  async history(actor: Actor, employeeId: string) {
    requireHr(actor);
    return (
      await this.store
        .prepare(
          `SELECT a.branch_id,a.effective_from,b.code,b.name FROM employee_branches a JOIN branches b ON b.id=a.branch_id
   WHERE a.employee_id=? ORDER BY a.effective_from`,
        )
        .all(employeeId)
    ).map((row) => ({
      branchId: row.branch_id,
      effectiveFrom: row.effective_from,
      code: row.code,
      name: row.name,
    }));
  }
  async assign(
    actor: Actor,
    employeeId: string,
    input: { branchId: string; effectiveFrom: string; reason: string },
  ) {
    requireAdmin(actor);
    return this.store.transaction(async () => {
      const employee = await this.store
        .prepare('SELECT data FROM employees WHERE id=?')
        .get(employeeId);
      if (!employee) throw new NotFoundException('Employee not found');
      const profile = JSON.parse(employee.data as string) as {
        startDate: string;
      };
      const today = await this.today();
      if (
        input.effectiveFrom < today ||
        input.effectiveFrom < profile.startDate
      )
        throw new BadRequestException(
          'Transfers cannot be backdated or precede employment',
        );
      if (
        !(await this.store
          .prepare('SELECT id FROM branches WHERE id=? AND active')
          .get(input.branchId))
      )
        throw new BadRequestException('Select an active company branch');
      if (
        await this.store
          .prepare(
            'SELECT 1 FROM attendance WHERE employee_id=? AND check_out IS NULL',
          )
          .get(employeeId)
      )
        throw new ConflictException(
          'Close open attendance before a branch transfer',
        );
      if (
        await this.store
          .prepare(
            `SELECT 1 FROM employee_requests WHERE employee_id=? AND status IN ('pending','approved')
     AND (data::jsonb->>'from')<? AND (data::jsonb->>'to')>=? LIMIT 1`,
          )
          .get(employeeId, input.effectiveFrom, input.effectiveFrom)
      )
        throw new ConflictException(
          'Resolve pending or approved requests spanning the transfer date first',
        );
      if (
        await this.store
          .prepare(
            'SELECT 1 FROM employee_branches WHERE employee_id=? AND effective_from>=?',
          )
          .get(employeeId, input.effectiveFrom)
      )
        throw new ConflictException(
          'An assignment already exists on or after this date',
        );
      const before = await this.history(actor, employeeId);
      await this.store
        .prepare(
          `UPDATE employee_branches SET employee_snapshot=? WHERE employee_id=? AND effective_from=(SELECT max(effective_from) FROM employee_branches WHERE employee_id=? AND effective_from<=?)`,
        )
        .run(employee.data, employeeId, employeeId, today);
      await this.store
        .prepare(
          'INSERT INTO employee_branches(employee_id,branch_id,effective_from,employee_snapshot) VALUES(?,?,?,?)',
        )
        .run(employeeId, input.branchId, input.effectiveFrom, employee.data);
      await this.audit.record(
        actor,
        'employee.branch_assigned',
        employeeId,
        before,
        input,
        input.reason,
      );
      return this.history(actor, employeeId);
    });
  }
}
