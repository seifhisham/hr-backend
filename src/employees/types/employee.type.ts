import { z } from 'zod';
import { employeeSchema } from '../dto/employee.dto.js';

export type Employee = Omit<
  z.infer<typeof employeeSchema>,
  'password' | 'scheduleEffectiveFrom'
> & {
  id: string;
  employeeNumber: string;
  monthlySalary: number | null;
  salaryCurrency: string;
  salesEnabled: boolean;
};
