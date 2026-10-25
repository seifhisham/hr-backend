import { z } from 'zod';
import { dateSchema, text } from '../common/validation/schemas.js';
export const branchSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    name: text,
    address: z.string().trim().max(500).default(''),
    active: z.boolean().default(true),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    radiusMeters: z.number().positive().max(10000),
    trackingRadiusMeters: z.number().positive().max(10000),
    trackingGraceMinutes: z.number().int().min(1).max(120),
  })
  .strict();
export const assignmentSchema = z
  .object({
    branchId: z.uuid(),
    effectiveFrom: dateSchema,
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
export const grantsSchema = z
  .object({
    branchIds: z
      .array(z.uuid())
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate branch'),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
export type BranchInput = z.infer<typeof branchSchema>;
