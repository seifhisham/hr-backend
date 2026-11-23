import { describe, expect, it } from 'vitest';
import {
  absenceKey,
  absenceStart,
  calculateAbsences,
  monthDates,
  workdayOver,
  type AbsenceEmployee,
  type AbsenceInput,
  type AbsenceOverride,
  type AbsenceRequest,
} from './absence-deductions.js';
import type { Schedule } from '../schedules/types/schedule.type.js';

// November 2026: the 1st is a Sunday, so Sunday-Thursday workdays are easy to read.
const dayShift = {
  id: 'day',
  name: 'Day',
  start: '09:00',
  end: '17:00',
  graceMinutes: 0,
  days: [0, 1, 2, 3, 4],
} as unknown as Schedule;
const nightShift = { ...dayShift, id: 'night', start: '22:00', end: '06:00' };
const employee: AbsenceEmployee = {
  id: 'e1',
  role: 'employee',
  active: true,
  startDate: '2026-01-01',
  deletedDate: null,
};
const input = (changes: Partial<AbsenceInput> = {}): AbsenceInput => ({
  month: '2026-11',
  rule: {
    enabled: true,
    daysPerAbsence: 1,
    effectiveFrom: null,
    excludedDates: [],
  },
  now: { date: '2026-11-06', minutes: 600 },
  employees: [employee],
  firstCheckIns: new Map([['e1', '2026-11-01']]),
  attended: new Set([absenceKey('e1', '2026-11-01')]),
  requests: [],
  scheduleAt: () => dayShift,
  overrides: new Map(),
  ...changes,
});
const dates = (changes: Partial<AbsenceInput> = {}, id = 'e1') =>
  (calculateAbsences(input(changes)).get(id) ?? []).map(
    (item) => item.workDate,
  );
const on = (date: string, changes: Partial<AbsenceInput> = {}) =>
  calculateAbsences(input(changes))
    .get('e1')
    ?.find((item) => item.workDate === date);
const request = (
  type: string,
  status: string,
  from = '2026-11-03',
  to = from,
): AbsenceRequest => ({ employeeId: 'e1', type, status, from, to });

describe('absence start', () => {
  it('uses first check-in when effectiveFrom is empty', () => {
    expect(absenceStart('2026-11-08', '2026-01-01', null)).toBe('2026-11-08');
  });
  it('never lets an earlier effectiveFrom start before first check-in', () => {
    expect(absenceStart('2026-11-08', '2026-01-01', '2026-10-01')).toBe(
      '2026-11-08',
    );
  });
  it('moves later with a later effectiveFrom', () => {
    expect(absenceStart('2026-11-08', '2026-01-01', '2026-11-15')).toBe(
      '2026-11-15',
    );
  });
  it('uses a start date later than first check-in', () => {
    expect(absenceStart('2026-11-08', '2026-11-10', null)).toBe('2026-11-10');
  });
  it('has no start without attendance, whatever effectiveFrom says', () => {
    expect(absenceStart(undefined, '2026-01-01', '2026-11-01')).toBeNull();
  });
});

describe('absence calculation', () => {
  it('counts only past scheduled workdays after the first check-in', () => {
    // The 1st attended, 6th-7th Friday/Saturday, and "today" is the 6th.
    expect(dates()).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
    ]);
  });
  it('never charges the first check-in day', () => {
    expect(dates()).not.toContain('2026-11-01');
  });
  it('continues from a first check-in in an earlier month', () => {
    expect(
      dates({
        firstCheckIns: new Map([['e1', '2026-09-10']]),
        attended: new Set(),
      })[0],
    ).toBe('2026-11-01');
  });
  it('respects effectiveFrom and a later start date', () => {
    expect(
      dates({
        rule: { ...input().rule, effectiveFrom: '2026-11-04' },
      }),
    ).toEqual(['2026-11-04', '2026-11-05']);
    expect(
      dates({ employees: [{ ...employee, startDate: '2026-11-05' }] }),
    ).toEqual(['2026-11-05']);
  });
  it('gives an employee who never checked in no absences', () => {
    expect(
      dates({
        firstCheckIns: new Map(),
        attended: new Set(),
        rule: { ...input().rule, effectiveFrom: '2026-11-01' },
      }),
    ).toEqual([]);
  });
  it('moves the start when an earlier attendance record appears', () => {
    const later = {
      firstCheckIns: new Map([['e1', '2026-11-04']]),
      attended: new Set([absenceKey('e1', '2026-11-04')]),
    };
    expect(dates(later)).toEqual(['2026-11-05']);
    expect(
      dates({
        firstCheckIns: new Map([['e1', '2026-11-02']]),
        attended: new Set([
          absenceKey('e1', '2026-11-02'),
          absenceKey('e1', '2026-11-04'),
        ]),
      }),
    ).toEqual(['2026-11-03', '2026-11-05']);
  });
  it('stops before the deletion date', () => {
    expect(
      dates({ employees: [{ ...employee, deletedDate: '2026-11-04' }] }),
    ).toEqual(['2026-11-02', '2026-11-03']);
  });
  it('exempts inactive and admin accounts', () => {
    expect(dates({ employees: [{ ...employee, active: false }] })).toEqual([]);
    expect(dates({ employees: [{ ...employee, role: 'admin' }] })).toEqual([]);
  });
  it('uses the schedule assigned on each date', () => {
    const changed = {
      ...dayShift,
      id: 'changed',
      days: [3], // Wednesday only from the 3rd.
    };
    expect(
      dates({
        scheduleAt: (_id, date) => (date >= '2026-11-03' ? changed : dayShift),
      }),
    ).toEqual(['2026-11-02', '2026-11-04']);
  });
  it('skips non-working days and days without a schedule', () => {
    expect(
      dates({ now: { date: '2026-11-09', minutes: 600 } }),
    ).not.toContain('2026-11-07');
    expect(dates({ scheduleAt: () => null })).toEqual([]);
  });
  it('skips excluded dates', () => {
    expect(
      dates({
        rule: { ...input().rule, excludedDates: ['2026-11-03'] },
      }),
    ).toEqual(['2026-11-02', '2026-11-04', '2026-11-05']);
  });
  it('does not charge today even after the shift ended', () => {
    expect(
      dates({ now: { date: '2026-11-05', minutes: 1400 } }),
    ).not.toContain('2026-11-05');
  });
  it('waits for an overnight shift to finish', () => {
    expect(
      workdayOver('2026-11-04', nightShift, {
        date: '2026-11-05',
        minutes: 359,
      }),
    ).toBe(false);
    expect(
      workdayOver('2026-11-04', nightShift, {
        date: '2026-11-05',
        minutes: 360,
      }),
    ).toBe(true);
    expect(
      workdayOver('2026-11-05', nightShift, {
        date: '2026-11-05',
        minutes: 1430,
      }),
    ).toBe(false);
  });
  it('does not count a day with attendance', () => {
    expect(
      dates({
        attended: new Set([
          absenceKey('e1', '2026-11-01'),
          absenceKey('e1', '2026-11-03'),
        ]),
      }),
    ).not.toContain('2026-11-03');
  });
  it('handles month boundaries, including February', () => {
    expect(monthDates('2026-02').at(-1)).toBe('2026-02-28');
    expect(monthDates('2028-02').at(-1)).toBe('2028-02-29');
    const october = dates({
      month: '2026-10',
      firstCheckIns: new Map([['e1', '2026-10-29']]),
      attended: new Set([absenceKey('e1', '2026-10-29')]),
      now: { date: '2026-11-06', minutes: 600 },
    });
    expect(october).toEqual([]); // The 30th and 31st are Friday and Saturday.
    expect(
      dates({
        month: '2026-12',
        now: { date: '2026-11-06', minutes: 600 },
      }),
    ).toEqual([]);
  });
});

