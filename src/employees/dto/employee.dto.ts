import { z } from 'zod';
import {
  dateSchema,
  passwordSchema,
  text,
} from '../../common/validation/schemas.js';

export const employeeSchema = z
  .object({
    employeeCode: text,
    name: text,
    email: z.email().trim().toLowerCase().max(254),
    department: text,
    jobTitle: text,
    startDate: dateSchema,
    scheduleId: z.string().uuid(),
    active: z.boolean(),
    role: z.enum(['employee', 'hr', 'admin']),
    password: passwordSchema.optional(),
  })
  .strict();

export type SaveEmployeeDto = z.infer<typeof employeeSchema>;
