import type { Schedule } from '../schedules/types/schedule.type.js';
import type { Attendance } from './types/attendance.type.js';

export type AttendanceRow = {
  id: string;
  employee_id: string;
  work_date: string;
  check_in: string;
  check_out: string | null;
  schedule: string;
  timezone: string;
};

export function attendance(row: AttendanceRow): Attendance {
  return {
    id: row.id,
    employeeId: row.employee_id,
    workDate: row.work_date,
    checkIn: row.check_in,
    checkOut: row.check_out,
    schedule: JSON.parse(row.schedule) as Schedule,
    timezone: row.timezone,
  };
}
