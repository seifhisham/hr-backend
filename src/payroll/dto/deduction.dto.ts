import { z } from 'zod';
import { dateSchema, text } from '../../common/validation/schemas.js';

export const payrollMonthSchema = z
  .string()
  .regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/);
export const deductionSchema = z
  .object({
    employeeId: z.uuid(),
    month: payrollMonthSchema,
    days: z.number().int().min(1).max(365),
    reason: z.string().trim().min(5).max(500),
    approvedBy: text,
  })
  .strict();
export type AddDeductionDto = z.infer<typeof deductionSchema>;
export type PayrollDeduction = AddDeductionDto & {
  id: string;
  recordedAt: string;
  recordedBy: string;
  recordedById: string;
};

export const deductionRangeSchema = z
  .object({ from: dateSchema, to: dateSchema })
  .strict()
  .refine(
    (v) =>
      v.from <= v.to &&
      (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 92,
    'Select an ordered range of at most 93 days',
  );
