import { z } from 'zod';
import { text, timeSchema } from '../../common/validation/schemas.js';

export const scheduleSchema = z
  .object({
    name: text,
    start: timeSchema,
    end: timeSchema,
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length),
    graceMinutes: z.number().int().min(0).max(120),
  })
  .strict()
  .refine((s) => s.start !== s.end, 'Start and end must differ');

export type SaveScheduleDto = z.infer<typeof scheduleSchema>;
