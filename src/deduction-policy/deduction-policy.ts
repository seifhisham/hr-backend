import { z } from 'zod';

// Salary days are configured in quarter-day steps so payroll sums stay exact.
const days = z.number().min(0).max(30).multipleOf(0.25);
const decision = z.object({ approved: days, rejected: days }).strict();

export const requestRuleTypes = [
  'leave',
  'holiday',
  'sick',
  'unpaid',
  'urgent',
  'mission',
  'excuse',
  'forgotten-check-out',
] as const;
export type RequestRuleType = (typeof requestRuleTypes)[number];

export const deductionPolicySchema = z
  .object({
    requests: z
      .object(
        Object.fromEntries(
          requestRuleTypes.map((type) => [type, decision]),
        ) as {
          [K in RequestRuleType]: typeof decision;
        },
      )
      .strict(),
    lateArrival: z
      .object({
        enabled: z.boolean(),
        freeLatesPerMonth: z.number().int().min(0).max(31),
        exemptApprovedRequests: z.boolean(),
        tiers: z
          .array(
            z
              .object({
                fromMinutes: z.number().int().min(1).max(1440),
                days,
              })
              .strict(),
          )
          .max(10)
          .refine(
            (tiers) =>
              new Set(tiers.map((tier) => tier.fromMinutes)).size ===
              tiers.length,
            'Each lateness tier needs a different starting minute',
          ),
      })
      .strict()
      .refine(
        (late) => !late.enabled || late.tiers.length > 0,
        'Add at least one lateness tier or turn late-arrival deductions off',
      ),
  })
  .strict();
export type DeductionPolicyRules = z.infer<typeof deductionPolicySchema>;

export const updateDeductionPolicySchema = z
  .object({
    rules: deductionPolicySchema,
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
export type UpdateDeductionPolicyDto = z.infer<
  typeof updateDeductionPolicySchema
>;

export type DeductionPolicy = DeductionPolicyRules & {
  updatedAt: string | null;
  updatedBy: string | null;
};

// Matches the behaviour that was previously hardcoded, so existing companies
// see no change until HR or an administrator edits the rules.
export const defaultDeductionPolicy: DeductionPolicy = {
  requests: {
    leave: { approved: 1, rejected: 3 },
    holiday: { approved: 1, rejected: 3 },
    sick: { approved: 1, rejected: 3 },
    unpaid: { approved: 1, rejected: 3 },
    urgent: { approved: 1, rejected: 3 },
    mission: { approved: 0, rejected: 3 },
    // An approved excuse is permission to arrive late or leave early, so it costs nothing by default.
    excuse: { approved: 0, rejected: 3 },
    'forgotten-check-out': { approved: 0, rejected: 0 },
  },
  lateArrival: {
    enabled: false,
    freeLatesPerMonth: 0,
    exemptApprovedRequests: true,
    tiers: [
      { fromMinutes: 1, days: 0.25 },
      { fromMinutes: 60, days: 0.5 },
    ],
  },
  updatedAt: null,
  updatedBy: null,
};

/** Days for the tier with the highest starting minute the lateness reaches. */
export function lateArrivalDays(
  policy: DeductionPolicyRules['lateArrival'],
  minutesLate: number,
) {
  let result = 0;
  let reached = 0;
  for (const tier of policy.tiers)
    if (minutesLate >= tier.fromMinutes && tier.fromMinutes >= reached) {
      reached = tier.fromMinutes;
      result = tier.days;
    }
  return result;
}
