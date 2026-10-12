import { z } from 'zod';
import { dateSchema, text } from '../common/validation/schemas.js';

export const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine(
    (value) => dateSchema.safeParse(`${value}-01`).success,
    'Invalid month',
  );
const money = z
  .number()
  .finite()
  .positive()
  .max(1000000000)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.0001,
    'Use at most two decimal places',
  );
const currency = z.string().regex(/^[A-Z]{3}$/);
const note = z.string().trim().min(5).max(500);
const common = {
  activityDate: dateSchema,
  clientName: text,
  projectName: z.string().trim().max(120).default(''),
  propertyReference: z.string().trim().max(120).default(''),
  notes: z.string().trim().max(1000).default(''),
};
const meeting = z
  .object({
    ...common,
    kind: z.enum(['meeting', 'viewing']),
    purpose: text,
    outcome: text,
    followUpDate: dateSchema.nullable().default(null),
  })
  .strict()
  .refine(
    (value) => value.kind !== 'viewing' || !!value.propertyReference,
    'A viewing needs a property/unit reference',
  )
  .refine(
    (value) => !value.followUpDate || value.followUpDate >= value.activityDate,
    'Follow-up cannot precede the activity',
  );
const deal = z
  .object({
    ...common,
    kind: z.literal('closed-deal'),
    propertyReference: text,
    dealReference: text,
    transactionType: z.enum(['sale', 'lease']),
    value: money,
    currency,
  })
  .strict();
export const activitySchema = z.union([meeting, deal]);
export const createActivitySchema = z
  .object({ id: z.uuid(), activity: activitySchema })
  .strict();
export const updateActivitySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    activity: activitySchema,
  })
  .strict();
export const reviewSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    status: z.enum(['verified', 'returned']),
    reason: note,
  })
  .strict();
export const targetSchema = z
  .object({
    employeeId: z.uuid(),
    month: monthSchema,
    meetings: z.number().int().min(0).max(10000),
    deals: z.number().int().min(0).max(10000),
    transactionValue: money.nullable(),
    currency: currency.nullable(),
    expectedRevision: z.number().int().min(0),
    reason: note,
  })
  .strict()
  .refine(
    (value) => (value.transactionValue === null) === (value.currency === null),
    'Set both transaction value and currency, or neither',
  );
export const filtersSchema = z
  .object({
    month: monthSchema,
    employeeId: z.uuid().optional(),
    department: text.optional(),
    kind: z.enum(['meeting', 'viewing', 'closed-deal']).optional(),
    status: z.enum(['pending', 'verified', 'returned']).optional(),
  })
  .strict();
export type ActivityInput = z.infer<typeof activitySchema>;
export type SalesFilters = z.infer<typeof filtersSchema>;
export type SalesActivity = ActivityInput & {
  id: string;
  employeeId: string;
  submittedAt: string;
  updatedAt: string;
  revision: number;
  status: 'pending' | 'verified' | 'returned';
  review: {
    status: 'verified' | 'returned';
    reason: string;
    by: string;
    byId: string;
    at: string;
  } | null;
};
export type SalesTarget = Omit<
  z.infer<typeof targetSchema>,
  'expectedRevision'
> & {
  revision: number;
  updatedAt: string;
  updatedBy: string;
};
