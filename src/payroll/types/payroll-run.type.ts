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
    status: string;
    decidedAt: string | null;
    days: number;
  }[];
  manualDeductions: PayrollDeduction[];
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
