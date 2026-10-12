import { z } from 'zod';
import { payrollMonthSchema } from './deduction.dto.js';
export const payrollApprovalSchema = z
  .object({
    month: payrollMonthSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
export type ApprovePayrollDto = z.infer<typeof payrollApprovalSchema>;
