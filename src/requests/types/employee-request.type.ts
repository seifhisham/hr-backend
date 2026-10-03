import { z } from 'zod';
import type { Attendance } from '../../attendance/types/attendance.type.js';
import { requestSchema } from '../dto/request.dto.js';

export type EmployeeRequest = z.infer<typeof requestSchema> & {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  status: 'pending' | 'approved' | 'rejected';
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  attendance: Attendance | null;
};
