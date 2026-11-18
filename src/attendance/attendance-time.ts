import type { Schedule } from '../schedules/types/schedule.type.js';
import type { Attendance } from './types/attendance.type.js';

const formatters = new Map<string, Intl.DateTimeFormat>();

export function localTime(now: Date, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

export function minutes(time: string) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function shiftDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}

export function weekday(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function workDate(now: Date, schedule: Schedule, timezone: string) {
  const local = localTime(now, timezone);
  return minutes(schedule.end) < minutes(schedule.start) &&
    local.minutes < minutes(schedule.end)
    ? shiftDate(local.date, -1)
    : local.date;
}

/** `excusedMinutes`: approved arriving-late excuse for this work date. */
export function attendanceStatus(
  record: Attendance,
  now: Date,
  excusedMinutes = 0,
) {
  if (!record.checkOut) {
    const current = localTime(now, record.timezone);
    const endDate =
      minutes(record.schedule.end) < minutes(record.schedule.start)
        ? shiftDate(record.workDate, 1)
        : record.workDate;
    if (
      current.date > endDate ||
      (current.date === endDate &&
        current.minutes >= minutes(record.schedule.end))
    )
      return 'Missing check-out';
  }
  return arrivalStatus(record, excusedMinutes);
}

export function arrivalStatus(record: Attendance, excusedMinutes = 0) {
  const late = minutesLate(record, excusedMinutes);
  return late === null ? 'Not scheduled' : late > 0 ? 'Late' : 'On time';
}

/**
 * Minutes past the shift start plus grace and any approved arriving-late
 * excuse; null when the day is unscheduled.
 */
export function minutesLate(record: Attendance, excusedMinutes = 0) {
  const local = localTime(new Date(record.checkIn), record.timezone);
  if (!record.schedule.days.includes(weekday(record.workDate))) return null;
  const elapsed =
    local.date === record.workDate
      ? local.minutes
      : ((Date.parse(`${local.date}T00:00:00Z`) -
          Date.parse(`${record.workDate}T00:00:00Z`)) /
          86400000) *
          1440 +
        local.minutes;
  return Math.max(
    0,
    elapsed -
      (minutes(record.schedule.start) +
        record.schedule.graceMinutes +
        excusedMinutes),
  );
}
