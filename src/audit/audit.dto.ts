import { z } from 'zod';
import { dateSchema } from '../common/validation/schemas.js';
export const auditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.uuid().optional(),
    recordId: z.string().trim().min(1).max(120).optional(),
    action: z.string().trim().min(1).max(120).optional(),
    actorId: z.uuid().optional(),
    search: z.string().trim().min(1).max(120).optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
  })
  .strict()
  .refine(
    (v) => !v.from || !v.to || v.from <= v.to,
    'End date must follow start date',
  );
export type AuditQuery = z.infer<typeof auditQuerySchema>;
