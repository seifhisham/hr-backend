import { minutes, shiftDate, weekday } from '../attendance/attendance-time.js';
import type { AbsenceRule } from '../deduction-policy/deduction-policy.js';
import type { Schedule } from '../schedules/types/schedule.type.js';
import type {
  AbsenceDeduction,
  DeductionAdjustment,
} from './types/payroll-run.type.js';

export type AbsenceEmployee = {
  id: string;
  role: string;
  active: boolean;
  startDate: string;
  /** Company-local deletion date; the employee is not counted from this date. */
  deletedDate: string | null;
};
export type AbsenceRequest = {
  employeeId: string;
  type: string;
  status: string;
  from: string;
  to: string;
};
export type AbsenceOverride = {
  employeeId: string;
  month: string;
  workDate: string;
  /** An override only applies while the day still has the cause HR reviewed. */
  cause: AbsenceDeduction['cause'];
  days: number;
  adjustment: DeductionAdjustment;
};
export type AbsenceInput = {
  month: string;
  rule: AbsenceRule;
  now: { date: string; minutes: number };
  employees: AbsenceEmployee[];
  firstCheckIns: Map<string, string>;
  /** `employeeId:workDate` for every attendance record in the month. */
  attended: Set<string>;
  requests: AbsenceRequest[];
  scheduleAt: (employeeId: string, date: string) => Schedule | null;
  /** Keyed by `employeeId:workDate`. */
  overrides: Map<string, AbsenceOverride>;
};

export const absenceKey = (employeeId: string, workDate: string) =>
  `${employeeId}:${workDate}`;

/** Pending requests await their decision; rejected ones already carry a deduction. */
export const absenceEditable = (cause: AbsenceDeduction['cause']) =>
  cause === 'no-record' || cause === 'approved-excuse';

export function monthDates(month: string) {
  const [year, number] = month.split('-').map(Number);
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from(
    { length: count },
    (_, day) => `${month}-${String(day + 1).padStart(2, '0')}`,
  );
}

/** The latest of first check-in, start date and effectiveFrom; null without attendance. */
export function absenceStart(
  firstCheckIn: string | undefined,
  startDate: string,
  effectiveFrom: string | null,
) {
  if (!firstCheckIn) return null;
  return [firstCheckIn, startDate.slice(0, 10), effectiveFrom ?? ''].reduce(
    (latest, date) => (date > latest ? date : latest),
  );
}

/** Today is never charged; an overnight shift counts until it ends the next morning. */
export function workdayOver(
  date: string,
  schedule: Pick<Schedule, 'start' | 'end'>,
  now: AbsenceInput['now'],
) {
  if (date >= now.date) return false;
  const overnight = minutes(schedule.end) < minutes(schedule.start);
  return !(
    overnight &&
    shiftDate(date, 1) === now.date &&
    now.minutes < minutes(schedule.end)
  );
}

const fullDayTypes = new Set([
  'leave',
  'holiday',
  'sick',
  'unpaid',
  'urgent',
  'mission',
]);

/**
 * How requests treat a date. `skip` means an approved full-day request already
 * follows its own rule. Precedence avoids charging one day through two routes.
 */
function requestOutcome(requests: AbsenceRequest[], date: string) {
  const onDate = requests.filter(
    (request) =>
      request.type !== 'forgotten-check-out' &&
      request.from <= date &&
      request.to >= date,
  );
  if (
    onDate.some(
      (request) =>
        request.status === 'approved' && fullDayTypes.has(request.type),
    )
  )
    return 'skip' as const;
  const pick = (status: string, cause: AbsenceDeduction['cause']) => {
    const request = onDate.find((item) => item.status === status);
    return request ? { cause, requestType: request.type } : null;
  };
  return (
    pick('rejected', 'rejected-request') ??
    pick('pending', 'pending-request') ??
    pick('approved', 'approved-excuse')
  );
}

/** Pure month calculation over data loaded once by the payroll service. */
export function calculateAbsences(input: AbsenceInput) {
  const result = new Map<string, AbsenceDeduction[]>();
  const excluded = new Set(input.rule.excludedDates);
  const dates = monthDates(input.month);
  const requests = new Map<string, AbsenceRequest[]>();
  for (const request of input.requests) {
    const list = requests.get(request.employeeId) ?? [];
    list.push(request);
    requests.set(request.employeeId, list);
  }
  for (const employee of input.employees) {
    if (!employee.active || employee.role === 'admin') continue;
    const start = absenceStart(
      input.firstCheckIns.get(employee.id),
      employee.startDate,
      input.rule.effectiveFrom,
    );
    if (!start) continue;
    const items: AbsenceDeduction[] = [];
    for (const date of dates) {
      if (
        date < start ||
        (employee.deletedDate && date >= employee.deletedDate) ||
        excluded.has(date) ||
        input.attended.has(absenceKey(employee.id, date))
      )
        continue;
      const schedule = input.scheduleAt(employee.id, date);
      if (
        !schedule?.days.includes(weekday(date)) ||
        !workdayOver(date, schedule, input.now)
      )
        continue;
      const outcome = requestOutcome(requests.get(employee.id) ?? [], date);
      if (outcome === 'skip') continue;
      const cause = outcome?.cause ?? 'no-record';
      const automaticDays =
        cause === 'no-record' ? input.rule.daysPerAbsence : 0;
      const stored = input.overrides.get(absenceKey(employee.id, date));
      const override =
        stored?.cause === cause && absenceEditable(cause) ? stored : null;
      items.push({
        workDate: date,
        status:
          cause === 'no-record'
            ? 'absent'
            : cause === 'rejected-request'
              ? 'covered'
              : 'held',
        cause,
        requestType: outcome?.requestType ?? null,
        automaticDays,
        days: override?.days ?? automaticDays,
        adjustment: override?.adjustment ?? null,
      });
    }
    if (items.length) result.set(employee.id, items);
  }
  return result;
}
