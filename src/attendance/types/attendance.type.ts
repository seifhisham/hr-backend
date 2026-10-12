import type { Schedule } from '../../schedules/types/schedule.type.js';
import type { AttendanceLocationService } from '../attendance-location.service.js';

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
  location: ReturnType<AttendanceLocationService['view']>;
  id: string | null;
  employeeId: string;
  nationalId: string;
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
