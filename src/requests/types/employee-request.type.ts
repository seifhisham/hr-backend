import { z } from 'zod';
import type { Attendance } from '../../attendance/types/attendance.type.js';
import { requestSchema } from '../dto/request.dto.js';

export type EmployeeRequest = z.infer<typeof requestSchema> & {
  id: string;
  employeeId: string;
  employeeName: string;
  nationalId: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  lastChange?: {
    action: 'withdraw' | 'reopen';
    reason: string;
    at: string;
    by: string;
  };
  managerReview?: {
    status: 'approved' | 'rejected';
    employeeId: string;
    department: string;
    reviewedBy: string;
    reviewedAt: string;
    reason: string;
  } | null;
  managerStage?: 'not-required' | 'pending' | 'approved' | 'rejected';
  managerEmployeeId?: string | null;
  managerDepartment?: string;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  salaryDeductionDays: number | null;
  attendance: Attendance | null;
};
