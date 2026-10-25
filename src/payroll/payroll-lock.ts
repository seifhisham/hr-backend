import { ConflictException } from '@nestjs/common';
import type { QueryDatabase } from '../database/database.service.js';
export async function requireUnlockedPayroll(db: QueryDatabase, month: string) {
  if (
    (await db.prepare('SELECT hr_payroll_locked(?) AS locked').get(month))
      ?.locked
  )
    throw new ConflictException(
      `Payroll for ${month} is approved and locked. Use an unlocked month for adjustments.`,
    );
}
export async function requireUnlockedRequest(
  db: QueryDatabase,
  requestId: string,
) {
  const locked = await db
    .prepare('SELECT hr_request_locked(?) AS month')
    .get(requestId);
  if (locked?.month)
    throw new ConflictException(
      `Request belongs to approved payroll for ${locked.month as string} and cannot be reopened. Use an unlocked month for payroll adjustments.`,
    );
}
