import { z } from 'zod';
import { dateSchema } from '../../common/validation/schemas.js';

export const requestPageSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.uuid().optional(),
    status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional(),
  })
  .strict();
export type RequestPageDto = z.infer<typeof requestPageSchema>;

const attachments = z
  .array(
    z
      .object({
        name: z.string().trim().min(1).max(200),
        mimeType: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
        content: z
          .string()
          .min(4)
          .max(699052)
          .regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          ),
      })
      .strict()
      .refine(
        (file) => Buffer.from(file.content, 'base64').length <= 512 * 1024,
        'Attachment exceeds 512 KB',
      ),
  )
  .max(3)
  .optional();
const range = (v: { from: string; to: string }) =>
  v.from <= v.to && (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 92;

export const requestSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.enum(['leave', 'holiday', 'sick', 'unpaid', 'urgent', 'mission']),
      from: dateSchema,
      to: dateSchema,
      reason: z.string().trim().min(5).max(500),
      attachments,
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
      type: z.literal('excuse'),
      from: dateSchema,
      to: dateSchema,
      durationMinutes: z.number().int().min(1).max(1440),
      excuseType: z.enum(['leaving-early', 'arriving-late', 'during-shift']),
      shiftId: z.uuid(),
      reason: z.string().trim().max(120).default(''),
      attachments,
    })
    .strict()
    .refine(range, 'Select an ordered range of at most 93 days'),
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

export const requestChangeSchema = z
  .object({ reason: z.string().trim().min(5).max(500) })
  .strict();