describe('requests on an absent date', () => {
  it.each(['leave', 'holiday', 'sick', 'unpaid', 'urgent', 'mission'])(
    'leaves an approved %s request to its own rule',
    (type) => {
      expect(
        on('2026-11-03', { requests: [request(type, 'approved')] }),
      ).toBeUndefined();
    },
  );
  it('covers each day of a multi-day approved request', () => {
    expect(
      dates({
        requests: [request('leave', 'approved', '2026-11-02', '2026-11-04')],
      }),
    ).toEqual(['2026-11-05']);
  });
  it('holds a pending request at 0 days', () => {
    expect(
      on('2026-11-03', { requests: [request('sick', 'pending')] }),
    ).toMatchObject({
      status: 'held',
      cause: 'pending-request',
      requestType: 'sick',
      days: 0,
    });
  });
  it('shows a rejected request as covered, so it is not charged twice', () => {
    expect(
      on('2026-11-03', { requests: [request('leave', 'rejected')] }),
    ).toMatchObject({ status: 'covered', cause: 'rejected-request', days: 0 });
  });
  it('holds an approved excuse at 0 days', () => {
    expect(
      on('2026-11-03', { requests: [request('excuse', 'approved')] }),
    ).toMatchObject({ status: 'held', cause: 'approved-excuse', days: 0 });
  });
  it('does not let a forgotten check-out cover a day', () => {
    expect(
      on('2026-11-03', {
        requests: [request('forgotten-check-out', 'approved')],
      }),
    ).toMatchObject({ status: 'absent', days: 1 });
  });
  it('ignores withdrawn requests', () => {
    expect(
      on('2026-11-03', { requests: [request('leave', 'withdrawn')] }),
    ).toMatchObject({ status: 'absent', days: 1 });
  });
  it('prefers an approved full-day request over any other request', () => {
    expect(
      on('2026-11-03', {
        requests: [
          request('leave', 'rejected'),
          request('sick', 'approved'),
        ],
      }),
    ).toBeUndefined();
  });
});

describe('absence overrides', () => {
  const override = (
    days: number,
    cause: AbsenceOverride['cause'] = 'no-record',
  ): Map<string, AbsenceOverride> =>
    new Map([
      [
        absenceKey('e1', '2026-11-03'),
        {
          employeeId: 'e1',
          month: '2026-11',
          workDate: '2026-11-03',
          cause,
          days,
          adjustment: {
            originalDays: 1,
            reason: 'Reviewed with manager',
            by: 'HR',
            byId: 'hr',
            at: '2026-11-05T10:00:00.000Z',
          },
        },
      ],
    ]);
  it('applies an edit or removal to a date that is still an absence', () => {
    expect(on('2026-11-03', { overrides: override(0.5) })).toMatchObject({
      automaticDays: 1,
      days: 0.5,
      adjustment: { originalDays: 1 },
    });
    expect(on('2026-11-03', { overrides: override(0) })?.days).toBe(0);
  });
  it('drops an override once the date is covered by a request', () => {
    for (const status of ['pending', 'rejected']) {
      expect(
        on('2026-11-03', {
          overrides: override(2),
          requests: [request('sick', status)],
        }),
      ).toMatchObject({ days: 0, adjustment: null });
    }
    expect(
      on('2026-11-03', {
        overrides: override(2),
        requests: [request('excuse', 'approved')],
      }),
    ).toMatchObject({ days: 0, adjustment: null });
  });
  it('keeps an override HR made on a held excuse', () => {
    expect(
      on('2026-11-03', {
        overrides: override(0.25, 'approved-excuse'),
        requests: [request('excuse', 'approved')],
      }),
    ).toMatchObject({ status: 'held', days: 0.25 });
  });
});
