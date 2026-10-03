import { z } from 'zod';
import { dateSchema } from '../../common/validation/schemas.js';

export const requestSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.enum(['leave', 'holiday']),
      from: dateSchema,
      to: dateSchema,
      reason: z.string().trim().min(5).max(500),
    })
    .strict()
    .refine(
      (v) =>
        v.from <= v.to &&
        (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 92,
      'Select an ordered range of at most 93 days',
    ),
  z
    .object({
      type: z.literal('forgotten-check-out'),
      attendanceId: z.uuid(),
      proposedCheckOut: z.iso.datetime({ offset: true }),
      reason: z.string().trim().min(5).max(500),
    })
    .strict(),
]);

export const decisionSchema = z
  .object({
    status: z.enum(['approved', 'rejected']),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

export type SubmitRequestDto = z.infer<typeof requestSchema>;
export type RequestDecisionDto = z.infer<typeof decisionSchema>;
