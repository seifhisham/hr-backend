import { z } from 'zod';
import {
  dateSchema,
  passwordSchema,
  text,
} from '../../common/validation/schemas.js';

export const employeeSchema = z
  .object({
    nationalId: text,
    name: text,
    email: z.email().trim().toLowerCase().max(254),
    department: text,
    jobTitle: text,
    startDate: dateSchema,
    scheduleId: z.string().uuid(),
    scheduleEffectiveFrom: dateSchema.optional(),
    active: z.boolean(),
    salesEnabled: z.boolean().optional(),
    role: z.enum(['employee', 'manager', 'hr', 'admin']),
    managerId: z.uuid().nullable().optional(),
    monthlySalary: z
      .number()
      .finite()
      .min(0)
      .max(1000000000)
      .refine(
        (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.0001,
        'Salary must have at most two decimal places',
      )
      .nullable()
      .optional(),
    salaryCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    password: passwordSchema.optional(),
  })
  .strict();

export type SaveEmployeeDto = z.infer<typeof employeeSchema>;
