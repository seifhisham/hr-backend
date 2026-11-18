import { arrivalExcuseMinutes } from './arrival-excuses.js';
import type { EmployeeRequest } from '../requests/types/employee-request.type.js';
import type { Schedule } from '../schedules/types/schedule.type.js';
import {
  arrivalStatus,
  attendanceStatus,
  localTime,
  minutesLate,
  workDate,
} from './attendance-time.js';
import type { Attendance } from './types/attendance.type.js';
const schedule: Schedule = {
  id: 'test',
  name: 'Night shift',
  start: '22:00',
  end: '06:00',
  days: [0, 1, 2, 3, 4],
  graceMinutes: 15,
};
const record = (
  checkIn: string,
  checkOut: string | null = null,
): Attendance => ({
  id: 'test',
  employeeId: 'test',
  workDate: '2026-10-04',
  checkIn,
  checkOut,
  schedule,
  timezone: 'UTC',
});
describe('Attendance calendar rules', () => {
  it('keeps cached formatters separate by timezone and follows DST changes', () => {
    expect(localTime(new Date('2026-01-01T22:30:00Z'), 'Africa/Cairo')).toEqual(
      { date: '2026-01-02', minutes: 30 },
    );
    expect(localTime(new Date('2026-07-01T22:30:00Z'), 'Africa/Cairo')).toEqual(
      { date: '2026-07-02', minutes: 90 },
    );
    expect(localTime(new Date('2026-07-01T22:30:00Z'), 'UTC')).toEqual({
      date: '2026-07-01',
      minutes: 1350,
    });
    expect(localTime(new Date('2026-01-01T22:30:00Z'), 'Africa/Cairo')).toEqual(
      { date: '2026-01-02', minutes: 30 },
    );
  });
  it('preserves arrival lateness when the record also has a missing check-out', () => {
    const late = record('2026-10-04T23:00:00Z');
    expect(arrivalStatus(late)).toBe('Late');
    expect(attendanceStatus(late, new Date('2026-10-05T07:00:00Z'))).toBe(
      'Missing check-out',
    );
  });
  it('assigns overnight arrivals to the shift start date', () => {
    expect(workDate(new Date('2026-10-05T02:00:00Z'), schedule, 'UTC')).toBe(
      '2026-10-04',
    );
  });
  it('treats a post-midnight arrival as late against the original shift', () => {
    expect(
      attendanceStatus(
        record('2026-10-05T02:00:00Z', '2026-10-05T05:00:00Z'),
        new Date('2026-10-05T05:00:00Z'),
      ),
    ).toBe('Late');
  });
  it('keeps the interval open until the overnight end time', () => {
    expect(
      attendanceStatus(
        record('2026-10-04T22:00:00Z'),
        new Date('2026-10-05T05:00:00Z'),
      ),
    ).toBe('On time');
    expect(
      attendanceStatus(
        record('2026-10-04T22:00:00Z'),
        new Date('2026-10-05T06:00:00Z'),
      ),
    ).toBe('Missing check-out');
  });
  it('uses the configured timezone and includes the grace boundary', () => {
    expect(
      localTime(new Date('2026-10-04T21:00:00Z'), 'Africa/Cairo').date,
    ).toBe('2026-10-05');
    expect(
      attendanceStatus(
        record('2026-10-04T22:15:00Z'),
        new Date('2026-10-04T23:00:00Z'),
      ),
    ).toBe('On time');
    expect(
      attendanceStatus(
        record('2026-10-04T22:16:00Z'),
        new Date('2026-10-04T23:00:00Z'),
      ),
    ).toBe('Late');
  });
});
describe('minutesLate', () => {
  it('counts minutes past start plus grace, including after midnight', () => {
    expect(minutesLate(record('2026-10-04T22:15:00Z'))).toBe(0);
    expect(minutesLate(record('2026-10-04T22:40:00Z'))).toBe(25);
    expect(minutesLate(record('2026-10-05T00:15:00Z'))).toBe(120);
  });
  it('returns null on unscheduled days', () => {
    expect(
      minutesLate({
        ...record('2026-10-04T22:40:00Z'),
        workDate: '2026-10-09',
      }),
    ).toBeNull();
  });
});
describe('arriving-late excuses', () => {
  it('moves the late threshold by the excused minutes', () => {
    // Shift 22:00 with 15 grace; arrival 22:40 is 25 minutes late.
    expect(minutesLate(record('2026-10-04T22:40:00Z'), 30)).toBe(0);
    expect(arrivalStatus(record('2026-10-04T22:40:00Z'), 30)).toBe('On time');
    expect(minutesLate(record('2026-10-04T22:40:00Z'), 10)).toBe(15);
    expect(arrivalStatus(record('2026-10-04T22:40:00Z'), 10)).toBe('Late');
  });
  it('counts only approved arriving-late excuses on each covered date', () => {
    const base = {
      employeeId: 'e1',
      type: 'excuse',
      excuseType: 'arriving-late',
      from: '2026-10-04',
      to: '2026-10-05',
      durationMinutes: 30,
      status: 'approved',
    };
    const minutes = arrivalExcuseMinutes([
      base,
      { ...base, status: 'pending', durationMinutes: 90 },
      { ...base, excuseType: 'leaving-early', durationMinutes: 45 },
      { ...base, type: 'leave' },
    ] as unknown as EmployeeRequest[]);
    expect([...minutes]).toEqual([
      ['e1:2026-10-04', 30],
      ['e1:2026-10-05', 30],
    ]);
  });
});
