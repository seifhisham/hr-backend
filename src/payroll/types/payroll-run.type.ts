import type { PayrollDeduction } from '../dto/deduction.dto.js';
export type PayrollRow = {
  employeeId: string;
  employeeNumber: string;
  name: string;
  department: string;
  active: boolean;
  month: string;
  currency: string;
  grossSalary: number | null;
  dailyRate: number | null;
  deductionDays: number;
  deductionAmount: number | null;
  netSalary: number | null;
  deductions: {
    requestId: string;
    /** Absent from payroll approved before deduction adjustments existed. */
    type?: string;
    status: string;
    decidedAt: string | null;
    days: number;
    adjustment?: DeductionAdjustment | null;
  }[];
  manualDeductions: PayrollDeduction[];
  /** Absent from payroll approved before late-arrival rules existed. */
  lateDeductions?: LateDeduction[];
};
/** A logged HR/admin change to an automatically applied deduction. */
export type DeductionAdjustment = {
  originalDays: number;
  reason: string;
  by: string;
  byId: string;
  at: string;
};
export type LateDeduction = {
  attendanceId: string;
  workDate: string;
  minutesLate: number;
  /** Days the rules calculate; `days` differs only after an adjustment. */
  automaticDays?: number;
  days: number;
  exemption: 'free-allowance' | 'approved-request' | null;
  adjustment?: DeductionAdjustment | null;
};
/** One automatically applied deduction, as listed for HR review. */
export type AutomaticDeduction = {
  source: 'request' | 'late';
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  department: string;
  date: string | null;
  detail: string;
  automaticDays: number;
  days: number;
  adjustment: DeductionAdjustment | null;
  locked: boolean;
};
export type PayrollRun = {
  month: string;
  status: 'draft' | 'approved';
  company: string;
  timezone: string;
  revision: string;
  approvedAt: string | null;
  approvedBy: string | null;
  approvedById: string | null;
  approvalReason: string | null;
  rows: PayrollRow[];
};
