import { ConflictException } from '@nestjs/common';
import type { DatabaseSync } from 'node:sqlite';

export function requireUnlockedPayroll(db: DatabaseSync, month: string) {
  if (db.prepare('SELECT month FROM payroll_runs WHERE month = ?').get(month))
    throw new ConflictException(
      `Payroll for ${month} is approved and locked. Use an unlocked month for adjustments.`,
    );
}

export function requireUnlockedRequest(db: DatabaseSync, requestId: string) {
  const locked = db
    .prepare(
      `SELECT p.month FROM payroll_runs p,
    json_each(p.data, '$.rows') r, json_each(r.value, '$.deductions') d
    WHERE json_extract(d.value, '$.requestId') = ? LIMIT 1`,
    )
    .get(requestId);
  if (locked)
    throw new ConflictException(
      `Request belongs to approved payroll for ${locked.month as string} and cannot be reopened. Use an unlocked month for payroll adjustments.`,
    );
}
