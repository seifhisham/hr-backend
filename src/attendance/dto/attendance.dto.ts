import { z } from 'zod';
import { dateSchema, text } from '../../common/validation/schemas.js';

export const correctionSchema = z
  .object({
    checkIn: z.iso.datetime({ offset: true }),
    checkOut: z.iso.datetime({ offset: true }).nullable(),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

export const manualAttendanceSchema = correctionSchema.extend({
  employeeId: z.uuid(),
  workDate: dateSchema,
});

export const filtersSchema = z
  .object({
    from: dateSchema,
    to: dateSchema,
    employeeId: z.string().uuid().optional(),
    branchId: z.uuid().optional(),
    department: text.optional(),
    status: z
      .enum([
        'On time',
        'Late',
        'Missing check-out',
        'No record',
        'Not scheduled',
        'Approved leave',
        'Approved holiday',
        'Approved sick',
        'Approved unpaid',
        'Approved urgent',
        'Approved mission',
      ])
      .optional(),
  })
  .refine((v) => v.from <= v.to, 'End date must follow start date')
  .refine(
    (v) => (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 92,
    'Select at most 93 days',
  );

export type ManualAttendanceDto = z.infer<typeof manualAttendanceSchema>;
export type AttendanceCorrectionDto = z.infer<typeof correctionSchema>;
export type AttendanceFiltersDto = z.infer<typeof filtersSchema>;
