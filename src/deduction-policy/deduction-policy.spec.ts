import { describe, expect, it } from 'vitest';
import {
  defaultDeductionPolicy,
  deductionPolicySchema,
  lateArrivalDays,
} from './deduction-policy.js';

const { updatedAt: _a, updatedBy: _b, ...rules } = defaultDeductionPolicy;

describe('deduction policy', () => {
  it('defaults to the previous request rules, free approved excuses and no late deductions', () => {
    expect(deductionPolicySchema.parse(rules)).toEqual(rules);
    expect(rules.requests.sick).toEqual({ approved: 1, rejected: 3 });
    expect(rules.requests.mission.approved).toBe(0);
    expect(rules.requests.excuse).toEqual({ approved: 0, rejected: 3 });
    expect(rules.lateArrival.enabled).toBe(false);
  });

  it('picks the highest lateness tier reached', () => {
    const late = {
      ...rules.lateArrival,
      tiers: [
        { fromMinutes: 60, days: 0.5 },
        { fromMinutes: 1, days: 0.25 },
        { fromMinutes: 120, days: 1 },
      ],
    };
    expect(lateArrivalDays(late, 0)).toBe(0);
    expect(lateArrivalDays(late, 1)).toBe(0.25);
    expect(lateArrivalDays(late, 59)).toBe(0.25);
    expect(lateArrivalDays(late, 60)).toBe(0.5);
    expect(lateArrivalDays(late, 300)).toBe(1);
  });

  it('rejects invalid rules', () => {
    const bad = (patch: object) =>
      deductionPolicySchema.safeParse({ ...rules, ...patch }).success;
    expect(
      bad({
        requests: { ...rules.requests, sick: { approved: 0.3, rejected: 3 } },
      }),
    ).toBe(false);
    expect(
      bad({
        requests: { ...rules.requests, sick: { approved: -1, rejected: 3 } },
      }),
    ).toBe(false);
    expect(
      bad({ lateArrival: { ...rules.lateArrival, enabled: true, tiers: [] } }),
    ).toBe(false);
    expect(
      bad({
        lateArrival: {
          ...rules.lateArrival,
          tiers: [
            { fromMinutes: 5, days: 1 },
            { fromMinutes: 5, days: 2 },
          ],
        },
      }),
    ).toBe(false);
    expect(
      bad({
        requests: {
          ...rules.requests,
          sick: { approved: 0.75, rejected: 2.5 },
        },
      }),
    ).toBe(true);
  });
});
