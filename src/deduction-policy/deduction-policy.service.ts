import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { requireHr } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import { DatabaseService } from '../database/database.service.js';
import {
  defaultDeductionPolicy,
  type DeductionPolicy,
  type UpdateDeductionPolicyDto,
} from './deduction-policy.js';

const key = 'deduction-policy';

@Injectable()
export class DeductionPolicyService {
  constructor(
    @Inject(DatabaseService)
    private readonly store: DatabaseService,
    @Inject(AuditService)
    private readonly auditService: AuditService,
  ) {}

  /** Company-wide rules; callers enforce their own access checks. */
  async current(): Promise<DeductionPolicy> {
    const row = await this.store.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key);
    if (!row) return defaultDeductionPolicy;
    const saved = JSON.parse(row.value as string) as Partial<DeductionPolicy>;
    return {
      ...defaultDeductionPolicy,
      ...saved,
      requests: { ...defaultDeductionPolicy.requests, ...saved.requests },
      lateArrival: {
        ...defaultDeductionPolicy.lateArrival,
        ...saved.lateArrival,
      },
      absence: { ...defaultDeductionPolicy.absence, ...saved.absence },
    };
  }

  async view(actor: Actor) {
    requireHr(actor);
    return await this.current();
  }

  async update(actor: Actor, input: UpdateDeductionPolicyDto) {
    requireHr(actor);
    return await this.store.transaction(async () => {
      const before = await this.current();
      // Clients that predate the absence rule omit it; keep what is saved.
      const absence = input.rules.absence ?? before.absence;
      const after: DeductionPolicy = {
        ...input.rules,
        absence: {
          ...absence,
          excludedDates: [...new Set(absence.excludedDates)].sort(),
        },
        lateArrival: {
          ...input.rules.lateArrival,
          tiers: [...input.rules.lateArrival.tiers].sort(
            (a, b) => a.fromMinutes - b.fromMinutes,
          ),
        },
        updatedAt: new Date().toISOString(),
        updatedBy: actor.name,
      };
      await this.store
        .prepare(
          'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(company_id,key) DO UPDATE SET value=excluded.value',
        )
        .run(key, JSON.stringify(after));
      await this.auditService.record(
        actor,
        'deduction_policy.updated',
        key,
        before,
        after,
        input.reason,
      );
      return after;
    });
  }
}
