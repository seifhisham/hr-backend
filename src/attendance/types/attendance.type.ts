import type { Schedule } from '../../schedules/types/schedule.type.js';

export type Attendance = {
  id: string;
  employeeId: string;
  workDate: string;
  checkIn: string;
  checkOut: string | null;
  schedule: Schedule;
  timezone: string;
};

export type ReportRow = {
  id: string | null;
  employeeId: string;
  employeeCode: string;
  name: string;
  department: string;
  workDate: string;
  checkIn: string | null;
  checkOut: string | null;
  status: string;
  late: boolean;
  hours: number | null;
  timezone: string;
};
